/**
 * Serial raw byte exporter — opens a WebSocket to a local Java server
 * and streams every transmitted byte as a binary frame (Uint8Array).
 * Connection is lazy: opens on first `send()`, reconnects on drop.
 * Bytes arriving before the connection opens are buffered and flushed
 * on the next `onopen`. If the buffer fills, oldest bytes are dropped.
 *
 * Also listens for inbound binary frames from the Java server and
 * forwards them to the simulator via a registered callback.
 */

const SERIAL_RAW_WS_URL = 'ws://localhost:8765/serial';
const RECONNECT_INTERVAL_MS = 1000; // Intervalo fijo de reintentos

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let onByteReceived: ((byte: number) => void) | null = null;
let stopped = false;
/** Bytes enqueued before the connection is open — flushed on next `onopen`. */
let pendingBytes: number[] = [];
const PENDING_BYTES_MAX = 1024; // 1 KB safety cap (comparable to UART FIFO)

function connect(): void {
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(SERIAL_RAW_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // Flush any bytes that arrived before the connection opened
    if (pendingBytes.length > 0) {
      for (const b of pendingBytes) {
        try {
          ws.send(new Uint8Array([b]));
        } catch {
          break;
        }
      }
      pendingBytes = [];
    }
  };

  ws.onclose = () => {
    ws = null;
    if (!stopped) scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after onerror; no-op here.
  };

  ws.onmessage = (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(event.data);
    for (let i = 0; i < bytes.length; i++) {
      onByteReceived?.(bytes[i]);
    }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer || stopped) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_INTERVAL_MS);
}

/**
 * Send a single raw byte (0–255) over WebSocket.
 * Opens connection lazily on first call. Bytes arriving before the
 * connection opens are buffered and flushed on the next `onopen`.
 */
export function sendSerialRawByte(byte: number): void {
  if (stopped) return;
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(new Uint8Array([byte]));
    } catch {
      // Socket closed underneath us — reconnect on next call.
      ws = null;
      if (pendingBytes.length < PENDING_BYTES_MAX) pendingBytes.push(byte & 0xff);
      connect();
    }
    return;
  }
  // Connection not yet open — buffer the byte and start connecting.
  if (pendingBytes.length < PENDING_BYTES_MAX) pendingBytes.push(byte & 0xff);
  connect();
}

/**
 * Register a callback for incoming raw bytes from the Java server.
 * Each byte is forwarded as a `number` (0–255).
 */
export function setOnByteReceived(callback: (byte: number) => void): void {
  onByteReceived = callback;
}

/** Stop the exporter (called on page unload or explicit teardown). */
export function stopSerialRawExporter(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  ws?.close();
  ws = null;
  pendingBytes = [];
}

/** Restart the exporter after a previous stop. */
export function startSerialRawExporter(): void {
  stopped = false;
}
