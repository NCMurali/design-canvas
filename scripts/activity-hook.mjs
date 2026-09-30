#!/usr/bin/env node
// Claude Code PreToolUse hook: tells a live design-canvas board what the agent is doing, so the user sees
// "Reading src/index.ts" instead of a silent spinner. It never blocks or fails a tool call: no board, no output.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

let port;
try { port = readFileSync(join(process.env.DESIGN_CANVAS_HOME ?? join(homedir(), ".design-canvas"), "port"), "utf8").trim(); }
catch { process.exit(0); } // no board open

let raw = "";
for await (const c of process.stdin) raw += c;
let e;
try { e = JSON.parse(raw); } catch { process.exit(0); }
const tool = String(e.tool_name ?? "");
const i = e.tool_input ?? {};
const short = (s, n = 70) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const file = (p) => (p ? basename(String(p)) : "a file");
const shapes = (i.new_shapes?.length ?? 0) + (i.update_shapes?.length ?? 0);

const text =
  tool === "Read" ? `Reading ${file(i.file_path)}`
  : tool === "Grep" ? `Searching the code for "${short(i.pattern, 50)}"`
  : tool === "Glob" ? `Looking for files: ${short(i.pattern, 50)}`
  : ["Edit", "Write", "NotebookEdit"].includes(tool) ? `Editing ${file(i.file_path ?? i.notebook_path)}`
  : ["Bash", "PowerShell"].includes(tool) ? `Running: ${short(i.description || i.command)}`
  : tool === "WebSearch" ? `Searching the web: ${short(i.query, 50)}`
  : tool === "WebFetch" ? `Reading ${short(i.url, 60)}`
  : ["Task", "Agent"].includes(tool) ? `Asking a helper: ${short(i.description)}`
  : tool === "mcp__design-canvas__submit_ai_turn" ? (shapes ? `Drawing ${shapes} shape${shapes > 1 ? "s" : ""}…` : "Replying…")
  : tool === "mcp__design-canvas__export_session" ? `Exporting ${i.format ?? ""}`
  : tool.startsWith("mcp__design-canvas__") ? "" // still sent: it tells the board which chat is driving it
  : `Using ${tool.replace(/^mcp__/, "").replace(/__/g, " › ")}`;

try {
  await fetch(`http://127.0.0.1:${port}/activity`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-design-canvas": "1" },
    body: JSON.stringify({ session_id: e.session_id, tool, text }),
    signal: AbortSignal.timeout(500),
  });
} catch { /* board closed: nothing to show */ }
