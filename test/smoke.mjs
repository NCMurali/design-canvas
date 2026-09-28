// Server plumbing check: real MCP client over stdio + a fake browser over WebSocket. Run: npm test (after npm run build)
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const home = mkdtempSync(join(tmpdir(), "dc-home-"));
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: ["dist/index.js"], env: { ...process.env, DESIGN_CANVAS_NO_OPEN: "1", DESIGN_CANVAS_HOME: home }, stderr: "ignore",
}));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
};

const { url } = await call("start_design_session", { title: "Smoke" });
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal((await call("start_design_session")).already_running, true);
assert.equal((await fetch(url)).status, 200);

// A foreign origin must be refused.
await assert.rejects(new Promise((ok, fail) => {
  const w = new WebSocket(url.replace("http", "ws") + "/ws", { origin: "http://evil.example" });
  w.on("open", ok); w.on("error", fail);
}));

const ws = new WebSocket(url.replace("http", "ws") + "/ws", { origin: url });
const inbox = [];
ws.on("message", (d) => inbox.push(JSON.parse(d)));
await new Promise((ok) => ws.on("open", ok));
const next = async (type) => {
  for (let i = 0; i < 100; i++) {
    const k = inbox.findIndex((m) => m.type === type);
    if (k >= 0) return inbox.splice(k, 1)[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no ${type}`);
};
assert.equal((await next("state")).title, "Smoke");

const rect = { id: "xk2", type: "rectangle", x: 0, y: 0, width: 100, height: 60, version: 1 };
const label = { id: "t1", type: "text", containerId: "xk2", text: "API", x: 10, y: 10, width: 30, height: 20, version: 1 };

assert.equal((await call("wait_for_user_turn", { timeout_seconds: 1 })).status, "still_waiting");

// Turn sent while nobody waits is queued.
ws.send(JSON.stringify({ type: "user_turn", input_mode: "text", message: "add a cache", elements: [rect, label], selected: ["xk2"], image: "iVBORw0KGgo=" }));
await next("turn");
const raw = await client.callTool({ name: "wait_for_user_turn", arguments: { timeout_seconds: 5 } });
assert.deepEqual(raw.content[1], { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
const turn = JSON.parse(raw.content[0].text);
assert.deepEqual(turn.selected_ids, ["u1"]);
assert.equal(turn.image, undefined);
assert.equal(turn.status, "turn");
assert.equal(turn.message, "add a cache");
assert.deepEqual(turn.canvas.map((s) => [s.id, s.label, s.author]), [["u1", "API", "user"]]);
assert.equal(turn.changes.added.length, 1);
assert.ok(turn.layout_hints.free_region.x > 100);

// Fake browser: render by echoing plain elements for created shapes.
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type !== "ai_turn") return;
  const made = m.create.map((s) => ({
    id: s.id, type: s.type, x: s.x ?? 0, y: s.y ?? 0, width: 10, height: 10, version: 1, customData: { author: "ai" },
    ...(s.start && { startBinding: { elementId: s.start.id } }), ...(s.end && { endBinding: { elementId: s.end.id } }),
    ...(s.type === "frame" && { name: s.label }),
  }));
  for (const f of m.create.filter((s) => s.children)) for (const e of made) if (f.children.includes(e.id)) e.frameId = f.id;
  const notes = m.create.filter((s) => s.reason).map((s) => ({ id: `${s.id}__reason`, type: "text", text: s.reason, x: 0, y: 0, width: 1, height: 1, version: 1, customData: { author: "ai", reasonFor: s.id } }));
  ws.send(JSON.stringify({ reqId: m.reqId, board: m.board.id, elements: [...(m.board.id === "b1" ? [rect, label] : []), ...made, ...notes], failed: [] }));
});

const r = await call("submit_ai_turn", {
  speech_text: "Adding a cache in front.",
  new_shapes: [
    { id: "cache", type: "rectangle", x: 300, y: 0, label: "Redis", reason: "hot reads" },
    { id: "a1", type: "arrow", start: { id: "u1" }, end: { id: "cache" } },
    { id: "bad", type: "arrow", start: { id: "nope" }, end: { id: "cache" } },
  ],
});
assert.deepEqual(r.applied.created, ["cache", "a1"]);
assert.equal(r.failed[0].id, "bad");
assert.match(r.failed[0].reason, /does not exist/);

const snap = await call("get_canvas_snapshot");
const a1 = snap.canvas.find((s) => s.id === "a1");
assert.deepEqual([a1.from, a1.to], ["u1", "cache"]);
assert.equal(snap.canvas.find((s) => s.id === "cache").reason, "hot reads");
assert.equal(snap.canvas.length, 3); // the reason note is folded into its shape
assert.deepEqual(snap.recent_chat.map((c) => c.author), ["user", "ai"]);

// A canvas-only turn right after: nothing changed since the AI turn.
ws.send(JSON.stringify({ type: "user_turn", input_mode: "canvas_only", message: "", elements: [rect, label] }));
const t2 = await call("wait_for_user_turn", { timeout_seconds: 5 });
assert.deepEqual(t2.changes.deleted_ids.sort(), ["a1", "cache"]);
assert.equal(t2.done, undefined);
ws.send(JSON.stringify({ type: "user_turn", input_mode: "text", message: "I'm done.", elements: [rect, label], done: true }));
assert.equal((await call("wait_for_user_turn", { timeout_seconds: 5 })).done, true);
assert.ok(inbox.some((m) => m.type === "tokens" && m.total.in > 0 && m.total.out > 0));

// Second diagram tab, a frame, and a question with options.
assert.equal((await call("show_status", { text: "Sketching the deployment" })).ok, true);
assert.equal((await next("status")).text, "Sketching the deployment");
const d = await call("submit_ai_turn", {
  speech_text: "Deployment view.", board: "Deployment",
  new_shapes: [
    { id: "svc", type: "rectangle", x: 20, y: 40, label: "Service", reason: "runs the API" },
    { id: "vpc", type: "frame", x: 0, y: 0, width: 300, height: 200, label: "VPC", children: ["svc"] },
    { id: "x1", type: "arrow", start: { id: "svc" }, end: { id: "u1" } },
  ],
  questions: [{ id: "q1", text: "Which cloud?", options: ["AWS", "GCP"] }],
});
assert.equal(d.board.name, "Deployment");
assert.equal(d.board.created, true);
assert.match(d.failed.find((f) => f.id === "x1").reason, /on the "Main" tab/);
ws.send(JSON.stringify({ type: "user_turn", input_mode: "text", message: "", board: d.board.id, elements: [], answers: [{ id: "q1", answer: "AWS" }] }));
const t3 = await call("wait_for_user_turn", { timeout_seconds: 5 });
assert.equal(t3.board.name, "Deployment");
assert.deepEqual(t3.boards.map((b) => b.name), ["Main", "Deployment"]);
assert.deepEqual(t3.answers, [{ id: "q1", question: "Which cloud?", answer: "AWS" }]);
assert.equal(t3.message, "AWS");
assert.deepEqual(t3.changes.deleted_ids.sort(), ["svc", "vpc"]); // the (fake) browser sent an empty Deployment scene

// Mid-turn: a pause sends what was said so far; the agent may cut in (speech only), and the user keeps the floor.
const waiting = call("wait_for_user_turn", { timeout_seconds: 5 });
await new Promise((r) => setTimeout(r, 200));
ws.send(JSON.stringify({ type: "user_partial", message: "so the cache sits in front of", board: "b1", selected: ["xk2"] }));
const heard = await waiting;
assert.equal(heard.status, "listening");
assert.equal(heard.new_since_last, "so the cache sits in front of");
assert.deepEqual(heard.selected_ids, ["u1"]);
const cut = await call("submit_ai_turn", { speech_text: "Which cache, Redis?", interject: true, highlight_ids: ["u1", "nope"] });
assert.equal(cut.interjected, true);
const ij = await next("ai_interject");
assert.deepEqual(ij.highlight, ["xk2"]);
assert.equal(ij.message.interjection, true);
ws.send(JSON.stringify({ type: "user_turn", input_mode: "voice", message: "so the cache sits in front of the API", board: "b1", elements: [rect, label], interrupted: true }));
const t5 = await call("wait_for_user_turn", { timeout_seconds: 5 });
assert.equal(t5.interrupted_ai, true);

// Templates: catalogue, starter shapes on a new tab, and "apply to existing tab" as a normal turn.
const { templates } = await call("list_templates");
assert.ok(templates.length >= 13);
assert.ok(templates.some((t) => t.id === "erd" && /CC BY 4.0/.test(t.source)));
const k8s = await call("submit_ai_turn", { speech_text: "Cluster view.", board: "Cluster", template: "kubernetes" });
assert.equal(k8s.board.template, "kubernetes");
assert.ok(k8s.applied.created.includes(`${k8s.board.id}_ing`));
assert.match(k8s.template_guide, /Ingress/);
ws.send(JSON.stringify({ type: "user_turn", input_mode: "text", message: "", board: "b1", elements: [rect, label], apply_template: "c4-container" }));
const t4 = await call("wait_for_user_turn", { timeout_seconds: 5 });
assert.equal(t4.board.template, "c4-container");
assert.match(t4.message, /C4 · Containers/);
assert.match(t4.apply_template.example, /Big Bank plc/);
assert.ok(t4.apply_template.shapes.length > 5);

const dir = mkdtempSync(join(tmpdir(), "dc-"));
const md = await call("export_session", { format: "markdown", path: dir });
assert.ok(readFileSync(md.path, "utf8").includes("add a cache"));
const mm = readFileSync((await call("export_session", { format: "mermaid", path: dir })).path, "utf8");
assert.match(mm, /## Main[\s\S]*flowchart LR[\s\S]*n_u1\["API"\]/);
const ex = await call("export_session", { format: "excalidraw", path: join(dir, "x.excalidraw"), board: "Main" });
assert.equal(JSON.parse(readFileSync(ex.path, "utf8")).type, "excalidraw");

assert.equal((await call("end_session")).ok, true);
await assert.rejects(fetch(url));

// Saved on end; resumable by title words, with the AI's ids and the user's aliases intact.
const { sessions } = await call("list_design_sessions");
assert.equal(sessions.length, 1);
assert.equal(sessions[0].title, "Smoke");
assert.match((await call("start_design_session", { resume: "nope" })).error, /No saved session/);
const back = await call("start_design_session", { resume: "smo" });
assert.equal(back.resumed, true);
assert.deepEqual(back.boards.map((b) => b.name), ["Main", "Deployment", "Cluster"]);
assert.ok(back.recent_chat.length >= 3);
await call("end_session");

const prompts = await client.listPrompts();
assert.ok(prompts.prompts.some((p) => p.name === "design"));
const pr = await client.getPrompt({ name: "design", arguments: { resume: "last" } });
assert.match(pr.messages[0].content.text, /resume="last"/);
rmSync(dir, { recursive: true });
rmSync(home, { recursive: true });
await client.close();
console.log("smoke ok");
