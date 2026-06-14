"""
IoT Gateway — HTTP reverse proxy for ESP32 web servers running in QEMU.

When an ESP32 sketch starts a WebServer on port 80, QEMU's slirp
networking with hostfwd exposes it on a dynamic host port.  This
endpoint proxies HTTP requests from the browser to that host port,
enabling users to interact with their simulated ESP32 HTTP server.

URL pattern:
    /api/gateway/{client_id}/{path}
    →  http://127.0.0.1:{hostfwd_port}/{path}
"""
import json
import logging

import httpx
from fastapi import APIRouter, Request, Response

from app.core.hooks import iot_gateway_gate
from app.services.esp32_lib_manager import esp_lib_manager
from app.services.picow_net.consts import STA_IP
from app.services.picow_net_bridge import picow_net_manager

router = APIRouter()
logger = logging.getLogger(__name__)


@router.api_route(
    '/{client_id}/{path:path}',
    methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
)
async def gateway_proxy(client_id: str, path: str, request: Request) -> Response:
    """Reverse-proxy an HTTP request to the ESP32's web server."""
    # Plan gate (overlay-supplied). OSS image has no gate → allow everyone.
    # When the velxio-prod overlay is loaded, the gateway is a Maker+ feature;
    # free / anonymous callers get a 402 with an upgrade pointer.
    block_detail = await iot_gateway_gate(request)
    if block_detail is not None:
        # The frontend opens the gateway via window.open(_blank), so a raw
        # JSON 402 would dump in a new tab. Content-negotiate: serve a tiny
        # HTML upgrade page to browser navigations, JSON to programmatic
        # (fetch/XHR) callers.
        accepts_html = 'text/html' in (request.headers.get('accept') or '')
        upgrade_url = block_detail.get('upgrade_url', '/pricing')
        msg = block_detail.get('message', 'This is a paid feature.')
        if accepts_html:
            html = (
                '<!doctype html><html><head><meta charset="utf-8">'
                '<title>Velxio — upgrade required</title>'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<style>body{background:#1e1e1e;color:#ddd;font-family:-apple-system,'
                'BlinkMacSystemFont,sans-serif;display:flex;min-height:100vh;margin:0;'
                'align-items:center;justify-content:center;text-align:center}'
                '.box{max-width:440px;padding:32px}h1{font-size:20px;color:#fff}'
                'p{color:#aaa;line-height:1.6}a{display:inline-block;margin-top:16px;'
                'background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;'
                'text-decoration:none;font-weight:600}</style></head><body><div class="box">'
                '<h1>IoT gateway is a Maker feature</h1>'
                f'<p>{msg} Upgrade to access live ESP32 web servers running in your '
                'simulated circuit.</p>'
                f'<a href="https://velxio.dev{upgrade_url}">See plans</a>'
                '</div></body></html>'
            )
            return Response(content=html, status_code=402, media_type='text/html')
        return Response(
            content=json.dumps({'error': 'pro_required', 'detail': block_detail}),
            status_code=402,
            media_type='application/json',
        )

    # ── ESP32: the server runs in QEMU, reachable via slirp hostfwd. ──
    inst = esp_lib_manager.get_instance(client_id)
    if inst and inst.wifi_enabled and inst.wifi_hostfwd_port != 0:
        return await _proxy_esp32(inst, path, request)

    # ── Pico W: the server runs in the browser-side lwIP, reachable only
    #    by injecting TCP frames over the WebSocket bridge into the chip. ──
    picow = picow_net_manager.get_instance(client_id)
    if picow is not None and picow.wifi_enabled:
        return await _proxy_picow(picow, path, request)

    return Response(
        content='{"error":"No WiFi-enabled board found for this client. Make sure your sketch connected to WiFi and started a server on port 80."}',
        status_code=404,
        media_type='application/json',
    )


async def _proxy_esp32(inst, path: str, request: Request) -> Response:
    """Reverse-proxy to an ESP32 web server via QEMU slirp hostfwd."""
    target_url = f'http://127.0.0.1:{inst.wifi_hostfwd_port}/{path}'
    body = await request.body()

    # Forward relevant headers (skip hop-by-hop)
    skip_headers = {'host', 'transfer-encoding', 'connection'}
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in skip_headers
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                content=body,
                headers=headers,
            )
    except httpx.ConnectError:
        return Response(
            content='{"error":"ESP32 HTTP server is not responding. Make sure your sketch starts a WebServer on port 80."}',
            status_code=502,
            media_type='application/json',
        )
    except httpx.TimeoutException:
        return Response(
            content='{"error":"ESP32 HTTP server timed out"}',
            status_code=504,
            media_type='application/json',
        )

    # Forward response back to browser
    resp_headers = dict(resp.headers)
    # Remove hop-by-hop headers
    for h in ('transfer-encoding', 'connection', 'content-encoding'):
        resp_headers.pop(h, None)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp_headers,
        media_type=resp.headers.get('content-type'),
    )


# Hop-by-hop / per-connection headers we never forward verbatim.
_HOP_BY_HOP = {'host', 'transfer-encoding', 'connection', 'content-encoding',
               'keep-alive', 'proxy-connection', 'upgrade'}


async def _proxy_picow(bridge, path: str, request: Request) -> Response:
    """Reverse-proxy to a Pico W web server living in the browser-side lwIP.

    There is no host-side socket to connect to — the server only exists
    inside the simulated chip — so we hand-build a raw HTTP/1.1 request and
    have the picow_net stack open a TCP connection INTO the chip over the
    WebSocket bridge, then parse the raw response back out."""
    body = await request.body()
    query = request.url.query
    target = '/' + path + (('?' + query) if query else '')

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }
    headers['Host'] = STA_IP
    headers['Connection'] = 'close'   # make the chip's server FIN when done
    if body and 'content-length' not in {k.lower() for k in headers}:
        headers['Content-Length'] = str(len(body))

    req_line = f'{request.method} {target} HTTP/1.1\r\n'
    header_block = ''.join(f'{k}: {v}\r\n' for k, v in headers.items())
    raw_request = (req_line + header_block + '\r\n').encode('latin-1') + body

    try:
        raw_response = await bridge.http_into_chip(raw_request, timeout=12.0)
    except Exception:
        logger.exception('[picow-gateway] request into chip failed')
        raw_response = None

    if not raw_response:
        return Response(
            content='{"error":"Pico W HTTP server did not respond. Make sure your sketch connected to WiFi and is listening on port 80."}',
            status_code=502,
            media_type='application/json',
        )

    status, resp_headers, resp_body = _parse_http_response(raw_response)
    for h in ('transfer-encoding', 'connection', 'content-encoding',
              'content-length', 'keep-alive'):
        resp_headers.pop(h, None)
    media_type = resp_headers.pop('content-type', None) or 'text/html'

    return Response(
        content=resp_body,
        status_code=status,
        headers=resp_headers,
        media_type=media_type,
    )


def _parse_http_response(raw: bytes) -> tuple[int, dict, bytes]:
    """Split a raw HTTP/1.x response into (status, headers, body). Headers
    are returned with lower-cased keys (so callers can pop reliably)."""
    sep = raw.find(b'\r\n\r\n')
    sep_len = 4
    if sep < 0:
        sep = raw.find(b'\n\n')
        sep_len = 2
    if sep < 0:
        # No header terminator — treat the whole thing as a body.
        return 200, {}, raw

    head = raw[:sep].decode('latin-1', 'replace')
    resp_body = raw[sep + sep_len:]
    lines = head.replace('\r\n', '\n').split('\n')

    status = 200
    parts = lines[0].split(' ', 2)
    if len(parts) >= 2 and parts[1].isdigit():
        status = int(parts[1])

    headers: dict = {}
    for line in lines[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers, resp_body
