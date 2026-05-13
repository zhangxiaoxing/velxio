"""Fire-and-forget bridge to Odoo's transactional-mail endpoints.

Velxio leans on Odoo's outgoing-mail relay (SPF/DKIM already warmed up,
templates editable from the admin UI) instead of running its own SMTP.
The Odoo-side endpoints live in `velxio_transactional_mail` (mail) and
`velxio_subscription` (partner upsert) addons:

    POST <ODOO_URL>/velxio/api/upsert-partner       (sync, fast)
    POST <ODOO_URL>/velxio/api/send-welcome         (async, slow — SMTP)
    POST <ODOO_URL>/velxio/api/send-password-reset  (async, slow — SMTP)

All expect a JSON-RPC payload (Odoo's `type='jsonrpc'` controllers expect
`{"jsonrpc": "2.0", "params": {...}}`) and authenticate via the
`X-Velxio-API-Key` header.

`sync_partner` is meant to be awaited synchronously. The mail helpers
are designed to be called from `asyncio.create_task(...)` so they NEVER
raise into the request lifecycle. Any failure is logged at WARNING level
and the function returns False/None. Registration / forgot-password
succeed even when Odoo is down — the user just doesn't get the email
until ops re-runs the cron.

Why the partner upsert is split out: Odoo's transaction isolation is
REPEATABLE READ, so two parallel mail workers for the same brand-new
user (register followed by an immediate forgot-password) would both
take a snapshot before either committed the partner. Both would then
INSERT, hitting the unique constraint on velxio_user_id and rolling
back one of the two mails. Funnelling the partner upsert through a
single synchronous call BEFORE the async mail tasks fire serializes
the create at the Velxio HTTP layer and dodges the snapshot race
entirely.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


def _is_configured() -> bool:
    return bool(settings.ODOO_URL and settings.ODOO_API_KEY)


async def _post(endpoint: str, params: dict) -> Optional[dict]:
    """POST a JSON-RPC envelope to an Odoo /velxio/api/* endpoint.

    Returns the decoded `result` dict on success, None on any failure.
    Never raises.
    """
    if not _is_configured():
        logger.info("[odoo_mail] skipped %s — ODOO_URL or ODOO_API_KEY missing", endpoint)
        return None

    url = settings.ODOO_URL.rstrip("/") + endpoint
    payload = {"jsonrpc": "2.0", "method": "call", "params": params}
    headers = {
        "X-Velxio-API-Key": settings.ODOO_API_KEY,
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=settings.ODOO_MAIL_TIMEOUT_S) as client:
            response = await client.post(url, json=payload, headers=headers)
        if response.status_code != 200:
            logger.warning(
                "[odoo_mail] %s → HTTP %s: %s",
                endpoint, response.status_code, response.text[:200],
            )
            return None
        body = response.json()
        # Odoo wraps `type='json'` controllers in {"jsonrpc": "2.0", "result": ...}
        # or {"error": {...}} on failure.
        if "error" in body:
            logger.warning("[odoo_mail] %s → error %s", endpoint, body["error"])
            return None
        return body.get("result")
    except httpx.TimeoutException:
        logger.warning("[odoo_mail] %s timed out after %ss", endpoint, settings.ODOO_MAIL_TIMEOUT_S)
    except httpx.HTTPError as exc:
        logger.warning("[odoo_mail] %s → HTTP error: %s", endpoint, exc)
    except Exception:  # noqa: BLE001 — fire-and-forget must swallow everything
        logger.exception("[odoo_mail] %s — unexpected failure", endpoint)
    return None


async def sync_partner(
    *,
    velxio_user_id: str,
    email: str,
    name: Optional[str] = None,
    country_code: Optional[str] = None,
) -> Optional[int]:
    """Synchronously ensure the Odoo partner for this user exists.

    Caller awaits this BEFORE firing any async mail tasks so the
    welcome / reset endpoints land on a partner the upsert already
    committed. Returns the partner_id on success, None on any failure
    (Odoo down, network error, etc.). The caller should ignore the
    result and proceed — the user is registered/recovered regardless.
    """
    params: dict = {
        "velxio_user_id": velxio_user_id,
        "email": email,
    }
    if name:
        params["name"] = name
    if country_code:
        params["country_code"] = country_code
    result = await _post("/velxio/api/upsert-partner", params)
    if result and "partner_id" in result:
        return int(result["partner_id"])
    return None


async def send_welcome(
    *,
    velxio_user_id: str,
    email: str,
    name: str,
    country_code: Optional[str] = None,
    editor_url: Optional[str] = None,
    examples_url: Optional[str] = None,
) -> bool:
    """Ask Odoo to send the welcome mail. Returns True iff Odoo accepted
    and dispatched the mail (sent=True in the response).

    Idempotent: Odoo persists `velxio_welcome_sent_at` on the partner, so
    a retry of this call after a successful first dispatch is a silent
    no-op on the Odoo side (returns `{sent: false, reason: "already_sent"}`).
    """
    params: dict = {
        "velxio_user_id": velxio_user_id,
        "email": email,
        "name": name,
    }
    if country_code:
        params["country_code"] = country_code
    if editor_url:
        params["editor_url"] = editor_url
    if examples_url:
        params["examples_url"] = examples_url

    result = await _post("/velxio/api/send-welcome", params)
    return bool(result and result.get("sent"))


async def send_password_reset(
    *,
    email: str,
    reset_url: str,
    expires_in_minutes: int = 60,
    user_name: Optional[str] = None,
    velxio_user_id: Optional[str] = None,
) -> bool:
    """Ask Odoo to deliver a password-reset mail with the given URL.

    The caller (Velxio backend) is the source of truth for the one-time
    token; Odoo only renders the email.

    `velxio_user_id` is forwarded so the Odoo side can upsert/match the
    partner by stable user id (mirroring the send-welcome payload). This
    removes the register-then-immediately-forgot race: with the id in
    hand, send-password-reset can upsert the partner before delivering
    the mail, so it no longer matters which endpoint reaches Odoo first.
    """
    params: dict = {
        "email": email,
        "reset_url": reset_url,
        "expires_in_minutes": expires_in_minutes,
    }
    if user_name:
        params["user_name"] = user_name
    if velxio_user_id:
        params["velxio_user_id"] = velxio_user_id

    result = await _post("/velxio/api/send-password-reset", params)
    return bool(result and result.get("sent"))
