export type Msg = { type: string; [k: string]: any };

/** WebSocket to the MCP server with auto-reconnect. The server sends full `state` on every (re)connect. */
export function connect(onMsg: (m: Msg) => void, onStatus: (up: boolean) => void) {
  let ws: WebSocket | null = null;
  let delay = 500;
  let stopped = false;
  const open = () => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => { delay = 500; onStatus(true); };
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      onStatus(false);
      if (!stopped) setTimeout(open, (delay = Math.min(delay * 2, 5000)));
    };
  };
  open();
  return {
    send: (m: Msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
    stop: () => { stopped = true; ws?.close(); },
  };
}
