"""
Unit tests for the Pico W inbound IoT-gateway path.

The gateway lets a browser reach an HTTP server running inside the
browser-side lwIP of a simulated Pico W. The backend opens a TCP
connection INTO the chip (``tcp_inbound.TcpInbound``) over the WebSocket
bridge, sends a raw HTTP request, and parses the response back out.

These tests import the real modules (no re-implemented framing) so a
refactor of the stack surfaces here immediately:

  - the inbound TCP client drives a correct SYN → SYN+ACK → ACK →
    request → response → FIN exchange and returns the response bytes;
  - the gateway response parser splits status/headers/body;
  - the bridge learns the chip's real MAC via ARP before originating.
"""

from __future__ import annotations

import asyncio

import pytest

from app.services.picow_net.bridge import PicowNetBridge
from app.services.picow_net.consts import (
    GATEWAY_IP,
    STA_IP,
    STA_MAC,
    TCP_ACK,
    TCP_FIN,
    TCP_PSH,
    TCP_SYN,
    ip_to_bytes,
)
from app.services.picow_net.protocols import Ethernet, IPv4, TCP, Arp, make_frame_arp
from app.services.picow_net.tcp_inbound import (
    TcpInbound,
    _http_response_complete,
    _seq_add,
)
from app.api.routes.iot_gateway import _parse_http_response

_STA = ip_to_bytes(STA_IP)
_GW = ip_to_bytes(GATEWAY_IP)
CHIP_MAC = bytes.fromhex('0242da0000aa')


def _parse_injected_tcp(frame: bytes) -> TCP:
    eth = Ethernet.parse(frame)
    ip = IPv4.parse(eth.payload)
    return TCP.parse(ip.payload)


def _chip_seg(src_port: int, dst_port: int, seq: int, ack: int,
              flags: int, payload: bytes = b'') -> tuple[IPv4, TCP]:
    """A segment as if sent by the chip's server (STA:80 → gateway)."""
    ip = IPv4(protocol=6, src=_STA, dst=_GW)
    tcp = TCP(src_port=src_port, dst_port=dst_port, seq=seq, ack=ack,
              flags=flags, window=64240, payload=payload)
    return ip, tcp


async def _wait_until(pred, timeout=1.0):
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if pred():
            return True
        await asyncio.sleep(0.005)
    return False


@pytest.mark.asyncio
async def test_inbound_tcp_http_roundtrip():
    injected: list[bytes] = []

    async def inject(frame: bytes) -> None:
        injected.append(frame)

    tin = TcpInbound(inject, lambda: CHIP_MAC)

    request_bytes = b'GET /on HTTP/1.1\r\nHost: 10.13.37.42\r\nConnection: close\r\n\r\n'
    task = asyncio.create_task(tin.request(request_bytes, timeout=2.0))

    # 1. The client should inject a SYN to the chip's :80.
    assert await _wait_until(lambda: len(injected) >= 1)
    syn = _parse_injected_tcp(injected[0])
    assert syn.flags & TCP_SYN and not (syn.flags & TCP_ACK)
    assert syn.dst_port == 80
    ephport = syn.src_port
    our_isn = syn.seq

    # 2. Reply with SYN+ACK; expect the client to ACK and then send the request.
    chip_isn = 7000
    ip, tcp = _chip_seg(80, ephport, seq=chip_isn, ack=_seq_add(our_isn, 1),
                        flags=TCP_SYN | TCP_ACK)
    await tin.handle_chip_segment(ip, tcp)

    assert await _wait_until(
        lambda: any(_parse_injected_tcp(f).payload == request_bytes for f in injected))
    # The handshake ACK must have gone out before the request.
    assert any(_parse_injected_tcp(f).flags & TCP_ACK for f in injected)

    # 3. Send the HTTP response, then FIN (a length-less, close-delimited body —
    #    the common MicroPython "socket then conn.close()" shape).
    response = (b'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n'
                b'<html><body>LED ON</body></html>')
    ip, tcp = _chip_seg(80, ephport, seq=_seq_add(chip_isn, 1),
                        ack=0, flags=TCP_PSH | TCP_ACK, payload=response)
    await tin.handle_chip_segment(ip, tcp)
    ip, tcp = _chip_seg(80, ephport, seq=_seq_add(chip_isn, 1 + len(response)),
                        ack=0, flags=TCP_FIN | TCP_ACK)
    await tin.handle_chip_segment(ip, tcp)

    result = await asyncio.wait_for(task, timeout=2.0)
    assert result == response
    # The client must close cleanly: a FIN should have been injected.
    assert any(_parse_injected_tcp(f).flags & TCP_FIN for f in injected)


@pytest.mark.asyncio
async def test_inbound_returns_none_when_chip_never_answers():
    async def inject(frame: bytes) -> None:
        pass

    tin = TcpInbound(inject, lambda: CHIP_MAC)
    # No SYN+ACK ever arrives → request gives up (short SYN timeout path).
    result = await tin.request(b'GET / HTTP/1.1\r\n\r\n', timeout=0.5)
    assert result is None


def test_http_response_complete_by_content_length():
    full = b'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello'
    assert _http_response_complete(bytearray(full))
    # One byte short → not complete.
    assert not _http_response_complete(bytearray(full[:-1]))
    # No declared length → relies on FIN/idle, never "complete" here.
    assert not _http_response_complete(bytearray(b'HTTP/1.1 200 OK\r\n\r\nhi'))


def test_parse_http_response_splits_status_headers_body():
    raw = (b'HTTP/1.1 404 Not Found\r\n'
           b'Content-Type: application/json\r\n'
           b'X-Foo: bar\r\n\r\n'
           b'{"missing":true}')
    status, headers, body = _parse_http_response(raw)
    assert status == 404
    assert headers['content-type'] == 'application/json'
    assert headers['x-foo'] == 'bar'
    assert body == b'{"missing":true}'


@pytest.mark.asyncio
async def test_ensure_chip_mac_primes_gateway_arp():
    """ensure_chip_mac emits an ARP for the STA (priming the chip's gateway
    lookup) and returns the chip MAC. The chip's on-wire MAC is
    deterministically STA_MAC, so the default is already the right target."""
    sent: list[tuple[str, dict]] = []

    async def emit(event: str, data: dict) -> None:
        sent.append((event, data))

    bridge = PicowNetBridge('sess::pico', emit, wifi_enabled=True)
    mac = await bridge.ensure_chip_mac()
    assert mac == STA_MAC

    # An ARP request for the STA, sourced from the gateway, must have gone out.
    injected = [d['ether_b64'] for e, d in sent if e == 'picow_packet_in']
    assert injected, 'ensure_chip_mac should inject an ARP'
    import base64
    eth = Ethernet.parse(base64.b64decode(injected[0]))
    assert eth.ethertype == 0x0806
    arp = Arp.parse(eth.payload)
    assert arp.opcode == 1 and bytes(arp.tpa) == _STA


@pytest.mark.asyncio
async def test_bridge_tracks_chip_mac_from_outbound_frame():
    """If the chip ever sends an outbound frame, the bridge adopts its src
    MAC (used as the destination for injected replies)."""
    async def emit(event: str, data: dict) -> None:
        pass

    bridge = PicowNetBridge('sess::pico', emit, wifi_enabled=True)
    assert bridge._chip_mac == STA_MAC
    # A gratuitous ARP from a chip that happens to use a different MAC.
    reply = Arp(opcode=2, sha=CHIP_MAC, spa=_STA, tha=STA_MAC, tpa=_GW)
    await bridge.deliver_packet_out(make_frame_arp(STA_MAC, CHIP_MAC, reply))
    assert bridge._chip_mac == CHIP_MAC
