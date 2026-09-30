#!/usr/bin/env node
// design-canvas MCP server. Pure plumbing: no LLM calls. The harness's own model does the thinking.
// stdout carries the MCP protocol, so every log goes to stderr.
import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Session, type AIShape, type Question } from "./session.js";
import { startWeb, openBrowser, type Web, type Msg } from "./webserver.js";
import { excalidrawFile, markdown, mermaidDoc, needsBrowser, outPath, pdf, pptx, type Format } from "./export.js";
import { findSession, listSessions, markClosed, markLive, saveSession, SESSIONS_DIR } from "./store.js";
import { TEMPLATES } from "./templates.js";

const log = (...a: unknown[]) => console.error("[design-canvas]", ...a);
const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

let session: Session | null = null;
let web: Web | null = null;

// Debounced save so live scene syncs don't hit the disk on every stroke.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist(now = false) {
  clearTimeout(saveTimer);
  const s = session;
  if (!s) return;
  const write = () => { try { saveSession(s); } catch (e) { log("could not save session:", (e as Error).message); } };
  if (now) write(); else saveTimer = setTimeout(write, 1000);
}

// ---- token meter ---------------------------------------------------------------------------
// The server can't see the harness's real usage, but it knows exactly what it hands the model (tool
// results) and what the model sends it (tool arguments). ~4 chars per token; images by pixel count.
let turnTokens = { in: 0, out: 0 };
let lastTurn = { in: 0, out: 0 };
const est = (chars: number) => Math.ceil(chars / 4);
function imageTokens(b64: string) {
  try {
    const b = Buffer.from(b64.slice(0, 44), "base64");
    return Math.ceil(Math.min(b.readUInt32BE(16) * b.readUInt32BE(20), 1568 * 1568) / 750);
  } catch { return 1500; }
}
function meter(args: unknown, result: { content: { type: string; text?: string; data?: string }[] }) {
  if (!session) return;
  const out = est(JSON.stringify(args ?? {}).length);
  const inn = result.content.reduce((n, c) => n + (c.type === "image" ? imageTokens(c.data ?? "") : est(c.text?.length ?? 0)), 0);
  session.tokens.in += inn; session.tokens.out += out;
  turnTokens.in += inn; turnTokens.out += out;
  web?.broadcast({ type: "tokens", turn: turnTokens, last: lastTurn, total: session.tokens });
}

// Claude Code hooks (scripts/activity-hook.mjs) report each tool call the agent makes, so the board can show
// "Reading src/index.ts" instead of a silent spinner. Only the chat that drives this board counts: it's the one
// calling design-canvas tools.
let owner: string | undefined;
function onActivity(a: Msg) {
  if (!session || !web || typeof a.session_id !== "string") return;
  if (String(a.tool ?? "").startsWith("mcp__design-canvas__")) owner = a.session_id;
  if (a.session_id !== owner || session.turn !== "ai" || typeof a.text !== "string" || !a.text) return;
  web.broadcast({ type: "status", text: a.text.slice(0, 160) });
}

function onMessage(msg: Msg) {
  if (!session || !web) return;
  persist();
  if (msg.type === "scene") session.setElements(String(msg.board ?? session.active), msg.elements ?? []);
  else if (msg.type === "boards" && Array.isArray(msg.boards)) session.setBoards(msg.boards);
  else if (msg.type === "user_partial") session.partial(String(msg.message ?? ""), String(msg.board ?? session.active), Array.isArray(msg.selected) ? msg.selected : []);
  else if (msg.type === "user_turn") {
    if (Array.isArray(msg.boards)) session.setBoards(msg.boards);
    const chat = session.userTurn(msg.input_mode ?? "text", String(msg.message ?? ""), String(msg.board ?? session.active), msg.elements ?? [], {
      selected: Array.isArray(msg.selected) ? msg.selected : [],
      image: typeof msg.image === "string" ? msg.image : undefined,
      done: msg.done === true,
      answers: Array.isArray(msg.answers) ? msg.answers : [],
      rejected: msg.rejected === true,
      applyTemplate: typeof msg.apply_template === "string" ? msg.apply_template : undefined,
      interrupted: msg.interrupted === true,
    });
    if (chat) web.broadcast({ type: "chat", message: chat });
    web.broadcast({ type: "turn", turn: "ai" });
  }
}

const shape = z.object({
  id: z.string().describe("Your stable id for this shape; reuse it in later turns to update/delete or bind arrows"),
  type: z.enum(["rectangle", "ellipse", "diamond", "arrow", "line", "text", "frame"]),
  x: z.number().optional(), y: z.number().optional(),
  width: z.number().optional(), height: z.number().optional(),
  label: z.string().optional().describe("Text inside a rectangle/ellipse/diamond, on an arrow, or a frame's title"),
  text: z.string().optional().describe('Content for type "text"'),
  reason: z.string().optional().describe("One short sentence on WHY you added/changed this. Shown in a card when the user selects the shape; they can edit it."),
  start: z.object({ id: z.string() }).optional().describe("Arrow/line: id of the shape it starts at (user or AI id)"),
  end: z.object({ id: z.string() }).optional().describe("Arrow/line: id of the shape it points to"),
  children: z.array(z.string()).optional().describe("Frame only: ids of shapes inside it. Default: shapes lying fully inside the frame"),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
});

const INSTRUCTIONS =
  "design-canvas is a shared whiteboard for talking through architecture and design with the user, like two engineers at a whiteboard. " +
  "Use it whenever the user wants to sketch, whiteboard, diagram, draw, or visually discuss a system/design, even if they don't name this tool " +
  '(e.g. "let\'s whiteboard this", "draw the architecture", "open the canvas"). ' +
  "Start with start_design_session, then loop wait_for_user_turn / submit_ai_turn until the user is done. " +
  "A session holds several diagrams as tabs (architecture, request flow, deployment, data flow…); pass `board` to submit_ai_turn to draw on or create one, " +
  "and `template` to start it from a standard notation (C4, three-tier, sequence, DFD, Kubernetes, UML, ERD… see list_templates). " +
  "Ask the user questions only when the answer would materially change the design and you can't reasonably infer it; otherwise state your assumption and keep going. " +
  "Be a senior-engineer teammate, not a diagram generator: when given a topic, first put a sample/first-draft diagram on the board (a template helps), " +
  "then let the discussion lead: probe requirements and scale, point out risks and failure modes, compare alternatives, push back when something's off, " +
  "and draw only when it clarifies the point or the user asks. Point at shapes you're talking about with highlight_ids. " +
  "Before a turn that takes a while, say one sentence first (show_status with say:true). Record decisions in `notes` so later chats keep the reasoning. " +
  "Diagrams are saved automatically: when the user wants to continue an earlier diagram " +
  '("continue the URL shortener design", "open my last diagram"), call list_design_sessions if needed, then start_design_session with resume.';

const server = new McpServer({ name: "design-canvas", version: "0.6.0" }, { instructions: INSTRUCTIONS });

// Meter every tool call in one place. ponytail: wraps registerTool instead of each handler.
const register = server.registerTool.bind(server);
(server as any).registerTool = (name: string, cfg: unknown, handler: (a: any, e: any) => Promise<any>) =>
  register(name, cfg as any, (async (a: any, e: any) => {
    const r = await handler(a, e);
    meter(a, r);
    if (name === "submit_ai_turn" && !r.isError) { // a turn ends with the AI's reply
      lastTurn = turnTokens; turnTokens = { in: 0, out: 0 };
      web?.broadcast({ type: "tokens", turn: turnTokens, last: lastTurn, total: session?.tokens });
    }
    return r;
  }) as any); // every tool here declares an inputSchema, so the SDK always calls (args, extra)

server.registerPrompt("design", {
  title: "Design on the whiteboard",
  description: "Open the shared design canvas (optionally on a topic, or resuming a saved diagram) and run the turn loop.",
  argsSchema: {
    topic: z.string().optional().describe("What to design, e.g. 'URL shortener'"),
    resume: z.string().optional().describe("Saved session to continue: id, title words, or 'last'"),
  },
}, ({ topic, resume }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text: resume
        ? `Resume my saved design-canvas diagram "${resume}" (call start_design_session with resume="${resume}"; if it isn't found, show me list_design_sessions and ask). ` +
          "Briefly recap where we left off, then run the whiteboard loop until I say I'm done, and offer an export at the end."
        : `Open a design-canvas whiteboard session${topic ? ` titled "${topic}" to design ${topic}` : ""}. ` +
          "Run the whiteboard loop until I say I'm done, then offer an export.",
    },
  }],
}));

server.registerTool("list_design_sessions", {
  title: "List saved design sessions",
  description:
    "List saved whiteboard sessions (newest first) so the user can pick one to resume with start_design_session({resume}). " +
    "Every session is saved automatically after each turn. `this_project` marks sessions started from the current working directory.",
  inputSchema: {
    query: z.string().optional().describe("Filter by title, id or project path"),
    limit: z.number().int().min(1).max(50).optional(),
  },
}, async ({ query, limit }) => json({ sessions: listSessions(query, limit), folder: SESSIONS_DIR }));

server.registerTool("start_design_session", {
  title: "Start design session",
  description:
    "Open a shared whiteboard + chat in the user's browser for a turn-based architecture/design discussion. " +
    "THE LOOP: call this once, then alternate wait_for_user_turn -> submit_ai_turn -> wait_for_user_turn ... " +
    'Whenever wait_for_user_turn returns {status:"still_waiting"}, simply call it again (the user is still drawing/talking). ' +
    "Keep looping until the user says they are done; then offer export_session and call end_session. " +
    "Sessions are saved automatically; pass `resume` to reopen a saved one (see list_design_sessions). " +
    "If a session is already running this returns its URL instead of starting another.",
  inputSchema: {
    title: z.string().optional().describe("Shown in the page header"),
    resume: z.string().optional().describe("Reopen a saved session: its id, words from its title, or 'last'"),
  },
}, async ({ title, resume }) => {
  if (session && web) {
    session.resetAgentView(); // possibly a different agent/chat: send it the full canvas next turn
    return json({ url: web.url, id: session.id, title: session.title, boards: session.boardList(), already_running: true, note: "Call end_session first to switch sessions." });
  }
  if (resume) {
    const found = findSession(resume);
    if (!found) return fail(`No saved session matches "${resume}". Saved sessions: ${JSON.stringify(listSessions(undefined, 10))}`);
    session = found;
  } else session = new Session(title || "Design session");
  const s = session;
  turnTokens = { in: 0, out: 0 }; lastTurn = { in: 0, out: 0 };
  web = await startWeb(onMessage, (ws) => ws.send(JSON.stringify({
    type: "state", title: s.title, boards: s.boards, active: s.active, chat: s.chat, turn: s.turn, tokens: { turn: turnTokens, last: lastTurn, total: s.tokens },
    templates: TEMPLATES,
  })), onActivity);
  markLive(web.port);
  openBrowser(web.url);
  log("session at", web.url);
  persist(true);
  const snap = s.snapshot();
  return json({
    url: web.url, id: s.id, title: s.title, resumed: !!resume, boards: s.boardList(),
    ...(resume && { canvas: snap.shapes, layout_hints: snap.layout_hints, ...(s.notes.length && { notes: s.notes }), recent_chat: s.recentChat() }),
    next: resume
      ? "Tell the user the URL, give a one-line recap of the saved diagrams, then call wait_for_user_turn."
      : "Tell the user the URL (it was opened in their browser). If they already said what to design, put a first-draft sample diagram on the board now " +
        "with submit_ai_turn (pick a fitting template if one exists) and invite them to discuss it; otherwise call wait_for_user_turn.",
  });
});

server.registerTool("wait_for_user_turn", {
  title: "Wait for user turn",
  description:
    "Block until the user finishes their turn (sends a chat/voice message, answers your questions, or presses End turn), then return it. " +
    "Fields: message; board (the diagram tab they're on) and boards (all tabs); changes since the last turn (added/modified/deleted_ids, across all tabs, each tagged with its board); " +
    "canvas = compact shapes of the current board, sent only when you haven't seen this board yet or much changed (otherwise canvas_omitted: " +
    "apply `changes` to what you know, or call get_canvas_snapshot if unsure / after your context was compacted); layout_hints; recent_chat (short). " +
    "Shape ids like u1, u2 are user-drawn; other ids are yours. Arrows bound at both ends carry only from/to (no coordinates). `in` = the frame a shape sits in. " +
    "A shape's `reason` is its why-card text (the user may have edited it). " +
    "selected_ids are the shapes the user had selected: when they say \"this\"/\"these\", they mean those. " +
    "answers: replies to the questions you asked. rejected_ai_turn: true means the user undid your last changes; don't redo them without asking. " +
    "board.template / template_guide: the tab follows a standard notation; keep to its conventions. apply_template: the user picked a template for " +
    "this existing tab; restructure what's there toward it (reuse and relabel the user's shapes via update_shapes rather than deleting them, " +
    "follow its guide, its reference layout in apply_template.shapes and its canonical example if given, add only what's missing), then say briefly what you changed. " +
    "When freehand sketches changed, an image of the canvas is attached: read the sketch from it. " +
    "If the turn has done:true the user pressed Done and has left: do NOT ask anything. Send one short goodbye via submit_ai_turn, " +
    "run any export they already asked for, then call end_session. " +
    "interrupted_ai: true means they cut your last reply short, so they may have missed its end: don't assume they heard it all. " +
    '{status:"listening"} means the user paused mid-thought with the mic still on: partial_message is what they have said so far (new_since_last is the new part). ' +
    "Usually just call wait_for_user_turn again to keep listening. Only if something important can't wait (a wrong assumption, a real risk, a misunderstanding), " +
    "interject like a teammate would: submit_ai_turn with interject:true and ONE short sentence (plus highlight_ids to point); then keep listening. Interject rarely. " +
    'Returns {status:"still_waiting"} after timeout_seconds with no turn: just call this tool again. ' +
    "After getting a turn, respond with submit_ai_turn (use show_status for progress if you need a while).",
  inputSchema: { timeout_seconds: z.number().min(1).max(3600).optional().describe("Default 50 (stays under common ~60s host tool timeouts)") },
}, async ({ timeout_seconds }, extra) => {
  if (!session || !web) return fail("No session running. Call start_design_session first.");
  // agent skipped submit: unlock the user (unless a turn is already queued: that one is the AI's to answer now)
  if (session.turn === "ai" && !session.queued) { session.turn = "user"; web.broadcast({ type: "turn", turn: "user" }); }
  const token = extra._meta?.progressToken;
  let n = 0;
  const beat = token === undefined ? null : setInterval(() => {
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message: "waiting for the user's turn" } })
      .catch(() => {});
  }, 10_000);
  try {
    const turn = await session.nextTurn((timeout_seconds ?? 50) * 1000, extra.signal);
    if (!session) return json({ status: "ended" });
    if (!turn) return json({ status: "still_waiting", hint: "Call wait_for_user_turn again." });
    if (turn.status === "listening") return json(turn);
    const { image, ...rest } = turn;
    const out = json(rest);
    return image ? { content: [...out.content, { type: "image" as const, data: image, mimeType: "image/png" }] } : out;
  } finally {
    if (beat) clearInterval(beat);
  }
});

server.registerTool("show_status", {
  title: "Show status",
  description:
    "While you work on your turn (reading code, weighing options, planning a diagram), show the user one short line about what you're doing, " +
    'e.g. "Comparing Kafka vs SQS for the event bus". Shown live on the board. Use it for anything taking more than a few seconds; ' +
    "a summary of your progress, not raw reasoning. Call submit_ai_turn when done. " +
    'say: true also speaks it: use that at the start of a turn that will take a while, e.g. "Let me split that into three rows."',
  inputSchema: { text: z.string().max(200), say: z.boolean().optional().describe("Also speak it aloud") },
}, async ({ text, say }) => {
  if (!session || !web) return fail("No session running.");
  web.broadcast({ type: "status", text, ...(say && { say: true }) });
  return json({ ok: true });
});

server.registerTool("submit_ai_turn", {
  title: "Submit AI turn",
  description:
    "Take your turn: speech_text appears in the chat and is spoken aloud; shapes are drawn on the shared canvas in a distinct AI color. " +
    "Talk like a senior engineer at a whiteboard: conversational, 1-4 sentences. " +
    "If this turn will take more than a few seconds (several shapes, reading code), first call show_status with say:true and one short " +
    "sentence on what you're about to do, so the user isn't left waiting in silence. " +
    "After you draw, the result includes an image of the board: if shapes overlap, labels are cut off or arrows cross boxes, " +
    "fix it right away with another submit_ai_turn (speech_text \"\") before waiting. " +
    "notes: record key decisions, assumptions and open questions (one line each); they come back on resume and after your context is compacted. Not every turn needs shapes: after the first draft, discussing " +
    "(questions about requirements, risks, trade-offs, alternatives, pushing back) is often the better turn; draw when it clarifies or when asked. " +
    "highlight_ids: shapes you're talking about; while you speak, each one glows during the sentence that mentions it (by its label or id), " +
    "like pointing at the board, so name the shapes you point at. " +
    "interject: true only to cut in while the user is still talking (after a {status:\"listening\"} result): one short sentence, no shapes. " +
    "Questions: only ask when the answer would materially change the design and you can't reasonably infer it from the conversation, " +
    "the canvas or common practice. Otherwise make a sensible assumption, say it in one clause (e.g. 'assuming Postgres'), and keep drawing; " +
    "the user corrects you if needed. When you do ask, use `questions` (usually one; at most 3), each with 2-4 short `options`; " +
    "they become clickable chips and come back as `answers`. Don't repeat the question in speech_text. " +
    "Give EVERY new or changed shape a `reason` (one short sentence on why); the user sees it when they select the shape and can edit it. " +
    "Diagrams: `board` picks the tab to draw on (id or name; default the user's current tab); a new name creates a tab, e.g. \"Deployment\" or " +
    "\"Checkout flow\". Keep one kind of diagram per tab. " +
    "`template` (see list_templates) sets the tab's notation and the result includes its guide. If you pass no new_shapes on an empty tab, " +
    "it also adds the template's generic starter shapes (ids prefixed with the tab id, e.g. b2_api) for you to relabel; when you draw your own " +
    "design, just follow the notation. " +
    "Use frames (type frame, with a label) for zones like VPCs, regions, clusters, or swimlanes. " +
    "Layout: place new shapes in layout_hints.free_region or near what they relate to; typical box 160x80. Arrow labels sit mid-arrow, " +
    "so keep >= 120px vertical and >= 200px horizontal between boxes, and avoid routing arrows through other boxes. " +
    "Arrows: set start.id/end.id to existing shape ids on the same tab (user ids like u1 work) or to ids created earlier in this same call; geometry is computed for you. " +
    "update_shapes merges changes into existing shapes (yours or the user's); delete_shape_ids removes them. " +
    "Returns which ids were applied and which failed with a reason. Then call wait_for_user_turn.",
  inputSchema: {
    speech_text: z.string().describe("What you say this turn"),
    board: z.string().optional().describe("Tab to draw on: existing id/name, or a new name to create it"),
    template: z.string().optional().describe("Template id/name for this tab (see list_templates)"),
    new_shapes: z.array(shape).optional(),
    update_shapes: z.array(z.object({ id: z.string(), changes: shape.partial().omit({ id: true }) })).optional(),
    delete_shape_ids: z.array(z.string()).optional(),
    notes: z.array(z.string().max(300)).max(5).optional().describe("Decisions, assumptions or open questions worth remembering in later chats; appended to the session's design notes"),
    highlight_ids: z.array(z.string()).max(12).optional().describe("Shapes to point at while speaking"),
    interject: z.boolean().optional().describe("Cut in while the user is still talking (after status:listening); speech only"),
    questions: z.array(z.object({
      id: z.string(),
      text: z.string(),
      options: z.array(z.string()).max(6).optional(),
      multi: z.boolean().optional().describe("Allow picking several options"),
    })).max(3).optional(),
  },
}, async ({ speech_text, board, template, new_shapes = [], update_shapes = [], delete_shape_ids = [], questions, highlight_ids = [], interject, notes }) => {
  if (!session || !web) return fail("No session running. Call start_design_session first.");
  if (!web.clientCount()) return fail(`No browser is connected. Ask the user to open ${web.url}, then call submit_ai_turn again.`);
  if (notes?.length) session.addNotes(notes);
  if (interject) {
    // A teammate cutting in: speech (+ pointing) only, and the user keeps their turn.
    const b = board ? session.board(board) : session.board(session.active);
    const chat = session.addChat("ai", speech_text.trim());
    chat.interjection = true;
    web.broadcast({ type: "ai_interject", speech_text, board: b?.id, highlight: b ? session.resolveIds(b.id, highlight_ids) : [], message: chat });
    persist();
    const ignored = new_shapes.length + update_shapes.length + delete_shape_ids.length + (questions?.length ?? 0);
    return json({ ok: true, interjected: true, ...(ignored && { note: "Shapes/questions are ignored when interjecting; save them for your turn." }), next: "Call wait_for_user_turn to keep listening." });
  }
  const t = session.prepareAiTurn(board, template, new_shapes as AIShape[], update_shapes as { id: string; changes: Partial<AIShape> }[], delete_shape_ids);
  let reply: Msg;
  try {
    reply = await web.request({ type: "ai_turn", speech_text, board: t.board, create: t.create, update: t.update, del: t.del, questions, highlight: session.exIds(highlight_ids) }, 15_000);
  } catch (e) {
    return fail(`${(e as Error).message}. Nothing was committed; call submit_ai_turn again.`);
  }
  const failed = [...t.failed, ...(reply.failed ?? [])];
  const bad = new Set(failed.map((f) => f.id));
  const chat = session.commitAiTurn(t.board.id, t.create.filter((s) => !bad.has(s.id)), t.update, reply.elements ?? [], speech_text, questions as Question[] | undefined);
  if (chat) web.broadcast({ type: "chat", message: chat });
  persist(true);
  const render = typeof reply.image === "string" ? reply.image : undefined;
  const out = json({
    ok: failed.length === 0,
    board: t.board,
    ...(t.guide && { template_guide: t.guide }),
    ...(t.example && { template_example: t.example }),
    applied: { created: t.create.map((s) => s.id).filter((id) => !bad.has(id)), updated: update_shapes.map((u) => u.id).filter((id) => !bad.has(id)), deleted: delete_shape_ids.filter((id) => !bad.has(id)) },
    failed,
    ...(render && { render: "Attached: the board as it looks now. Fix any overlaps or crossings before waiting." }),
    next: session.finishing ? "The user pressed Done: call end_session now (after any export they asked for); don't wait for another turn." : "Call wait_for_user_turn.",
  });
  return render ? { content: [...out.content, { type: "image" as const, data: render, mimeType: "image/png" }] } : out;
});

server.registerTool("list_templates", {
  title: "List diagram templates",
  description:
    "Standard diagram templates (C4 context/containers with the canonical Big Bank plc example, three-tier, microservices, event-driven, " +
    "threat-model DFD, sequence, Kubernetes, flowchart, UML activity/state, ERD, swimlanes), each with its notation's conventions. " +
    "Pass an id as `template` to submit_ai_turn to start a tab the standard way, or to adopt a notation on an existing tab.",
  inputSchema: {},
}, async () => json({ templates: TEMPLATES.map(({ id, name, kind, description, guide, source }) => ({ id, name, kind, description, guide, source })) }));

server.registerTool("get_canvas_snapshot", {
  title: "Get canvas snapshot",
  description: "Return the full compact canvas of a diagram tab (default: the user's current one), the tab list, layout_hints and recent chat, without waiting for a turn.",
  inputSchema: { board: z.string().optional().describe("Tab id or name") },
}, async ({ board }) => {
  if (!session) return fail("No session running.");
  const b = board ? session.board(board) : session.board(session.active);
  if (!b) return fail(`No tab "${board}". Tabs: ${JSON.stringify(session.boardList())}`);
  const { shapes, layout_hints } = session.snapshot(b.id);
  return json({ title: session.title, turn: session.turn, board: { id: b.id, name: b.name }, boards: session.boardList(), canvas: shapes, layout_hints, notes: session.notes, recent_chat: session.recentChat() });
});

server.registerTool("export_session", {
  title: "Export session",
  description:
    "Save the session to a file. png/svg/excalidraw: one diagram tab (default: the current one; pass `board`). " +
    "markdown: design log with every tab (components, connections with reasons, a Mermaid diagram each) plus the transcript: good for turning into docs or code. " +
    "mermaid: just the Mermaid diagrams (one per tab) in a .md file that GitHub renders. pdf / pptx: one page/slide image per tab, then components, connections and transcript. " +
    "Default location: the current working directory. png/svg/pdf/pptx need the browser tab to be open.",
  inputSchema: {
    format: z.enum(["png", "svg", "excalidraw", "markdown", "mermaid", "pdf", "pptx"]),
    path: z.string().optional().describe("File path or existing directory"),
    board: z.string().optional().describe("Tab id or name (png/svg/excalidraw)"),
  },
}, async ({ format, path, board }) => {
  if (!session || !web) return fail("No session running.");
  const s = session;
  const b = board ? s.board(board) : s.board(s.active);
  if (!b) return fail(`No tab "${board}". Tabs: ${JSON.stringify(s.boardList())}`);
  const file = await outPath(format as Format, path);
  const image = async (boardId: string, fmt: "png" | "svg") => {
    const r = await web!.request({ type: "export_request", format: fmt, board: boardId }, 20_000);
    if (r.error) throw new Error(r.error);
    return r.data as string;
  };
  let data: string | Buffer;
  try {
    if (needsBrowser(format as Format) && !web.clientCount()) return fail(`No browser connected; ask the user to open ${web.url} and retry.`);
    if (format === "svg") data = await image(b.id, "svg");
    else if (format === "png") data = Buffer.from(await image(b.id, "png"), "base64");
    else if (format === "pdf" || format === "pptx") {
      const pngs: { board: string; png: Buffer }[] = [];
      for (const x of s.boards) {
        if (!x.elements.length) continue;
        pngs.push({ board: x.name, png: Buffer.from(await image(x.id, "png"), "base64") });
      }
      data = format === "pdf" ? await pdf(s, pngs) : await pptx(s, pngs);
    } else if (format === "markdown") data = markdown(s);
    else if (format === "mermaid") data = mermaidDoc(s);
    else data = excalidrawFile(s, b.id);
  } catch (e) {
    return fail(`Export failed: ${(e as Error).message}`);
  }
  await writeFile(file, data);
  return json({ ok: true, path: file });
});

server.registerTool("end_session", {
  title: "End session",
  description:
    "Close the whiteboard. The session stays saved and can be reopened later with start_design_session({resume}). " +
    "Before calling, offer the user an export (export_session) if they want files.",
  inputSchema: {},
}, async () => {
  if (!session || !web) return json({ ok: true, note: "No session was running." });
  web.broadcast({ type: "session_ended" });
  markClosed(web.port);
  persist(true);
  session.end();
  await web.close();
  session = null;
  web = null;
  return json({ ok: true, saved: true });
});

await server.connect(new StdioServerTransport());
log("MCP server ready (stdio)");
process.stdin.on("close", () => { web?.close().finally(() => process.exit(0)); if (!web) process.exit(0); });
