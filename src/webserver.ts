import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const UI_DIR = resolve(fileURLToPath(import.meta.url), "../../ui/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

export type Msg = { type: string; [k: string]: any };

export interface Web {
  url: string;
  port: number;
  broadcast(msg: Msg): void;
  clientCount(): number;
  /** Broadcast a message with a reqId and resolve with the first reply carrying the same reqId. */
  request(msg: Msg, timeoutMs: number): Promise<Msg>;
  close(): Promise<void>;
}

function listen(server: Server, port: number) {
  return new Promise<number>((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", fail);
      ok((server.address() as { port: number }).port);
    });
  });
}

export async function startWeb(onMessage: (msg: Msg, ws: WebSocket) => void, onConnect: (ws: WebSocket) => void, onActivity: (a: Msg) => void = () => {}): Promise<Web> {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (req.method === "POST") {
      // Harness hooks report the agent's tool calls here. A web page can't send the custom header without a CORS
      // preflight, which is never granted, so other sites can't post to it.
      if (path !== "/activity" || req.headers["x-design-canvas"] !== "1") return void res.writeHead(403).end();
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on("end", () => { try { onActivity(JSON.parse(body)); } catch { /* not JSON: ignore */ } res.writeHead(204).end(); });
      return;
    }
    let file = resolve(join(UI_DIR, path));
    if (!file.startsWith(UI_DIR + sep) || !extname(file)) file = join(UI_DIR, "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found (did you run `npm run build`?)");
    }
  });

  let port: number;
  try { port = await listen(server, 4173); } catch { port = await listen(server, 0); }
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  // Only our own page may connect; stops other websites in the browser from reading or driving the session.
  const wss = new WebSocketServer({ server, path: "/ws", verifyClient: ({ origin }: { origin: string }) => origins.has(origin) });
  const pending = new Map<string, (m: Msg) => void>();

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg: Msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.reqId && pending.has(msg.reqId)) { pending.get(msg.reqId)!(msg); pending.delete(msg.reqId); return; }
      onMessage(msg, ws);
    });
    onConnect(ws);
  });

  const broadcast = (msg: Msg) => {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  };

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    broadcast,
    clientCount: () => [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN).length,
    request(msg, timeoutMs) {
      const reqId = randomUUID();
      return new Promise((ok, fail) => {
        const t = setTimeout(() => { pending.delete(reqId); fail(new Error(`browser did not answer "${msg.type}" within ${timeoutMs / 1000}s`)); }, timeoutMs);
        pending.set(reqId, (m) => { clearTimeout(t); ok(m); });
        broadcast({ ...msg, reqId });
      });
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      const closed = new Promise((ok) => server.close(ok));
      server.closeAllConnections();
      await closed;
    },
  };
}

export function openBrowser(url: string) {
  if (process.env.DESIGN_CANVAS_NO_OPEN) return;
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  // stdio must not inherit: stdout belongs to the MCP protocol
  spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).on("error", (e) => console.error("[design-canvas] could not open browser:", e.message)).unref();
}
