// How the page talks to the daemon. Locally: WebSockets. Over remote HTTPS:
// Server-Sent Events plus POSTs, because iOS Safari applies an accepted
// self-signed certificate to pages and fetches but not to WebSockets.

export const REMOTE = location.protocol === 'https:';

export const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-agentmgr': '1' },
    body: JSON.stringify(body ?? {}),
  });

/**
 * Open the event stream (`{ events: true }`) or a terminal (`{ agentId, kind }`).
 * Handlers: onOpen(), onMessage(msg), onClose({ code, reason }) when it ends for good.
 * Returns { send(msg), close() } where msg is { t: 'i', d } (input) or { t: 'r', cols, rows } (resize).
 */
export function openStream({ events = false, agentId, kind = 'claude' }, h) {
  if (!REMOTE) {
    const path = events ? '/ws/events' : `/ws/term/${agentId}${kind === 'claude' ? '' : `?kind=${encodeURIComponent(kind)}`}`;
    const ws = new WebSocket(`ws://${location.host}${path}`);
    ws.onopen = () => h.onOpen?.();
    ws.onmessage = (ev) => h.onMessage(JSON.parse(ev.data));
    ws.onclose = (ev) => h.onClose?.({ code: ev.code, reason: ev.reason });
    return {
      send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
      close: () => ws.close(),
    };
  }

  const url = events ? '/api/events/stream' : `/api/agents/${agentId}/term/stream?kind=${encodeURIComponent(kind)}`;
  const es = new EventSource(url);
  let closed = false;
  es.onopen = () => h.onOpen?.();
  es.onmessage = (ev) => h.onMessage(JSON.parse(ev.data));
  es.onerror = () => {
    // CONNECTING means the browser is retrying by itself (network blip); CLOSED is final (e.g. 401).
    if (es.readyState === EventSource.CLOSED && !closed) {
      closed = true;
      h.onClose?.({ code: 0, reason: 'stream closed' });
    }
  };

  // Keystrokes: coalesced and sent strictly in order, one request at a time.
  let queue = '';
  let inflight = false;
  const pump = async () => {
    if (inflight || !queue) return;
    inflight = true;
    const d = queue;
    queue = '';
    try {
      await post(`/api/agents/${agentId}/term/input`, { d, kind });
    } finally {
      inflight = false;
      if (queue) pump();
    }
  };
  let resizeTimer;
  return {
    send(msg) {
      if (closed) return;
      if (msg.t === 'i') {
        queue += msg.d;
        setTimeout(pump, 8);
      } else if (msg.t === 'r') {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => post(`/api/agents/${agentId}/term/resize`, { cols: msg.cols, rows: msg.rows, kind }), 150);
      }
    },
    close() {
      closed = true;
      es.close();
    },
  };
}
