"""
ESP-IDF Compilation Service for ESP32 targets.

Replaces arduino-cli for ESP32/ESP32-C3 compilation.  User Arduino sketches
are compiled using ESP-IDF (with optional Arduino-as-component) to produce
firmware that boots reliably in the lcgamboa QEMU fork.

The key difference vs arduino-cli: ESP-IDF gives control over bootloader,
sdkconfig, and flash mapping — all of which must be QEMU-compatible.

Two compilation modes:
  1. Arduino-as-component: Full Arduino API (WiFi.h, WebServer.h, etc.)
     compiled through idf.py.  Requires ARDUINO_ESP32_PATH env var.
  2. Pure ESP-IDF: Translates common Arduino patterns to ESP-IDF C APIs.
     Fallback when Arduino component is not installed.
"""
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import string
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# Location of the ESP-IDF project template (relative to this file)
_TEMPLATE_DIR = Path(__file__).parent / 'esp-idf-template'

# ── Persistent build dir ─────────────────────────────────────────────────────
# Cold ESP-IDF compiles rebuild ~1480 base objects (FreeRTOS, lwIP, esp_wifi,
# libsodium, …). The default tempfile.TemporaryDirectory flow gave each compile
# a fresh path under /tmp/espidf_<random>/, which baked into -I and
# -fmacro-prefix-map flags and made ccache 0% effective (different cwd → hash
# miss every time). With the persistent dir, /var/lib/velxio-build/<target>/
# is a stable anchor: ninja's incremental cache + ccache hits combine to bring
# warm compiles down to ~5-30s.
#
# Concurrent compiles to the SAME target would corrupt the shared build dir;
# they're serialised by the per-target asyncio.Lock in routes/compile.py.
# Different targets get different subdirs and run in parallel.
#
# Set VELXIO_PERSISTENT_BUILD_DIR=0 to fall back to the legacy tempfile flow
# without rebuilding the image (escape hatch if the persistent dir misbehaves
# in production).
_BUILD_ROOT = Path(os.environ.get('VELXIO_BUILD_ROOT', '/var/lib/velxio-build'))
_USE_PERSISTENT_DIR = (
    os.environ.get('VELXIO_PERSISTENT_BUILD_DIR', '1')
    not in ('0', 'false', 'False', '')
)


def _idf_version_signature() -> str:
    """Snapshot of the ESP-IDF + arduino-esp32 toolchain version. Used to
    invalidate persistent build dirs after an upstream submodule bump (the
    cached object files on disk are no longer ABI-compatible)."""
    parts = []
    idf_version_file = Path('/opt/esp-idf/version.txt')
    if idf_version_file.exists():
        parts.append(idf_version_file.read_text(encoding='utf-8').strip())
    arduino_version_file = Path('/opt/arduino-esp32/version.txt')
    if arduino_version_file.exists():
        parts.append(arduino_version_file.read_text(encoding='utf-8').strip())
    if not parts:
        # Fall back to mtime of the IDF tree root — coarse but stable per
        # image build.
        try:
            parts.append(str(int(Path('/opt/esp-idf').stat().st_mtime)))
        except OSError:
            parts.append('unknown')
    return '|'.join(parts)


# Type for live progress callback. Called from a worker thread for every
# stdout/stderr line as the build runs. Implementations should be cheap and
# thread-safe (callers commonly stash lines into a dict shared with the main
# event loop). Exceptions raised from the callback are swallowed so a faulty
# UI hook can never break the build.
ProgressCallback = Callable[[str], None]


@dataclass
class _RunResult:
    """Drop-in replacement for the fields we read off subprocess.CompletedProcess."""
    returncode: int
    stdout: str
    stderr: str


def _run_with_streaming(
    cmd: list[str],
    *,
    cwd: str,
    env: dict[str, str],
    timeout: float,
    progress_callback: Optional[ProgressCallback],
) -> _RunResult:
    """Run `cmd` synchronously and stream stdout + stderr line-by-line.

    Behaves like subprocess.run(capture_output=True, text=True) but invokes
    `progress_callback(line)` for every line as it arrives. When
    progress_callback is None this falls back to a single subprocess.run call
    so we don't pay the threading cost on the unit-test path that doesn't
    care about live output.

    Raises subprocess.TimeoutExpired on timeout (matches the existing flow).
    """
    if progress_callback is None:
        cp = subprocess.run(
            cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
        )
        return _RunResult(returncode=cp.returncode, stdout=cp.stdout, stderr=cp.stderr)

    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,  # line-buffered
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def _drain(stream, sink: list[str]) -> None:
        try:
            for line in iter(stream.readline, ''):
                sink.append(line)
                try:
                    progress_callback(line)
                except Exception:
                    # A faulty progress sink must never break the build.
                    pass
        finally:
            try:
                stream.close()
            except Exception:
                pass

    t_out = threading.Thread(target=_drain, args=(proc.stdout, stdout_lines), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, stderr_lines), daemon=True)
    t_out.start()
    t_err.start()

    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        # Give drain threads a chance to flush before we raise.
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        raise

    t_out.join(timeout=5)
    t_err.join(timeout=5)
    return _RunResult(
        returncode=proc.returncode,
        stdout=''.join(stdout_lines),
        stderr=''.join(stderr_lines),
    )


def _prepare_persistent_project_dir(
    idf_target: str,
    options_hash: str = '',
) -> Path:
    """Return the path to a per-target persistent project dir, materialising
    it from the template on first use and resetting the per-compile parts
    (main/, user_libs/) on every call so a previous sketch's files don't
    leak into the next compile.

    Keeps the `build/` directory intact across calls — that's where ninja's
    incremental cache + the .o files we want ccache to hit live.

    `options_hash` (12-char prefix of sha256 over normalised board options)
    is stored in a second sentinel `.options_hash`. When the hash changes
    between compiles, build/ is wiped so cached .o files compiled against
    the previous sdkconfig don't poison the new config. The wider target
    dir is preserved (template files, idf version sentinel) so we only pay
    the C/C++ recompile cost, not the template re-copy.
    """
    target_dir = _BUILD_ROOT / idf_target
    target_dir.mkdir(parents=True, exist_ok=True)

    # Wipe the whole target dir if the toolchain version changed (the cached
    # .o files are no longer compatible).
    sentinel = target_dir / '.idf_version'
    current_signature = _idf_version_signature()
    if sentinel.exists() and sentinel.read_text(encoding='utf-8').strip() != current_signature:
        logger.info(
            f'[espidf] toolchain version changed; wiping persistent build dir {target_dir}'
        )
        shutil.rmtree(target_dir)
        target_dir.mkdir(parents=True, exist_ok=True)

    project_dir = target_dir / 'project'
    options_sentinel = target_dir / '.options_hash'
    prior_options_hash = (
        options_sentinel.read_text(encoding='utf-8').strip()
        if options_sentinel.exists() else ''
    )

    if not project_dir.exists():
        # First use of this target — full template copy.
        shutil.copytree(_TEMPLATE_DIR, project_dir)
    else:
        # Subsequent compile — reset the per-compile parts only, keep build/.
        # main/ is overwritten with the user's sketch + any extra files.
        # user_libs/ is rebuilt by _resolve_library_components based on the
        # sketch's #includes.
        shutil.rmtree(project_dir / 'main', ignore_errors=True)
        shutil.copytree(_TEMPLATE_DIR / 'main', project_dir / 'main')
        shutil.rmtree(project_dir / 'user_libs', ignore_errors=True)

        if options_hash and options_hash != prior_options_hash:
            # First compile after this feature shipped: prior_options_hash is
            # empty but the persistent build/ was compiled against the old
            # static sdkconfig. Wipe it once to force a clean reconfigure
            # against the templated config — otherwise stale .o files
            # silently mask the new options.
            reason = (
                'first compile post-upgrade'
                if not prior_options_hash
                else f'changed {prior_options_hash!r} -> {options_hash!r}'
            )
            logger.info(
                f'[espidf] board options {reason}; '
                f'wiping build/ to force a full reconfigure'
            )
            shutil.rmtree(project_dir / 'build', ignore_errors=True)

    sentinel.write_text(current_signature, encoding='utf-8')
    if options_hash:
        options_sentinel.write_text(options_hash, encoding='utf-8')
    return project_dir

# Static IP that matches slirp DHCP range (first client = x.x.x.15)
_STATIC_IP = '192.168.4.15'
_GATEWAY_IP = '192.168.4.2'
_NETMASK = '255.255.255.0'

# SSID the QEMU WiFi AP broadcasts.
# Must match one of the access_point_info entries in esp32_wifi_ap.c
# (the lcgamboa QEMU fork). "Espressif" is on channel 5 in that array.
_QEMU_WIFI_SSID = 'Espressif'
_QEMU_WIFI_CHANNEL = 5


class ESPIDFCompiler:
    """Compile Arduino sketches using ESP-IDF for QEMU-compatible output."""

    def __init__(self):
        self.idf_path = os.environ.get('IDF_PATH', '')
        self.arduino_path = os.environ.get('ARDUINO_ESP32_PATH', '')
        self.has_arduino = bool(self.arduino_path) and os.path.isdir(self.arduino_path)

        # Try common locations on Windows dev machines
        if not self.idf_path:
            for candidate in [
                r'C:\Espressif\frameworks\esp-idf-v4.4.7',
                r'C:\esp\esp-idf',
                '/opt/esp-idf',
            ]:
                if os.path.isdir(candidate):
                    self.idf_path = candidate
                    break

        # Auto-detect Arduino-as-component if not explicitly set
        if self.idf_path and not self.has_arduino:
            for candidate in [
                r'C:\Espressif\components\arduino-esp32',
                os.path.join(self.idf_path, '..', 'components', 'arduino-esp32'),
                '/opt/arduino-esp32',
            ]:
                if os.path.isdir(candidate):
                    self.arduino_path = os.path.abspath(candidate)
                    self.has_arduino = True
                    break

        if self.idf_path:
            logger.info(f'[espidf] IDF_PATH={self.idf_path}')
            if self.has_arduino:
                logger.info(f'[espidf] Arduino component: yes ({self.arduino_path})')
            else:
                logger.info('[espidf] Arduino component: no (pure ESP-IDF fallback)')
        else:
            logger.warning('[espidf] IDF_PATH not set — ESP-IDF compilation unavailable')

    @property
    def available(self) -> bool:
        """Whether ESP-IDF toolchain is available."""
        return bool(self.idf_path) and os.path.isdir(self.idf_path)

    def _is_esp32c3(self, board_fqbn: str) -> bool:
        """Return True if FQBN targets ESP32-C3 (RISC-V)."""
        return 'esp32c3' in board_fqbn or 'esp32-c3' in board_fqbn

    def _idf_target(self, board_fqbn: str) -> str:
        """Map FQBN to IDF_TARGET."""
        if self._is_esp32c3(board_fqbn):
            return 'esp32c3'
        # Default to esp32 (Xtensa) for all other ESP32 variants
        return 'esp32'

    def _detect_wifi_usage(self, code: str) -> bool:
        """Check if sketch uses WiFi."""
        return bool(re.search(r'#include\s*[<"]WiFi\.h[">]|WiFi\.begin\(', code))

    def _detect_webserver_usage(self, code: str) -> bool:
        """Check if sketch uses WebServer."""
        return bool(re.search(
            r'#include\s*[<"]WebServer\.h[">]|#include\s*[<"]ESP8266WebServer\.h[">]|WebServer\s+\w+',
            code
        ))

    def _normalize_wifi_for_qemu(self, code: str) -> str:
        """
        Normalize WiFi SSID/password/channel in Arduino sketches for QEMU.

        QEMU's WiFi AP broadcasts _QEMU_WIFI_SSID on _QEMU_WIFI_CHANNEL with open auth.
        This method rewrites the user's sketch so that:
          - Any SSID string literal → _QEMU_WIFI_SSID
          - Password → "" (open auth)
          - Channel → _QEMU_WIFI_CHANNEL
        The user's editor still shows their original code; only the compiled
        binary is modified.
        """
        if not self._detect_wifi_usage(code):
            return code

        # 1) Replace SSID variable definitions:
        #    const char* ssid = "anything" → _QEMU_WIFI_SSID
        #    char ssid[] = "anything"      → _QEMU_WIFI_SSID
        #    #define WIFI_SSID "anything"   → _QEMU_WIFI_SSID
        code = re.sub(
            r'((?:const\s+)?char\s*\*?\s*ssid\s*\[?\]?\s*=\s*)"[^"]*"',
            rf'\1"{_QEMU_WIFI_SSID}"',
            code,
            flags=re.IGNORECASE
        )
        code = re.sub(
            r'(#define\s+\w*SSID\w*\s+)"[^"]*"',
            rf'\1"{_QEMU_WIFI_SSID}"',
            code,
            flags=re.IGNORECASE
        )

        # 2) Normalize WiFi.begin() calls:
        #    WiFi.begin("X")           → WiFi.begin(_QEMU_WIFI_SSID, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin("X", "pass")   → WiFi.begin(_QEMU_WIFI_SSID, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin(ssid, pass, N) → WiFi.begin(ssid, "", _QEMU_WIFI_CHANNEL)
        #    WiFi.begin(ssid)          → WiFi.begin(ssid, "", _QEMU_WIFI_CHANNEL)

        def _rewrite_wifi_begin(m: re.Match) -> str:
            args = m.group(1)
            parts = [a.strip() for a in args.split(',')]
            ssid_arg = parts[0]
            # If SSID is a string literal, force to _QEMU_WIFI_SSID
            if ssid_arg.startswith('"'):
                ssid_arg = f'"{_QEMU_WIFI_SSID}"'
            return f'WiFi.begin({ssid_arg}, "", {_QEMU_WIFI_CHANNEL})'

        code = re.sub(
            r'WiFi\.begin\s*\(([^)]+)\)',
            _rewrite_wifi_begin,
            code
        )

        logger.info('[espidf] WiFi normalized: SSID→%s, channel→%d, open auth', _QEMU_WIFI_SSID, _QEMU_WIFI_CHANNEL)
        return code

    def _translate_sketch_to_espidf(self, sketch_code: str) -> str:
        """
        Translate an Arduino WiFi+WebServer sketch to pure ESP-IDF C code.

        This handles the common pattern:
          - WiFi.begin("ssid", "pass") → esp_wifi_start() with static IP
          - WebServer server(80) + server.on("/", handler) → esp_http_server
          - digitalWrite/pinMode → gpio_set_level/gpio_set_direction

        Returns C source code for sketch_translated.c
        """
        uses_wifi = self._detect_wifi_usage(sketch_code)
        uses_webserver = self._detect_webserver_usage(sketch_code)

        # Extract route handlers from server.on() calls
        routes = []
        handler_bodies = {}
        if uses_webserver:
            # Match: server.on("/path", handler_func)
            # or:    server.on("/path", HTTP_GET, handler_func)
            for m in re.finditer(
                r'server\.on\(\s*"([^"]+)"\s*,\s*(?:HTTP_\w+\s*,\s*)?(\w+)\s*\)',
                sketch_code
            ):
                routes.append((m.group(1), m.group(2)))

            # Extract handler function bodies
            # Match: void handler_name() { ... server.send(...) ... }
            handler_bodies = {}
            for m in re.finditer(
                r'void\s+(\w+)\s*\(\s*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}',
                sketch_code,
                re.DOTALL
            ):
                fname = m.group(1)
                body = m.group(2)
                # Extract server.send() content
                send_match = re.search(
                    r'server\.send\s*\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"',
                    body
                )
                if not send_match:
                    # Try multi-line string or variable
                    send_match = re.search(
                        r'server\.send\s*\(\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\w+)',
                        body
                    )
                if send_match:
                    handler_bodies[fname] = {
                        'status': send_match.group(1),
                        'content_type': send_match.group(2),
                        'content': send_match.group(3),
                    }

        # Build the translated C source
        lines = []
        lines.append('/* Auto-translated from Arduino sketch to ESP-IDF */')
        lines.append('')

        if uses_wifi:
            lines.append(f'#define WIFI_SSID "{_QEMU_WIFI_SSID}"')
            lines.append('#define WIFI_PASS ""')
            lines.append(f'#define STATIC_IP "{_STATIC_IP}"')
            lines.append(f'#define GATEWAY_IP "{_GATEWAY_IP}"')
            lines.append(f'#define NETMASK "{_NETMASK}"')
            lines.append('')

        # Generate HTML content variables from handler bodies
        for fname, info in handler_bodies.items():
            content = info['content']
            if content.startswith('"') or content.startswith("'"):
                content = content.strip('"').strip("'")
            lines.append(f'static const char *{fname}_html = "{content}";')
        lines.append('')

        # Generate ESP-IDF HTTP handlers
        if uses_webserver:
            for path, handler_name in routes:
                info = handler_bodies.get(handler_name, {})
                ct = info.get('content_type', 'text/html')
                lines.append(f'static esp_err_t {handler_name}_handler(httpd_req_t *req) {{')
                lines.append(f'    httpd_resp_set_type(req, "{ct}");')
                if handler_name in handler_bodies:
                    lines.append(f'    return httpd_resp_send(req, {handler_name}_html, HTTPD_RESP_USE_STRLEN);')
                else:
                    lines.append(f'    return httpd_resp_send(req, "OK", 2);')
                lines.append('}')
                lines.append('')

        # Generate webserver start function
        if uses_webserver:
            lines.append('static void start_webserver(void) {')
            lines.append('    httpd_config_t config = HTTPD_DEFAULT_CONFIG();')
            lines.append('    httpd_handle_t server = NULL;')
            lines.append('    if (httpd_start(&server, &config) == ESP_OK) {')
            for path, handler_name in routes:
                uri_var = handler_name + '_uri'
                lines.append(f'        httpd_uri_t {uri_var} = {{')
                lines.append(f'            .uri = "{path}",')
                lines.append(f'            .method = HTTP_GET,')
                lines.append(f'            .handler = {handler_name}_handler')
                lines.append(f'        }};')
                lines.append(f'        httpd_register_uri_handler(server, &{uri_var});')
            lines.append('    }')
            lines.append('}')
            lines.append('')

        # WiFi event handler + init
        if uses_wifi:
            lines.append('static EventGroupHandle_t s_wifi_event_group;')
            lines.append('#define WIFI_CONNECTED_BIT BIT0')
            lines.append('')
            lines.append('static void wifi_event_handler(void *arg, esp_event_base_t base,')
            lines.append('                               int32_t id, void *data) {')
            lines.append('    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START)')
            lines.append('        esp_wifi_connect();')
            lines.append('    else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED)')
            lines.append('        esp_wifi_connect();')
            lines.append('    else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP)')
            lines.append('        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);')
            lines.append('}')
            lines.append('')
            lines.append('static void wifi_init_sta(void) {')
            lines.append('    s_wifi_event_group = xEventGroupCreate();')
            lines.append('    esp_netif_init();')
            lines.append('    esp_event_loop_create_default();')
            lines.append('    esp_netif_t *sta = esp_netif_create_default_wifi_sta();')
            lines.append('    esp_netif_dhcpc_stop(sta);')
            lines.append('    esp_netif_ip_info_t ip_info;')
            lines.append('    ip_info.ip.addr = ipaddr_addr(STATIC_IP);')
            lines.append('    ip_info.gw.addr = ipaddr_addr(GATEWAY_IP);')
            lines.append('    ip_info.netmask.addr = ipaddr_addr(NETMASK);')
            lines.append('    esp_netif_set_ip_info(sta, &ip_info);')
            lines.append('    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();')
            lines.append('    esp_wifi_init(&cfg);')
            lines.append('    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,')
            lines.append('        &wifi_event_handler, NULL, NULL);')
            lines.append('    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,')
            lines.append('        &wifi_event_handler, NULL, NULL);')
            lines.append('    wifi_config_t wifi_config = {')
            lines.append('        .sta = {')
            lines.append('            .ssid = WIFI_SSID,')
            lines.append('            .password = WIFI_PASS,')
            lines.append('            .threshold.authmode = WIFI_AUTH_OPEN,')
            lines.append('        },')
            lines.append('    };')
            lines.append('    esp_wifi_set_mode(WIFI_MODE_STA);')
            lines.append('    esp_wifi_set_config(WIFI_IF_STA, &wifi_config);')
            lines.append('    esp_wifi_start();')
            lines.append('}')
            lines.append('')

        # app_main
        lines.append('void app_main(void) {')
        if uses_wifi:
            lines.append('    esp_err_t ret = nvs_flash_init();')
            lines.append('    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {')
            lines.append('        nvs_flash_erase();')
            lines.append('        nvs_flash_init();')
            lines.append('    }')
            lines.append('    wifi_init_sta();')
            lines.append('    vTaskDelay(pdMS_TO_TICKS(3000));')
        if uses_webserver:
            lines.append('    start_webserver();')
        lines.append('    while (1) {')
        lines.append('        vTaskDelay(pdMS_TO_TICKS(1000));')
        lines.append('    }')
        lines.append('}')

        return '\n'.join(lines) + '\n'

    def _find_arduino_libraries_dir(self) -> Path | None:
        """Find the Arduino global user-libraries directory (installed via arduino-cli)."""
        candidates = [
            Path.home() / 'Arduino' / 'libraries',
            Path.home() / 'Documents' / 'Arduino' / 'libraries',
            Path('/root/Arduino/libraries'),              # Docker / CI as root
            Path('/home/user/Arduino/libraries'),
            Path('/Arduino/libraries'),
        ]
        # Also check arduino-cli's data directory
        for base in [
            Path.home() / '.arduino15',
            Path('/root/.arduino15'),
            Path('/home/user/.arduino15'),
        ]:
            candidates.append(base / 'libraries')

        for c in candidates:
            if c.is_dir():
                logger.info(f'[espidf] Arduino libraries dir: {c}')
                return c
        logger.warning('[espidf] Arduino libraries dir not found')
        return None

    # Headers that will NEVER appear in any Arduino library directory:
    #   - C/C++ standard library headers
    #   - Arduino core API types compiled directly into arduino-esp32 (not installable)
    #
    # Everything else (Wire.h, SPI.h, WiFi.h, Adafruit_GFX.h, …) is resolved
    # dynamically: user-installed libs → IDF component; arduino-esp32 bundled
    # libs → skip (already compiled in); not found → warning.
    _BUILTIN_HEADERS = frozenset({
        # C/C++ standard library
        'math.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'string.h', 'stdarg.h',
        'stddef.h', 'stdbool.h', 'float.h', 'limits.h', 'assert.h',
        # Arduino core types — part of arduino-esp32 source, not installable libraries
        'Arduino.h', 'HardwareSerial.h', 'Stream.h', 'Print.h', 'WString.h',
        'pgmspace.h', 'IPAddress.h',
    })

    # Core arduino-esp32 bundled libraries — already compiled into the IDF component,
    # must NOT be duplicated as separate user_libs components.
    _CORE_ESP32_LIBS: frozenset[str] = frozenset({
        'Wire', 'SPI', 'WiFi', 'EEPROM', 'SD', 'FS',
        'LittleFS', 'SPIFFS', 'WebServer', 'HTTPClient',
        'WiFiClientSecure', 'BluetoothSerial', 'BLE',
        'Preferences', 'Update', 'Ticker',
    })

    def _resolve_library_components(
        self,
        ext_headers: list[str],
        arduino_libs: Path | None,
        esp32_libs: Path | None,
        arduino_comp_name: str,
        user_libs_dir: Path,
    ) -> tuple[list[str], dict[str, str]]:
        """
        BFS over ext_headers (and transitive includes) to discover all external
        Arduino libraries and merge them into a single 'user_libs_all' IDF component.

        All library files are copied flat into one directory, so every header is
        visible to every other header and source file without any cross-component
        REQUIRES propagation — which is unreliable in ESP-IDF 4.x for deeply
        nested transitive dependencies.

        Search priority per header:
          1. arduino_libs (user-installed via Library Manager) → merge into component
          2. esp32_libs   (bundled with arduino-esp32) → skip core libs (Wire, SPI, …);
             merge non-core libs (e.g. Adafruit libs shipped with arduino-esp32)
          3. not found → warning only

        Returns:
            component_names  — ['user_libs_all'] if any lib found, else []
            header_to_comp   — every resolved header → 'user_libs_all'
        """
        logger.info(f'[espidf] ext_headers detected: {ext_headers}')
        logger.info(f'[espidf] arduino_libs: {arduino_libs}')
        logger.info(f'[espidf] esp32_libs: {esp32_libs}')

        comp_dir = user_libs_dir / 'user_libs_all'
        comp_dir.mkdir(exist_ok=True)

        cpp_files: list[str] = []
        seen_names: set[str] = set()
        header_to_comp: dict[str, str] = {}
        found_any = False

        headers_to_resolve: list[str] = list(ext_headers)
        resolved_headers: set[str] = set()

        while headers_to_resolve:
            header = headers_to_resolve.pop(0)
            if header in resolved_headers:
                continue
            resolved_headers.add(header)

            src_root = (
                self._find_library_for_header(header, arduino_libs)
                if arduino_libs and arduino_libs.is_dir()
                else None
            )

            if src_root is None and esp32_libs and esp32_libs.is_dir():
                esp32_root = self._find_library_for_header(header, esp32_libs)
                if esp32_root:
                    lib_name = esp32_root.parent.name if esp32_root.name == 'src' else esp32_root.name
                    if lib_name in self._CORE_ESP32_LIBS:
                        logger.debug(f'[espidf] <{header}> is bundled core lib "{lib_name}", skipping')
                    else:
                        logger.info(f'[espidf] <{header}> found in esp32_libs as "{lib_name}", merging')
                        src_root = esp32_root

            if src_root:
                lib_dir_name = src_root.parent.name if src_root.name == 'src' else src_root.name
                logger.info(f'[espidf] Merging "{lib_dir_name}" into user_libs_all for <{header}>')
                found_any = True
                header_to_comp[header] = 'user_libs_all'

                # Preserve directory structure while merging libraries.
                # Skip non-buildable directories like examples, tests, docs.
                lib_root = src_root.parent if src_root.name == 'src' else src_root
                has_src_layout = (lib_root / 'src').is_dir()

                excluded_dirs = {
                    '.git', '.github', '.vscode', '__pycache__',
                    'docs', 'doc', 'example', 'examples', 'test', 'tests',
                    'extras', 'ci', 'fuzz', 'fuzzing', 'benchmark', 'benchmarks',
                }

                def _should_include(rel_path: Path) -> bool:
                    parts = rel_path.parts
                    if any(part.lower() in excluded_dirs for part in parts[:-1]):
                        return False
                    if rel_path.suffix not in ('.h', '.hpp', '.c', '.cpp'):
                        return False
                    if has_src_layout:
                        return parts[0] == 'src' or len(parts) == 1
                    # Non-src-layout libs (Adafruit_GFX, etc.) keep auxiliary
                    # headers in subdirs like Fonts/ or gfxfont/. Anything not
                    # already excluded (docs/examples/tests handled above) is
                    # presumed to be buildable source.
                    return True

                for f in lib_root.rglob('*'):
                    if not f.is_file():
                        continue
                    rel_path = f.relative_to(lib_root)
                    if not _should_include(rel_path):
                        continue
                    # Track file by its relative path to preserve structure
                    file_key = str(rel_path).replace('\\', '/')
                    if file_key not in seen_names:
                        dest = comp_dir / rel_path
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(f, dest)
                        seen_names.add(file_key)
                    if f.suffix in ('.cpp', '.c') and file_key not in cpp_files:
                        cpp_files.append(file_key)

                # Scan newly copied headers for transitive includes.
                # Use rglob so libs with `src/` layout (e.g. GxEPD2, ArduinoJson)
                # are scanned recursively — otherwise their headers live under
                # `src/`/subdirs and we'd miss every transitive include.
                for lib_file in comp_dir.rglob('*.h'):
                    try:
                        lib_content = lib_file.read_text(encoding='utf-8', errors='ignore')
                        for th in self._detect_external_includes(lib_content):
                            if th not in resolved_headers:
                                headers_to_resolve.append(th)
                    except OSError:
                        pass
            else:
                logger.warning(f'[espidf] Library for <{header}> not found — build may fail')

        if not found_any:
            return [], {}

        srcs_line = 'SRCS ' + ' '.join(f'"{f}"' for f in sorted(cpp_files)) if cpp_files else ''

        # Generate INCLUDE_DIRS from the directory structure of copied files.
        # Use PurePosixPath so paths stay forward-slashed on Windows — CMake
        # parses backslashes as string escapes (e.g. "src\bitmaps" → invalid \b).
        include_dirs: set[str] = {'.'}
        for file_key in seen_names:
            parent = str(PurePosixPath(file_key).parent)
            if parent and parent != '.':
                include_dirs.add(parent)

        include_dirs_line = 'INCLUDE_DIRS ' + ' '.join(f'"{d}"' for d in sorted(include_dirs))

        cmake_content = (
            '# Auto-generated by Velxio — all user libraries merged into one component.\n'
            '# Directory structure preserved for libraries like ArduinoJson with src/ layout.\n'
            'idf_component_register(\n'
            f'    {srcs_line}\n'
            f'    {include_dirs_line}\n'
            f'    REQUIRES {arduino_comp_name}\n'
            ')\n'
        )
        (comp_dir / 'CMakeLists.txt').write_text(cmake_content, encoding='utf-8')
        logger.info(
            f'[espidf] user_libs_all: {len(cpp_files)} source files, '
            f'{len(header_to_comp)} resolved headers'
        )
        return ['user_libs_all'], header_to_comp

    def _detect_external_includes(self, code: str) -> list[str]:
        """Return library header names that are likely from external libraries."""
        headers = []
        for m in re.finditer(r'#\s*include\s*<([^>]+)>', code):
            h = m.group(1)
            if h in self._BUILTIN_HEADERS:
                continue
            # Skip paths with / (esp-idf internal headers like freertos/FreeRTOS.h)
            if '/' in h:
                continue
            # Skip headers that look like esp-idf internal (prefix pattern)
            if re.match(r'^(esp_|driver/|soc/|hal/|nvs|rom/)', h):
                continue
            headers.append(h)
        return headers

    def _find_library_for_header(self, header: str, libs_dir: Path) -> Path | None:
        """
        Search libs_dir for a library that provides `header`.
        Returns the source root of the library (root or src/ subdirectory).
        """
        for lib_dir in sorted(libs_dir.iterdir()):
            if not lib_dir.is_dir():
                continue
            for src_root in [lib_dir, lib_dir / 'src']:
                if (src_root / header).exists():
                    return src_root
        return None

    def _create_idf_component(
        self,
        header: str,
        src_root: Path,
        user_libs_dir: Path,
        arduino_comp_name: str,
    ) -> str:
        """
        Create a proper ESP-IDF component for a library in user_libs_dir.

        Each library becomes user_libs/<comp_name>/ with its own CMakeLists.txt
        that calls idf_component_register(). This is the correct ESP-IDF way to
        include third-party code and properly handles include paths so that
        internal library includes like #include "utility/xyz.h" work correctly.

        Returns the component directory name (used in REQUIRES of main).
        """
        # Sanitise name: use the library directory name, not the header name
        # src_root may be the library root OR lib/src/ — handle both cases
        lib_dir_name = src_root.parent.name if src_root.name == 'src' else src_root.name
        safe_name = re.sub(r'[^A-Za-z0-9_]', '_', lib_dir_name)
        comp_dir = user_libs_dir / safe_name
        comp_dir.mkdir(parents=True, exist_ok=True)

        # Preserve the original library layout for actual buildable library code
        # while skipping repo-only content such as examples, tests, and CI files.
        lib_root = src_root.parent if src_root.name == 'src' else src_root
        include_dirs: set[str] = {'.'}
        cpp_files: set[str] = set()
        copied_any = False

        has_src_layout = (lib_root / 'src').is_dir()
        excluded_dirs = {
            '.git',
            '.github',
            '.vscode',
            '__pycache__',
            'docs',
            'doc',
            'example',
            'examples',
            'test',
            'tests',
            'extras',
            'ci',
            'fuzz',
            'fuzzing',
            'benchmark',
            'benchmarks',
        }

        def should_include(relative_path: Path) -> bool:
            parts = relative_path.parts
            if any(part.lower() in excluded_dirs for part in parts[:-1]):
                return False
            if relative_path.suffix not in ('.h', '.hpp', '.c', '.cpp'):
                return False

            if has_src_layout:
                return parts[0] == 'src' or len(parts) == 1

            return len(parts) == 1 or parts[0].lower() == 'utility'

        for f in lib_root.rglob('*'):
            if not f.is_file():
                continue
            rel_path = f.relative_to(lib_root)
            if not should_include(rel_path):
                continue
            dest = comp_dir / rel_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            copied_any = True
            include_dirs.add(str(rel_path.parent).replace('\\', '/'))
            if f.suffix in ('.cpp', '.c'):
                cpp_files.add(str(rel_path).replace('\\', '/'))

        if not copied_any:
            raise ValueError(f'No buildable source files found in library {lib_dir_name}')

        # Generate CMakeLists.txt for this component
        include_dirs.discard('.')
        ordered_include_dirs = ['.'] + sorted(d for d in include_dirs if d and d != '.')

        if cpp_files:
            srcs_line = 'SRCS ' + ' '.join(f'"{f}"' for f in sorted(cpp_files))
        else:
            srcs_line = '# header-only library'

        include_dirs_line = 'INCLUDE_DIRS ' + ' '.join(
            f'"{include_dir}"' for include_dir in ordered_include_dirs
        )

        cmake_content = (
            f'# Auto-generated by Velxio for library: {lib_dir_name}\n'
            f'idf_component_register(\n'
            f'    {srcs_line}\n'
            f'    {include_dirs_line}\n'
            f'    REQUIRES {arduino_comp_name}\n'
            f')\n'
        )
        (comp_dir / 'CMakeLists.txt').write_text(cmake_content, encoding='utf-8')

        logger.info(
            f'[espidf] Created IDF component "{safe_name}" for <{header}>'
            f' ({len(cpp_files)} source file(s))'
        )
        return safe_name

    def _build_env(self, idf_target: str) -> dict:
        """Build environment dict for ESP-IDF subprocess."""
        env = os.environ.copy()
        env['IDF_PATH'] = self.idf_path
        env['IDF_TARGET'] = idf_target

        if self.has_arduino:
            env['ARDUINO_ESP32_PATH'] = self.arduino_path

        # On Windows, ESP-IDF uses its own Python venv
        if os.name == 'nt':
            py_venv = os.path.join(
                os.path.dirname(self.idf_path), '..',
                'python_env', 'idf4.4_py3.10_env'
            )
            # Also try the standard Espressif location
            if not os.path.isdir(py_venv):
                py_venv = r'C:\Espressif\python_env\idf4.4_py3.10_env'

            if os.path.isdir(py_venv):
                py_scripts = os.path.join(py_venv, 'Scripts')
                env['PATH'] = py_scripts + os.pathsep + env.get('PATH', '')
                env['VIRTUAL_ENV'] = py_venv

            # Add ESP-IDF tools to PATH
            tools_path = os.environ.get('IDF_TOOLS_PATH', r'C:\Users\David\.espressif')
            if os.path.isdir(tools_path):
                # Add all tool bin dirs
                for tool_dir in Path(tools_path).glob('tools/*/*/bin'):
                    env['PATH'] = str(tool_dir) + os.pathsep + env['PATH']
                # Xtensa toolchain
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp32-elf/*/xtensa-esp32-elf/bin'):
                    env['PATH'] = str(tc_dir) + os.pathsep + env['PATH']
                for tc_dir in Path(tools_path).glob('tools/riscv32-esp-elf/*/riscv32-esp-elf/bin'):
                    env['PATH'] = str(tc_dir) + os.pathsep + env['PATH']
        else:
            # Linux/Docker: explicitly add toolchain bin dirs to PATH so cmake
            # can find the cross-compilers even when the process wasn't started
            # with export.sh (e.g. after a uvicorn restart or in tests).
            tools_path = os.environ.get('IDF_TOOLS_PATH', os.path.expanduser('~/.espressif'))
            env['IDF_TOOLS_PATH'] = tools_path
            if os.path.isdir(tools_path):
                extra_paths: list[str] = []
                # Xtensa toolchain (ESP32, ESP32-S3)
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp32-elf/*/xtensa-esp32-elf/bin'):
                    extra_paths.append(str(tc_dir))
                for tc_dir in Path(tools_path).glob('tools/xtensa-esp-elf/*/xtensa-esp-elf/bin'):
                    extra_paths.append(str(tc_dir))
                # RISC-V toolchain (ESP32-C3)
                for tc_dir in Path(tools_path).glob('tools/riscv32-esp-elf/*/riscv32-esp-elf/bin'):
                    extra_paths.append(str(tc_dir))
                # ESP-IDF host tools (esptool, partition_table, etc.)
                for tool_dir in Path(tools_path).glob('tools/*/*/bin'):
                    extra_paths.append(str(tool_dir))
                if extra_paths:
                    env['PATH'] = os.pathsep.join(extra_paths) + os.pathsep + env.get('PATH', '')

        return env

    # ── Board options → sdkconfig / partition translation ───────────────
    # Per-board ESP32 build options arrive as a loose dict from the
    # frontend. _normalize_options validates the known keys and fills in
    # defaults; _render_sdkconfig and _render_partition_csv then turn the
    # normalised dict into the two files cmake reads at configure time.

    # Schemes available in the UI. Each CSV is a verbatim copy of the
    # arduino-esp32 partition table layout for that name. Keys must match
    # ESP32PartitionScheme on the frontend.
    _PARTITION_CSVS: dict[str, str] = {
        # Velxio's historical default: single huge factory app, no OTA.
        # Picking this as the fallback keeps pre-feature projects byte-for-byte
        # compatible (compiled apps stayed under 3 MB).
        'huge_app': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x300000,\n'
            'spiffs,   data, spiffs,  0x310000,0xE0000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'default': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x140000,\n'
            'app1,     app,  ota_1,   0x150000,0x140000,\n'
            'spiffs,   data, spiffs,  0x290000,0x150000,\n'
            'coredump, data, coredump,0x3E0000,0x10000,\n'
        ),
        'defaults_ffat': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x140000,\n'
            'app1,     app,  ota_1,   0x150000,0x140000,\n'
            'ffat,     data, fat,     0x290000,0x150000,\n'
            'coredump, data, coredump,0x3E0000,0x10000,\n'
        ),
        'min_spiffs': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'app1,     app,  ota_1,   0x1F0000,0x1E0000,\n'
            'spiffs,   data, spiffs,  0x3D0000,0x20000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'min_ffat': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'app1,     app,  ota_1,   0x1F0000,0x1E0000,\n'
            'ffat,     data, fat,     0x3D0000,0x20000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'no_ota': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x200000,\n'
            'spiffs,   data, spiffs,  0x210000,0x1E0000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'no_fs': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1F0000,\n'
            'app1,     app,  ota_1,   0x200000,0x1F0000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'large_spiffs': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x5000,\n'
            'otadata,  data, ota,     0xe000,  0x2000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'spiffs,   data, spiffs,  0x1F0000,0x200000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
        'rainmaker': (
            '# Name,   Type, SubType, Offset,  Size, Flags\n'
            'nvs,      data, nvs,     0x9000,  0x4000,\n'
            'otadata,  data, ota,     0xd000,  0x2000,\n'
            'phy_init, data, phy,     0xf000,  0x1000,\n'
            'app0,     app,  ota_0,   0x10000, 0x1E0000,\n'
            'app1,     app,  ota_1,   0x1F0000,0x1E0000,\n'
            'fctry,    data, nvs,     0x3D0000,0x6000,\n'
            'coredump, data, coredump,0x3F0000,0x10000,\n'
        ),
    }

    # Known option defaults — used to backfill missing keys so older clients
    # (or callers without the feature wired up) still get a build.
    _DEFAULT_OPTIONS: dict[str, str | int | bool] = {
        'partitionScheme': 'huge_app',  # historical Velxio default
        'cpuFreqMHz': 240,
        'flashMode': 'dio',
        'flashSize': '4MB',
        'flashFreqMHz': '40',
        'psram': 'disabled',
        'coreDebugLevel': 'none',
        'eraseFlashOnUpload': False,
        'eventsRunOnCore': 1,
        'arduinoRunsOnCore': 1,
    }

    _VALID_VALUES: dict[str, set] = {
        'partitionScheme': set(_PARTITION_CSVS.keys()),
        'cpuFreqMHz': {240, 160, 80, 40, 20, 10},
        'flashMode': {'qio', 'dio', 'qout', 'dout'},
        'flashSize': {'4MB', '8MB', '16MB'},
        'flashFreqMHz': {'80', '40'},
        'psram': {'disabled', 'enabled', 'opi'},
        'coreDebugLevel': {'none', 'error', 'warn', 'info', 'debug', 'verbose'},
        'eventsRunOnCore': {0, 1},
        'arduinoRunsOnCore': {0, 1},
    }

    _DEBUG_LEVEL_NUMBER: dict[str, int] = {
        'none': 0,
        'error': 1,
        'warn': 2,
        'info': 3,
        'debug': 4,
        'verbose': 5,
    }

    _FLASH_SIZE_BYTES: dict[str, int] = {
        '4MB': 4 * 1024 * 1024,
        '8MB': 8 * 1024 * 1024,
        '16MB': 16 * 1024 * 1024,
    }

    def _normalize_options(
        self,
        opts: dict | None,
        idf_target: str,
    ) -> dict:
        """Fill missing keys with defaults, validate enums, strip
        target-incompatible keys (e.g. PSRAM on C3).

        Raises ValueError on an unknown enum value — caller turns this into
        a user-visible compile error.
        """
        normalized: dict = {**self._DEFAULT_OPTIONS}
        if opts:
            for k, v in opts.items():
                if k not in self._DEFAULT_OPTIONS:
                    continue
                if k in self._VALID_VALUES and v not in self._VALID_VALUES[k]:
                    raise ValueError(
                        f"Invalid board option {k}={v!r}; "
                        f"expected one of {sorted(self._VALID_VALUES[k])}"
                    )
                normalized[k] = v

        # ESP32-C3 has no external PSRAM controller — silently disable so
        # a stale field from an upgraded project doesn't trip up the build.
        if idf_target == 'esp32c3':
            normalized['psram'] = 'disabled'

        # OPI PSRAM (octal) is an S3-only mode. Downgrade to 'enabled' on
        # classic Xtensa so users who switched boards mid-project don't get
        # a stuck build.
        if normalized['psram'] == 'opi' and idf_target != 'esp32s3':
            normalized['psram'] = 'enabled'

        return normalized

    def _render_sdkconfig(self, normalized: dict, template_dir: Path) -> str:
        """Render sdkconfig.defaults from the .in template + normalised opts."""
        template_path = template_dir / 'sdkconfig.defaults.in'
        template_text = template_path.read_text(encoding='utf-8')

        # ── Flash mode (exactly one of QIO/DIO/QOUT/DOUT) ─────────────
        flash_mode = normalized['flashMode']
        flash_mode_lines = '\n'.join(
            f'CONFIG_ESPTOOLPY_FLASHMODE_{m.upper()}={"y" if m == flash_mode else "n"}'
            for m in ('qio', 'dio', 'qout', 'dout')
        )

        # ── Flash frequency ────────────────────────────────────────────
        flash_freq = normalized['flashFreqMHz']
        flash_freq_lines = '\n'.join(
            f'CONFIG_ESPTOOLPY_FLASHFREQ_{f}M={"y" if f == flash_freq else "n"}'
            for f in ('80', '40', '26', '20')
        )

        # ── Flash size ─────────────────────────────────────────────────
        flash_size = normalized['flashSize']
        flash_size_lines_list = [
            f'CONFIG_ESPTOOLPY_FLASHSIZE_{s}={"y" if s == flash_size else "n"}'
            for s in ('2MB', '4MB', '8MB', '16MB')
        ]
        flash_size_lines_list.append(f'CONFIG_ESPTOOLPY_FLASHSIZE="{flash_size}"')
        flash_size_lines = '\n'.join(flash_size_lines_list)

        # ── CPU frequency ──────────────────────────────────────────────
        cpu_freq = int(normalized['cpuFreqMHz'])
        cpu_lines = [
            f'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_{f}='
            f'{"y" if f == cpu_freq else "n"}'
            for f in (240, 160, 80, 40)
        ]
        cpu_lines.append(f'CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ={cpu_freq}')
        cpu_freq_lines = '\n'.join(cpu_lines)

        # ── PSRAM ──────────────────────────────────────────────────────
        psram_mode = normalized['psram']
        psram_chunks: list[str] = []
        if psram_mode == 'disabled':
            psram_chunks.append('CONFIG_SPIRAM=n')
        else:
            psram_chunks.append('CONFIG_SPIRAM=y')
            psram_chunks.append('CONFIG_SPIRAM_USE_MALLOC=y')
            psram_chunks.append('CONFIG_SPIRAM_SPEED_80M=y')
            if psram_mode == 'opi':
                psram_chunks.append('CONFIG_SPIRAM_MODE_OCT=y')
            else:
                psram_chunks.append('CONFIG_SPIRAM_MODE_QUAD=y')
        psram_lines = '\n'.join(psram_chunks)

        substitutions = {
            'FLASH_MODE_LINES': flash_mode_lines,
            'FLASH_FREQ_LINES': flash_freq_lines,
            'FLASH_SIZE_LINES': flash_size_lines,
            'CPU_FREQ_LINES': cpu_freq_lines,
            'PSRAM_LINES': psram_lines,
            'ARDUHAL_LOG_LEVEL': str(
                self._DEBUG_LEVEL_NUMBER[normalized['coreDebugLevel']]
            ),
            'ARDUINO_RUNNING_CORE': str(normalized['arduinoRunsOnCore']),
            'ARDUINO_EVENT_RUNNING_CORE': str(normalized['eventsRunOnCore']),
        }

        return string.Template(template_text).safe_substitute(substitutions)

    def _render_partition_csv(self, scheme: str) -> str:
        """Return the partition table CSV for the given scheme name."""
        csv = self._PARTITION_CSVS.get(scheme)
        if csv is None:
            # Unknown scheme — should not happen because _normalize_options
            # validates, but fall back to the historical layout so the build
            # still succeeds rather than crashing.
            logger.warning(f'[espidf] Unknown partition scheme {scheme!r}, using huge_app')
            csv = self._PARTITION_CSVS['huge_app']
        return csv

    @staticmethod
    def _parse_partition_csv(csv_text: str) -> list[dict]:
        """Parse a partition table CSV into a list of dicts. Handles the
        comma-separated arduino-esp32 format with arbitrary whitespace.
        """
        entries: list[dict] = []
        for line in csv_text.splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            cols = [c.strip() for c in line.split(',')]
            if len(cols) < 5:
                continue
            try:
                offset = int(cols[3], 16) if cols[3] else 0
                size = int(cols[4], 16) if cols[4] else 0
            except ValueError:
                continue
            entries.append({
                'name': cols[0],
                'type': cols[1],
                'subtype': cols[2],
                'offset': offset,
                'size': size,
            })
        return entries

    def _find_filesystem_partition(self, csv_text: str) -> Optional[dict]:
        """Return the SPIFFS or FATFS partition entry, or None."""
        for e in self._parse_partition_csv(csv_text):
            if e['type'] == 'data' and e['subtype'] in ('spiffs', 'fat'):
                return e
        return None

    def _locate_mkspiffs(self) -> Optional[str]:
        """Find the mkspiffs binary. Returns None when unavailable so the
        build can proceed (with an empty FS partition).

        Search order:
          1. $MKSPIFFS_PATH (explicit override)
          2. $IDF_TOOLS_PATH/tools/mkspiffs/*/mkspiffs/mkspiffs[.exe]
          3. shutil.which('mkspiffs')
        """
        override = os.environ.get('MKSPIFFS_PATH')
        if override and os.path.isfile(override):
            return override

        idf_tools = os.environ.get('IDF_TOOLS_PATH')
        if idf_tools:
            for sub in Path(idf_tools, 'tools', 'mkspiffs').glob('*/mkspiffs/mkspiffs*'):
                if sub.is_file():
                    return str(sub)

        found = shutil.which('mkspiffs')
        if found:
            return found

        return None

    def _build_spiffs_image(
        self,
        project_dir: Path,
        spiffs_files: list[dict],
        partition_size_bytes: int,
    ) -> Optional[Path]:
        """Materialise uploaded files into a SPIFFS partition image.

        Returns the path to spiffs.bin, or None if mkspiffs is unavailable
        / the file set is empty. The caller places the bin at the SPIFFS
        offset (looked up from partitions.csv) when merging the flash image.

        Raises ValueError when the inputs are oversized — the route layer
        turns this into a 4xx-shaped CompileResponse for the UI.
        """
        if not spiffs_files:
            return None
        if partition_size_bytes <= 0:
            raise ValueError(
                'Selected partition scheme has no SPIFFS/FATFS region — '
                'remove the uploaded files or pick a scheme with a filesystem.'
            )

        mkspiffs = self._locate_mkspiffs()
        if mkspiffs is None:
            logger.warning(
                '[espidf] mkspiffs not found — uploaded SPIFFS files will be '
                'ignored at flash time. Set MKSPIFFS_PATH or install mkspiffs '
                'into IDF_TOOLS_PATH.'
            )
            return None

        spiffs_data_dir = project_dir / 'spiffs_data'
        if spiffs_data_dir.exists():
            shutil.rmtree(spiffs_data_dir)
        spiffs_data_dir.mkdir(parents=True)

        total_bytes = 0
        for entry in spiffs_files:
            name = entry['name']
            data = base64.b64decode(entry['content_b64'])
            total_bytes += len(data)
            # mkspiffs uses the on-disk filename as the in-flash path so
            # write subdirs literally rather than smuggling slashes into
            # the name. Strip any leading slash to avoid escaping the dir.
            safe_path = name.lstrip('/').lstrip('\\')
            dest = spiffs_data_dir / safe_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)

        # Block size 4096, page size 256 — matches the arduino-esp32
        # defaults so the in-flash image is readable by SPIFFS.begin().
        spiffs_bin = project_dir / 'spiffs.bin'
        cmd = [
            mkspiffs,
            '-c', str(spiffs_data_dir),
            '-b', '4096',
            '-p', '256',
            '-s', str(partition_size_bytes),
            str(spiffs_bin),
        ]
        logger.info(
            f'[espidf] mkspiffs: {len(spiffs_files)} files, '
            f'{total_bytes} bytes payload, {partition_size_bytes} byte partition'
        )

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise ValueError(
                f'mkspiffs failed (rc={result.returncode}): '
                f'{result.stderr.strip() or result.stdout.strip()}'
            )

        return spiffs_bin

    def _merge_flash_image(
        self,
        build_dir: Path,
        is_c3: bool,
        flash_size_bytes: int = 4 * 1024 * 1024,
        spiffs_bin: Optional[Path] = None,
        spiffs_offset: int = 0,
    ) -> Path:
        """Merge bootloader + partitions + app (+ optional SPIFFS) into a
        flash image sized to match the user's Flash Size option."""
        FLASH_SIZE = flash_size_bytes
        flash = bytearray(b'\xff' * FLASH_SIZE)

        bootloader_offset = 0x0000 if is_c3 else 0x1000

        # ESP-IDF build output paths
        bootloader = build_dir / 'bootloader' / 'bootloader.bin'
        partitions = build_dir / 'partition_table' / 'partition-table.bin'
        app = build_dir / 'velxio-sketch.bin'

        if not app.exists():
            # Try alternate names
            for pattern in ['*.bin']:
                candidates = [f for f in build_dir.glob(pattern)
                              if 'bootloader' not in f.name and 'partition' not in f.name]
                if candidates:
                    app = candidates[0]
                    break

        files_found = {
            'bootloader': bootloader.exists(),
            'partitions': partitions.exists(),
            'app': app.exists(),
        }
        logger.info(f'[espidf] Merge files: {files_found}')

        if not all(files_found.values()):
            missing = [k for k, v in files_found.items() if not v]
            raise FileNotFoundError(f'Missing binaries for merge: {missing}')

        last_used = 0
        placements: list[tuple[int, Path]] = [
            (bootloader_offset, bootloader),
            (0x8000, partitions),
            (0x10000, app),
        ]
        if spiffs_bin is not None and spiffs_offset > 0:
            placements.append((spiffs_offset, spiffs_bin))

        for offset, path in placements:
            data = path.read_bytes()
            if offset + len(data) > FLASH_SIZE:
                raise ValueError(
                    f'Partition {path.name} ({len(data)} bytes at 0x{offset:X}) '
                    f'overflows the selected flash size ({FLASH_SIZE} bytes). '
                    f'Pick a larger Flash Size or a partition scheme with a '
                    f'smaller app/data region.'
                )
            flash[offset:offset + len(data)] = data
            last_used = max(last_used, offset + len(data))
            logger.info(f'[espidf] Placed {path.name} at 0x{offset:04X} ({len(data)} bytes)')

        # Trim the trailing 0xFF padding before serializing.
        #
        # Keeping the full 4 MB flash image here gives a ~5.5 MB base64 JSON
        # response that nginx / Cloudflare can choke on (issue #101 — user
        # saw "No response from server"). The frontend stores the trimmed
        # bytes and the backend pads back to the QEMU flash size at the
        # bridge layer right before mtd attach. Lossless: bytes after
        # last_used are 0xFF by construction, so re-padding restores the
        # original image byte-for-byte.
        merged_path = build_dir / 'merged_flash.bin'
        merged_path.write_bytes(bytes(flash[:last_used]))
        logger.info(
            f'[espidf] Merged flash image (trimmed): {merged_path.stat().st_size} bytes '
            f'(would have been {FLASH_SIZE} bytes unpadded)'
        )
        return merged_path

    async def compile(
        self,
        files: list[dict],
        board_fqbn: str,
        progress_callback: Optional[ProgressCallback] = None,
        board_options: dict | None = None,
        spiffs_files: list[dict] | None = None,
    ) -> dict:
        """
        Compile Arduino sketch using ESP-IDF.

        Returns dict compatible with ArduinoCLIService.compile():
            success, binary_content (base64), binary_type, stdout, stderr, error

        Build dir layout:
        - With VELXIO_PERSISTENT_BUILD_DIR=1 (default): a per-target dir at
          /var/lib/velxio-build/<idf_target>/project/ is reused across compiles.
          ninja's incremental cache + ccache hits combine to bring warm
          compiles down to ~5-30s.
        - With VELXIO_PERSISTENT_BUILD_DIR=0: legacy tempfile.TemporaryDirectory
          flow. Every compile rebuilds from scratch.

        The caller (routes/compile.py:_compile_job) holds a per-target
        asyncio.Lock for the duration of this call, so the persistent dir
        is never accessed by two compiles at once.

        progress_callback (optional): if provided, called from a worker
        thread for every stdout/stderr line as cmake and ninja run. Used
        by the async compile path to expose live build output to clients
        polling /api/compile/status/{job_id}.

        board_options (optional): per-board ESP32 build options from the
        UI (Partition Scheme, CPU Frequency, Flash Mode, PSRAM, etc.).
        Missing keys fall back to historical defaults so AVR/RP2040 callers
        and pre-feature clients still get a working build. Note that
        SPIFFS files are NOT folded into the cache-invalidation hash —
        only sdkconfig-affecting options are — because the SPIFFS image is
        rebuilt on every compile anyway and folding it in would burn the
        C/C++ ninja cache on every file edit.
        """
        if not self.available:
            return {
                'success': False,
                'error': 'ESP-IDF toolchain not found. Set IDF_PATH environment variable.',
                'stdout': '',
                'stderr': '',
            }

        idf_target = self._idf_target(board_fqbn)
        is_c3 = self._is_esp32c3(board_fqbn)

        logger.info(f'[espidf] Compiling for {idf_target} (FQBN: {board_fqbn})')
        logger.info(f'[espidf] Files: {[f["name"] for f in files]}')

        try:
            normalized_opts = self._normalize_options(board_options, idf_target)
        except ValueError as exc:
            return {
                'success': False,
                'error': str(exc),
                'stdout': '',
                'stderr': '',
            }

        options_hash = hashlib.sha256(
            json.dumps(normalized_opts, sort_keys=True).encode()
        ).hexdigest()[:12]

        if _USE_PERSISTENT_DIR:
            project_dir = _prepare_persistent_project_dir(idf_target, options_hash)
            logger.info(f'[espidf] Using persistent build dir: {project_dir}')
            return await self._compile_in_dir(
                project_dir, files, idf_target, is_c3,
                progress_callback, normalized_opts, spiffs_files,
            )

        with tempfile.TemporaryDirectory(prefix='espidf_') as temp_dir:
            project_dir = Path(temp_dir) / 'project'
            shutil.copytree(_TEMPLATE_DIR, project_dir)
            logger.info(f'[espidf] Using ephemeral build dir: {project_dir}')
            return await self._compile_in_dir(
                project_dir, files, idf_target, is_c3,
                progress_callback, normalized_opts, spiffs_files,
            )

    async def _compile_in_dir(
        self,
        project_dir: Path,
        files: list[dict],
        idf_target: str,
        is_c3: bool,
        progress_callback: Optional[ProgressCallback] = None,
        board_options: dict | None = None,
        spiffs_files: list[dict] | None = None,
    ) -> dict:
        """Inner compile body: writes sketch + libs into `project_dir`,
        runs cmake + ninja, merges binaries. Caller is responsible for
        creating `project_dir` (with the template tree already copied in)
        and for managing its lifecycle (persistent vs tempfile).
        """
        # board_options is already normalised by compile() — defensive in
        # case _compile_in_dir is called directly from a test path.
        if board_options is None:
            board_options = self._normalize_options(None, idf_target)

        # Render sdkconfig.defaults from the templated .in file using the
        # user's options. Overwrites the static file copied from the
        # template tree. Doing this BEFORE cmake configure means the new
        # CONFIG_* lines reach kconfig on its first read.
        rendered_sdkconfig = self._render_sdkconfig(board_options, _TEMPLATE_DIR)
        (project_dir / 'sdkconfig.defaults').write_text(
            rendered_sdkconfig, encoding='utf-8',
        )

        # Generate partitions.csv per the selected scheme.
        partition_csv = self._render_partition_csv(board_options['partitionScheme'])
        (project_dir / 'partitions.csv').write_text(partition_csv, encoding='utf-8')

        # Get sketch content
        main_content = ''
        for f in files:
            if f['name'].endswith('.ino'):
                main_content = f['content']
                break
        if not main_content and files:
            main_content = files[0]['content']

        # ── QEMU WiFi compatibility ──────────────────────────────────────
        # QEMU's WiFi AP broadcasts "Velxio-GUEST" on channel 6.
        # We normalize ANY user SSID → "Velxio-GUEST", enforce channel 6,
        # and use open auth (empty password) so the connection always works.
        # Detect WiFi BEFORE normalization so the flag reflects the original sketch.
        has_wifi = self._detect_wifi_usage(main_content)
        main_content = self._normalize_wifi_for_qemu(main_content)

        if self.has_arduino:
            # Arduino-as-component mode: copy sketch as .cpp
            sketch_cpp = project_dir / 'main' / 'sketch.ino.cpp'
            # Prepend Arduino.h + velxio_compat.h if not already included.
            # velxio_compat.h shims arduino-esp32 3.x APIs (ledcAttach, …)
            # onto the 2.0.17 toolchain we currently pin. See
            # esp-idf-template/main/velxio_compat.h.
            if '#include' not in main_content or 'Arduino.h' not in main_content:
                main_content = (
                    '#include "Arduino.h"\n'
                    '#include "velxio_compat.h"\n' + main_content
                )
            else:
                main_content = main_content.replace(
                    '#include "Arduino.h"',
                    '#include "Arduino.h"\n#include "velxio_compat.h"',
                    1,
                )
            sketch_cpp.write_text(main_content, encoding='utf-8')

            # Copy additional files (.h, .cpp)
            for f in files:
                if not f['name'].endswith('.ino'):
                    (project_dir / 'main' / f['name']).write_text(
                        f['content'], encoding='utf-8'
                    )

            # Remove the pure-C main to avoid conflict
            main_c = project_dir / 'main' / 'main.c'
            if main_c.exists():
                main_c.unlink()
            sketch_translated = project_dir / 'main' / 'sketch_translated.c'
            if sketch_translated.exists():
                sketch_translated.unlink()

            # ── Resolve external Arduino libraries as IDF components ──────
            # arduino-cli installs libraries in ~/Arduino/libraries/ but the
            # ESP-IDF build system does not scan that path. We create a
            # user_libs/ directory where each external library becomes a
            # proper ESP-IDF component with its own CMakeLists.txt and
            # INCLUDE_DIRS. The root CMakeLists.txt (template) adds user_libs
            # to EXTRA_COMPONENT_DIRS so ESP-IDF discovers them automatically.
            ext_headers = self._detect_external_includes(main_content)
            component_names: list[str] = []
            # arduino-esp32 component name (directory basename of ARDUINO_ESP32_PATH)
            arduino_comp_name = Path(self.arduino_path).name if self.arduino_path else 'arduino-esp32'

            if ext_headers:
                user_libs_dir = project_dir / 'user_libs'
                user_libs_dir.mkdir(exist_ok=True)

                esp32_libs   = Path(self.arduino_path) / 'libraries' if self.arduino_path else None
                arduino_libs = self._find_arduino_libraries_dir()

                component_names, _ = self._resolve_library_components(
                    ext_headers, arduino_libs, esp32_libs,
                    arduino_comp_name, user_libs_dir,
                )

            # Patch main/CMakeLists.txt — REQUIRES and INCLUDE_DIRS for user_libs_all.
            # The single merged component means one entry covers all external headers.
            if component_names:  # always ['user_libs_all'] when any lib was found
                cmake_path = project_dir / 'main' / 'CMakeLists.txt'
                cmake_text = cmake_path.read_text(encoding='utf-8')

                for old_req in [r'REQUIRES ${_arduino_comp_name}', f'REQUIRES {arduino_comp_name}']:
                    if old_req in cmake_text:
                        cmake_text = cmake_text.replace(
                            old_req, f'{old_req} user_libs_all'
                        )
                        break

                cmake_text = cmake_text.replace(
                    'INCLUDE_DIRS "."',
                    'INCLUDE_DIRS "." "../user_libs/user_libs_all"',
                )

                cmake_path.write_text(cmake_text, encoding='utf-8')
                logger.info('[espidf] Patched main CMakeLists: REQUIRES += user_libs_all, INCLUDE_DIRS += user_libs_all')
        else:
            # Pure ESP-IDF mode: translate sketch
            translated = self._translate_sketch_to_espidf(main_content)
            (project_dir / 'main' / 'sketch_translated.c').write_text(
                translated, encoding='utf-8'
            )

            # Remove Arduino main.cpp to avoid conflict
            main_cpp = project_dir / 'main' / 'main.cpp'
            if main_cpp.exists():
                main_cpp.unlink()

        # Build using cmake + ninja (more portable than idf.py on Windows)
        build_dir = project_dir / 'build'
        build_dir.mkdir(exist_ok=True)

        env = self._build_env(idf_target)

        # Step 1: cmake configure
        cmake_cmd = [
            'cmake',
            '-G', 'Ninja',
            '-Wno-dev',
            f'-DIDF_TARGET={idf_target}',
            '-DCMAKE_BUILD_TYPE=Release',
            f'-DSDKCONFIG_DEFAULTS={project_dir / "sdkconfig.defaults"}',
            str(project_dir),
        ]

        # ccache: ESP-IDF's tools/cmake/project.cmake enables ccache iff
        # the CMake variable `CCACHE_ENABLE` is truthy. We don't go through
        # `idf.py` (which would translate the env var for us), so wire it
        # in here. Default ON; set IDF_CCACHE_ENABLE=0 in the env to
        # bypass without rebuilding the image.
        if os.environ.get('IDF_CCACHE_ENABLE', '1') not in ('0', 'false', 'False', ''):
            cmake_cmd.append('-DCCACHE_ENABLE=1')

        logger.info(f'[espidf] cmake: {" ".join(cmake_cmd)}')

        def _run_cmake():
            return _run_with_streaming(
                cmake_cmd,
                cwd=str(build_dir),
                env=env,
                timeout=120,
                progress_callback=progress_callback,
            )

        try:
            cmake_result = await asyncio.to_thread(_run_cmake)
        except subprocess.TimeoutExpired:
            return {
                'success': False,
                'error': 'ESP-IDF cmake configure timed out (120s)',
                'stdout': '',
                'stderr': '',
            }

        if cmake_result.returncode != 0:
            logger.error(f'[espidf] cmake failed:\n{cmake_result.stderr}')
            return {
                'success': False,
                'error': 'ESP-IDF cmake configure failed',
                'stdout': cmake_result.stdout,
                'stderr': cmake_result.stderr,
            }

        # Step 2: ninja build
        ninja_cmd = ['ninja']
        logger.info('[espidf] Building with ninja...')

        # Cold ESP-IDF builds with external Arduino libraries (e.g. Adafruit
        # BMP280 + BusIO + Unified Sensor → ~1480 build steps) regularly take
        # 5-7 minutes on modest hardware. 300s used to cut them off at 98%;
        # bump to 600s so first-run cold compiles complete. Subsequent
        # builds reuse ninja's cache and finish in seconds.
        NINJA_TIMEOUT_S = 600

        def _run_ninja():
            return _run_with_streaming(
                ninja_cmd,
                cwd=str(build_dir),
                env=env,
                timeout=NINJA_TIMEOUT_S,
                progress_callback=progress_callback,
            )

        try:
            ninja_result = await asyncio.to_thread(_run_ninja)
        except subprocess.TimeoutExpired:
            return {
                'success': False,
                'error': f'ESP-IDF build timed out ({NINJA_TIMEOUT_S}s)',
                'stdout': '',
                'stderr': '',
            }

        all_stdout = cmake_result.stdout + '\n' + ninja_result.stdout
        all_stderr = cmake_result.stderr + '\n' + ninja_result.stderr

        # Filter out expected but ugly warnings from stderr (e.g. absent git, cmake deprecation)
        filtered_stderr_lines = []
        for line in all_stderr.splitlines():
            if 'fatal: not a git repository' in line:
                continue
            if 'CMake Deprecation Warning' in line:
                continue
            if 'Compatibility with CMake' in line:
                continue
            filtered_stderr_lines.append(line)
        all_stderr = '\n'.join(filtered_stderr_lines)

        if ninja_result.returncode != 0:
            # Extract the actual compiler errors from ninja's stdout.
            # Ninja prints failed job blocks in stdout:
            #   FAILED: path/to/file.obj
            #   <compiler command>
            #   sketch.ino.cpp:5:10: fatal error: DHT.h: No such file or directory
            #   compilation terminated.
            #   ninja: build stopped: subcommand failed.
            stdout_lines = ninja_result.stdout.split('\n')
            error_lines: list[str] = []
            in_failed_block = False
            for line in stdout_lines:
                stripped = line.strip()
                if stripped.startswith('FAILED:') or stripped == 'ninja: build stopped: subcommand failed.':
                    in_failed_block = True
                    error_lines.append(line)
                    continue
                # Next [N/M] progress line ends the block
                if in_failed_block and stripped.startswith('[') and '/' in stripped and ']' in stripped:
                    in_failed_block = False
                if in_failed_block:
                    error_lines.append(line)
                elif ': error:' in line or 'fatal error:' in line.lower():
                    # Explicit compiler error outside a FAILED block
                    error_lines.append(line)

            extracted = '\n'.join(l for l in error_lines if l.strip())

            # First non-FAILED, non-command error line → short summary for toolbar
            summary = 'ESP-IDF build failed'
            for l in error_lines:
                s = l.strip()
                if s and not s.startswith('FAILED:') and not s.startswith('ninja:') and not s.startswith('/') and 'error:' in s.lower():
                    summary = s
                    break
            if summary == 'ESP-IDF build failed' and error_lines:
                # Fall back to first non-empty error line
                for l in error_lines:
                    if l.strip() and not l.strip().startswith('FAILED:'):
                        summary = l.strip()
                        break

            # Put extracted errors in stderr so the console highlights them
            combined_stderr = (extracted + '\n\n' + all_stderr).strip() if extracted else all_stderr

            logger.error(f'[espidf] ninja build failed (stdout):\n{ninja_result.stdout[-4000:]}')
            logger.error(f'[espidf] ninja build failed (stderr):\n{ninja_result.stderr[-2000:]}')
            return {
                'success': False,
                'error': summary,
                'stdout': all_stdout,
                'stderr': combined_stderr,
            }

        # Step 3: Build the SPIFFS partition image (if files were uploaded
        # and the partition scheme has a filesystem region). Skipped silently
        # when mkspiffs isn't installed — see _build_spiffs_image.
        flash_size_bytes = self._FLASH_SIZE_BYTES.get(
            board_options['flashSize'], 4 * 1024 * 1024,
        )
        fs_partition = self._find_filesystem_partition(partition_csv)
        spiffs_bin: Optional[Path] = None
        spiffs_offset = 0
        if spiffs_files:
            try:
                spiffs_bin = self._build_spiffs_image(
                    project_dir,
                    spiffs_files,
                    fs_partition['size'] if fs_partition else 0,
                )
            except ValueError as exc:
                return {
                    'success': False,
                    'error': str(exc),
                    'stdout': all_stdout,
                    'stderr': all_stderr,
                }
            if spiffs_bin is not None and fs_partition is not None:
                spiffs_offset = fs_partition['offset']

        # Step 4: Merge binaries into flash image
        try:
            merged_path = self._merge_flash_image(
                build_dir, is_c3,
                flash_size_bytes=flash_size_bytes,
                spiffs_bin=spiffs_bin,
                spiffs_offset=spiffs_offset,
            )
        except FileNotFoundError as exc:
            return {
                'success': False,
                'error': f'Binary merge failed: {exc}',
                'stdout': all_stdout,
                'stderr': all_stderr,
            }
        except ValueError as exc:
            return {
                'success': False,
                'error': str(exc),
                'stdout': all_stdout,
                'stderr': all_stderr,
            }

        binary_b64 = base64.b64encode(merged_path.read_bytes()).decode('ascii')
        logger.info(f'[espidf] Compilation successful — {len(binary_b64) // 1024} KB (base64), has_wifi={has_wifi}')

        return {
            'success': True,
            'hex_content': None,
            'binary_content': binary_b64,
            'binary_type': 'bin',
            'has_wifi': has_wifi,
            'stdout': all_stdout,
            'stderr': all_stderr,
        }


# Singleton instance
espidf_compiler = ESPIDFCompiler()
