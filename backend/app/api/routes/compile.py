import asyncio
import hashlib
import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.core.hooks import get_current_user_id, record_compile
from app.services.arduino_cli import ArduinoCLIService
from app.services.espidf_compiler import espidf_compiler

logger = logging.getLogger(__name__)

router = APIRouter()
arduino_cli = ArduinoCLIService()

# ── Async compile job registry ───────────────────────────────────────────────
# In-process job dict for /compile/start + /compile/status/{job_id}. Cold ESP-IDF
# builds can take 5-7 minutes — far longer than Cloudflare's 100s edge timeout
# that hits any single HTTP request. The async path lets the client poll a
# short-lived status endpoint instead of holding one long-lived POST open.
#
# Single-instance only: if velxio ever scales to multiple FastAPI workers, this
# needs to move to Redis or the sqlite database. For now one process is fine.
COMPILE_JOBS: dict[str, dict[str, Any]] = {}
JOB_BY_KEY: dict[str, str] = {}  # content_hash → job_id, for deduplication
JOB_TTL_S = 1800  # purge results 30 min after completion

# ── Concurrency control ──────────────────────────────────────────────────────
# Cap simultaneous ESP-IDF compiles. The VPS is modest (saw load avg 30 with
# 6 ninja processes peeling each other apart). Two parallel compiles to
# different targets are fine; concurrent compiles to the SAME target would
# corrupt the persistent build dir, so we serialize those with a per-target
# lock layered on top.
_COMPILE_SEMAPHORE = asyncio.Semaphore(2)
_TARGET_LOCKS: dict[str, asyncio.Lock] = {}


def _target_lock(board_fqbn: str) -> asyncio.Lock:
    """Lazy-initialised per-target lock so concurrent compiles to the same
    board serialise. Different boards still run in parallel up to the
    semaphore cap."""
    lock = _TARGET_LOCKS.get(board_fqbn)
    if lock is None:
        lock = asyncio.Lock()
        _TARGET_LOCKS[board_fqbn] = lock
    return lock


def _job_key(
    files: list[dict[str, str]],
    board_fqbn: str,
    board_options: dict | None = None,
    spiffs_files: list[dict] | None = None,
) -> str:
    """Stable content hash of (files, board, options, spiffs) used as the
    deduplication key.

    Excludes project_id (analytics-only — different projects with identical
    code should still dedup to one build). File order is normalised so the
    same set of files in any order produces the same key. Board options
    and SPIFFS files are included so a partition / scheme / file change
    queues a fresh build rather than serving the previous cached job.
    """
    h = hashlib.sha256()
    h.update(board_fqbn.encode())
    h.update(b"\0")
    for f in sorted(files, key=lambda x: x["name"]):
        h.update(f["name"].encode())
        h.update(b"\0")
        h.update(f["content"].encode())
        h.update(b"\0")
    if board_options:
        # Sort keys so option-order doesn't perturb the hash.
        import json
        h.update(json.dumps(board_options, sort_keys=True).encode())
        h.update(b"\0")
    if spiffs_files:
        for f in sorted(spiffs_files, key=lambda x: x["name"]):
            h.update(f["name"].encode())
            h.update(b"\0")
            h.update(f["content_b64"].encode())
            h.update(b"\0")
    return h.hexdigest()


def _purge_expired_jobs() -> None:
    """Drop completed jobs older than JOB_TTL_S so the dict doesn't grow
    forever. Also evicts the matching JOB_BY_KEY entry so the next request
    with the same content schedules a fresh build instead of dedupping to
    a stale job_id."""
    now = time.time()
    stale = [
        jid for jid, job in COMPILE_JOBS.items()
        if job.get("state") in ("done", "error")
        and now - job.get("finished_at", now) > JOB_TTL_S
    ]
    for jid in stale:
        job = COMPILE_JOBS.pop(jid, None)
        if job is not None:
            key = job.get("key")
            # Only remove the JOB_BY_KEY entry if it still points at this job —
            # a newer job with the same key may have replaced it after this one
            # finished but before TTL elapsed.
            if key and JOB_BY_KEY.get(key) == jid:
                JOB_BY_KEY.pop(key, None)


class SketchFile(BaseModel):
    name: str
    content: str


class SpiffsFileBody(BaseModel):
    """One file destined for the SPIFFS partition image, base64-encoded."""
    name: str
    content_b64: str


class CompileRequest(BaseModel):
    # New multi-file API
    files: list[SketchFile] | None = None
    # Legacy single-file API (kept for backward compat)
    code: str | None = None
    board_fqbn: str = "arduino:avr:uno"
    # Optional: associate this compile with a project for analytics
    project_id: str | None = None
    # Per-board ESP32 build options (Partition Scheme, CPU Freq, Flash Mode,
    # PSRAM, etc.). Loose dict so the frontend can add fields without a
    # backend deploy — espidf_compiler.compile validates known keys and
    # ignores the rest. None / missing on non-ESP32 boards.
    board_options: dict[str, str | int | bool] | None = None
    # User-uploaded files to bake into the SPIFFS partition (#162). Empty /
    # None means the SPIFFS region stays blank (current behaviour).
    spiffs_files: list[SpiffsFileBody] | None = None


class CompileResponse(BaseModel):
    success: bool
    hex_content: str | None = None
    binary_content: str | None = None  # base64-encoded .bin for RP2040
    binary_type: str | None = None     # 'bin' or 'uf2'
    has_wifi: bool = False             # True when sketch uses WiFi (ESP32 only)
    stdout: str
    stderr: str
    error: str | None = None
    core_install_log: str | None = None


def _classify_compile_error(stderr: str, error: str | None) -> str:
    """Map raw compiler output to a stable error_kind for analytics."""
    haystack = f"{error or ''}\n{stderr or ''}".lower()
    if "no such file or directory" in haystack or "fatal error:" in haystack:
        return "missing_library"
    if "core install" in haystack or "failed to install" in haystack:
        return "core_install_failed"
    if "undefined reference" in haystack:
        return "linker_error"
    if "expected" in haystack and "before" in haystack:
        return "syntax_error"
    if "error:" in haystack:
        return "compile_error"
    return "unknown"


def _resolve_files(request: CompileRequest) -> list[dict[str, str]]:
    """Normalise the multi-file vs legacy single-file request bodies."""
    if request.files:
        return [{"name": f.name, "content": f.content} for f in request.files]
    if request.code is not None:
        return [{"name": "sketch.ino", "content": request.code}]
    raise HTTPException(
        status_code=422,
        detail="Provide either 'files' or 'code' in the request body.",
    )


async def _run_compile(
    request: CompileRequest,
    files: list[dict[str, str]],
    progress_callback: Any = None,
) -> CompileResponse:
    """Do the actual compile (ESP-IDF for esp32:*, arduino-cli otherwise).

    `progress_callback`, if provided, receives every stdout/stderr line as
    cmake + ninja run. Wired into the async compile path so the live build
    output is exposed via /api/compile/status/{job_id}'s `stdout` field.
    AVR / RP2040 builds via arduino-cli don't surface progress yet — those
    typically finish in seconds anyway.
    """
    if request.board_fqbn.startswith("esp32:") and espidf_compiler.available:
        logger.info(f"[compile] Using ESP-IDF for {request.board_fqbn}")
        spiffs_dicts = (
            [f.model_dump() for f in request.spiffs_files]
            if request.spiffs_files else None
        )
        result = await espidf_compiler.compile(
            files, request.board_fqbn,
            progress_callback=progress_callback,
            board_options=request.board_options,
            spiffs_files=spiffs_dicts,
        )
        return CompileResponse(
            success=result["success"],
            hex_content=result.get("hex_content"),
            binary_content=result.get("binary_content"),
            binary_type=result.get("binary_type"),
            has_wifi=result.get("has_wifi", False),
            stdout=result.get("stdout", ""),
            stderr=result.get("stderr", ""),
            error=result.get("error"),
        )

    # AVR, RP2040, and ESP32 fallback: use arduino-cli
    core_status = await arduino_cli.ensure_core_for_board(request.board_fqbn)
    core_log = core_status.get("log", "")
    if core_status.get("needed") and not core_status.get("installed"):
        return CompileResponse(
            success=False,
            stdout="",
            stderr=core_log,
            error=f"Failed to install required core: {core_status.get('core_id')}",
        )

    # AVR / RP2040 / ATTiny path. `board_options` is accepted for API
    # symmetry but currently ignored — those toolchains don't expose the
    # ESP32 partition / PSRAM knobs we're surfacing.
    result = await arduino_cli.compile(
        files, request.board_fqbn, board_options=request.board_options,
    )
    return CompileResponse(
        success=result["success"],
        hex_content=result.get("hex_content"),
        binary_content=result.get("binary_content"),
        binary_type=result.get("binary_type"),
        stdout=result.get("stdout", ""),
        stderr=result.get("stderr", ""),
        error=result.get("error"),
        core_install_log=core_log if core_log else None,
    )


async def _record_async_metric(
    *,
    user_id: str | None,
    project_id: str | None,
    board_fqbn: str,
    success: bool,
    duration_ms: int,
    error_kind: str | None,
    extra: dict[str, Any],
) -> None:
    """Forward a background-task compile metric to the registered hook.

    Wrapper kept for the async path's signature symmetry with the sync path.
    The hook owns its own DB session (the request-scoped one is gone by now)
    and request=None means country/IP tagging is dropped — only user_id and
    timing flow through.
    """
    await record_compile(
        user_id=user_id,
        project_id=project_id,
        board_fqbn=board_fqbn,
        success=success,
        duration_ms=duration_ms,
        error_kind=error_kind,
        extra=extra,
        request=None,
    )


async def _compile_job(
    job_id: str,
    request: CompileRequest,
    files: list[dict[str, str]],
    user_id: str | None,
) -> None:
    """Background worker: acquire global semaphore + per-target lock, run the
    compile, store result in COMPILE_JOBS.

    `state=pending` while waiting on either gate; transitions to `running`
    only once the actual build is about to start, so clients polling
    /compile/status see an accurate snapshot of where their job is.

    Live build output is appended to COMPILE_JOBS[job_id]['stdout_buffer']
    line-by-line as cmake + ninja emit it, so /compile/status responses
    stream a growing log instead of returning everything at the end.
    """
    started = time.monotonic()
    job = COMPILE_JOBS[job_id]
    started_at = job["started_at"]
    job_key = job.get("key")

    # Live stdout buffer — written from a worker thread (espidf_compiler
    # drain threads). dict[str].update with a single str assignment is GIL-
    # protected so we don't need an explicit lock; the polling endpoint
    # reads the same field.
    COMPILE_JOBS[job_id]["stdout_buffer"] = ""

    def on_progress_line(line: str) -> None:
        # Cap buffer at 256 KB so a runaway build can't OOM the process.
        # Keep the tail (most recent output) — that's what the user wants
        # to see anyway.
        current = COMPILE_JOBS.get(job_id)
        if current is None:
            return
        new = (current.get("stdout_buffer", "") or "") + line
        if len(new) > 262_144:
            new = new[-262_144:]
        current["stdout_buffer"] = new

    try:
        async with _COMPILE_SEMAPHORE:
            async with _target_lock(request.board_fqbn):
                # Job may have been purged or replaced while we were queued.
                # Re-fetch and bail out if so.
                if COMPILE_JOBS.get(job_id) is None:
                    logger.info(f"[compile] job {job_id} purged before run; skipping")
                    return
                COMPILE_JOBS[job_id]["state"] = "running"
                response = await _run_compile(
                    request, files, progress_callback=on_progress_line,
                )
        COMPILE_JOBS[job_id] = {
            "state": "done",
            "started_at": started_at,
            "finished_at": time.time(),
            "result": response.model_dump(),
            "key": job_key,
            # Preserve the streamed buffer post-completion so a late poll
            # still has access to the live log (clients usually display
            # result.stdout once state=done, but having both costs nothing).
            "stdout_buffer": COMPILE_JOBS.get(job_id, {}).get("stdout_buffer", ""),
        }
        error_kind = (
            None if response.success
            else _classify_compile_error(response.stderr, response.error)
        )
        await _record_async_metric(
            user_id=user_id,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=response.success,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_kind=error_kind,
            extra={
                "file_count": len(files),
                "has_wifi": response.has_wifi,
                "async": True,
                "partition_scheme": (request.board_options or {}).get("partitionScheme"),
                "spiffs_file_count": len(request.spiffs_files or []),
            },
        )
    except Exception as exc:
        logger.exception(f"[compile] async job {job_id} failed")
        COMPILE_JOBS[job_id] = {
            "state": "error",
            "started_at": started_at,
            "finished_at": time.time(),
            "error": str(exc)[:500],
            "key": job_key,
            "stdout_buffer": COMPILE_JOBS.get(job_id, {}).get("stdout_buffer", ""),
        }
        await _record_async_metric(
            user_id=user_id,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_kind="exception",
            extra={"file_count": len(files), "exception": str(exc)[:200], "async": True},
        )


@router.post("/", response_model=CompileResponse)
async def compile_sketch(
    request: CompileRequest,
    http_request: Request,
    user_id: str | None = Depends(get_current_user_id),
):
    """
    Compile Arduino sketch and return hex/binary in a single response.

    Synchronous path: held open until the build finishes. Works for AVR /
    RP2040 builds (seconds), but ESP-IDF cold builds can run 5-7 minutes
    and will hit Cloudflare's 100s edge timeout (HTTP 524). Use the async
    path (`/compile/start` + `/compile/status/{job_id}`) for those.

    Accepts either `files` (multi-file) or legacy `code` (single file).
    Auto-installs the required board core if not present.
    """
    files = _resolve_files(request)
    started = time.monotonic()
    try:
        response = await _run_compile(request, files)
    except Exception as e:
        await record_compile(
            user_id=user_id,
            project_id=request.project_id,
            board_fqbn=request.board_fqbn,
            success=False,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_kind="exception",
            extra={"file_count": len(files), "exception": str(e)[:200]},
            request=http_request,
        )
        raise HTTPException(status_code=500, detail=str(e))

    duration_ms = int((time.monotonic() - started) * 1000)
    await record_compile(
        user_id=user_id,
        project_id=request.project_id,
        board_fqbn=request.board_fqbn,
        success=response.success,
        duration_ms=duration_ms,
        error_kind=None if response.success else _classify_compile_error(response.stderr, response.error),
        extra={
            "file_count": len(files),
            "has_wifi": response.has_wifi,
            "partition_scheme": (request.board_options or {}).get("partitionScheme"),
            "spiffs_file_count": len(request.spiffs_files or []),
        },
        request=http_request,
    )
    return response


class CompileStartResponse(BaseModel):
    job_id: str


class CompileStatusResponse(BaseModel):
    state: str  # 'pending' | 'running' | 'done' | 'error'
    started_at: float
    finished_at: float | None = None
    # Live build output. Grows line-by-line during state=running so the
    # frontend can stream it into the compilation console instead of
    # waiting for everything to land at the end. Capped at 256 KB
    # (most recent tail kept).
    stdout: str = ""
    result: CompileResponse | None = None
    error: str | None = None


@router.post("/start", response_model=CompileStartResponse)
async def compile_start(
    request: CompileRequest,
    user_id: str | None = Depends(get_current_user_id),
):
    """
    Queue a compile and return a `job_id` immediately.

    The actual compile runs in a background task; clients then poll
    `GET /compile/status/{job_id}` every couple of seconds until state is
    `done` or `error`. This sidesteps Cloudflare's 100s HTTP edge timeout —
    each individual request returns in milliseconds.

    Deduplication: identical (files, board_fqbn) submissions while a
    matching job is still pending or running return the existing job_id
    instead of spawning a new build. Prevents the "user clicks compile six
    times → six concurrent ninja processes peeling each other apart"
    failure mode.
    """
    files = _resolve_files(request)
    _purge_expired_jobs()

    spiffs_dicts = (
        [f.model_dump() for f in request.spiffs_files] if request.spiffs_files else None
    )
    key = _job_key(files, request.board_fqbn, request.board_options, spiffs_dicts)
    existing_id = JOB_BY_KEY.get(key)
    if existing_id is not None:
        existing = COMPILE_JOBS.get(existing_id)
        if existing is not None and existing.get("state") in ("pending", "running"):
            logger.info(f"[compile] dedup hit — reusing job {existing_id}")
            return CompileStartResponse(job_id=existing_id)

    job_id = uuid.uuid4().hex
    COMPILE_JOBS[job_id] = {"state": "pending", "started_at": time.time(), "key": key}
    JOB_BY_KEY[key] = job_id

    asyncio.create_task(
        _compile_job(
            job_id=job_id,
            request=request,
            files=files,
            user_id=user_id,
        ),
    )
    return CompileStartResponse(job_id=job_id)


@router.get("/status/{job_id}", response_model=CompileStatusResponse)
async def compile_status(job_id: str):
    """Poll the status of an async compile job submitted via /compile/start.

    `stdout` carries live cmake + ninja output captured line-by-line as
    the build runs. Clients should poll every 1-2s and re-render the
    full string each time (or compute a length delta). Once state=done,
    `result.stdout` carries the same content too — both are kept so a
    late-arriving poll always has the log available.
    """
    job = COMPILE_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found or expired")
    return CompileStatusResponse(
        state=job["state"],
        started_at=job["started_at"],
        finished_at=job.get("finished_at"),
        stdout=job.get("stdout_buffer", "") or "",
        result=job.get("result"),
        error=job.get("error"),
    )


@router.get("/setup-status")
async def setup_status():
    return await arduino_cli.get_setup_status()


@router.post("/ensure-core")
async def ensure_core(request: CompileRequest):
    fqbn = request.board_fqbn
    result = await arduino_cli.ensure_core_for_board(fqbn)
    return result


@router.get("/boards")
async def list_boards():
    boards = await arduino_cli.list_boards()
    return {"boards": boards}
