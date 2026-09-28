import { diff, layoutHints, summarize, type Author, type El, type ShapeSummary } from "./summarize.js";
import { findTemplate, scaffold } from "./templates.js";

export type ShapeType = "rectangle" | "ellipse" | "diamond" | "arrow" | "line" | "text" | "frame";

export interface AIShape {
  id: string;
  type: ShapeType;
  x?: number; y?: number; width?: number; height?: number;
  label?: string;
  text?: string;
  reason?: string;
  start?: { id: string };
  end?: { id: string };
  /** frames: ids of shapes it contains (default: whatever lies fully inside it) */
  children?: string[];
  strokeColor?: string;
  backgroundColor?: string;
}

export interface Question { id: string; text: string; options?: string[]; multi?: boolean }
export interface ChatMsg { author: Author; text: string; timestamp: string; questions?: Question[]; interjection?: true }
export type InputMode = "voice" | "text" | "canvas_only";
export interface Board { id: string; name: string; elements: El[]; template?: string }
type Tagged = ShapeSummary & { board: string };

export interface UserTurn {
  status: "turn";
  input_mode: InputMode;
  message: string;
  board: { id: string; name: string; template?: string };
  /** conventions of the tab's template; sent whenever the full canvas is */
  template_guide?: string;
  /** the user asked to restructure this tab toward a template */
  apply_template?: { id: string; name: string; guide: string; example?: string; shapes: AIShape[] };
  boards: { id: string; name: string; shapes: number }[];
  changes: ReturnType<typeof diff>;
  canvas?: ShapeSummary[];
  canvas_omitted?: string;
  layout_hints: ReturnType<typeof layoutHints>;
  recent_chat: ChatMsg[];
  selected_ids: string[];
  answers?: { id: string; question: string; answer: string | string[] }[];
  rejected_ai_turn?: true;
  /** the user cut the AI's speech short, so they may not have heard all of it */
  interrupted_ai?: true;
  done?: true;
  /** base64 PNG of the canvas; returned to the agent as image content, not JSON */
  image?: string;
}

export interface Failure { id: string; reason: string }

/** The user paused mid-turn with the mic on: what they've said so far, so the agent may interject. */
export interface Listening {
  status: "listening";
  partial_message: string;
  new_since_last: string;
  board: { id: string; name: string };
  selected_ids: string[];
}

const LINEAR = new Set(["arrow", "line"]);
const CHAT_WINDOW = 20;

export class Session {
  boards: Board[] = [{ id: "b1", name: "Main", elements: [] }];
  /** board the user was on at their last turn end */
  active = "b1";
  chat: ChatMsg[] = [];
  turn: "user" | "ai" = "user";
  /** set once a Done turn has been handed to the agent */
  finishing = false;
  tokens = { in: 0, out: 0 };
  private baseline = new Map<string, number>();
  private aliasOf = new Map<string, string>(); // excalidraw id -> agent-facing id
  private idOf = new Map<string, string>(); // agent-facing id -> excalidraw id
  private nextUser = 1;
  private aiShapes = new Map<string, AIShape>();
  private queue: UserTurn[] = [];
  private waiter: ((t: UserTurn | Listening | null) => void) | null = null;
  private heard = ""; // partial transcript already handed to the agent this turn
  /** payload diet: the agent already has the full canvas for this board unless this is unset */
  private agentSaw: string | null = null;

  id: string;
  project = process.cwd();
  createdAt = new Date().toISOString();

  constructor(public title: string) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
    this.id = `${slug}-${this.createdAt.slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-")}`;
  }

  /** Everything needed to resume later; the baseline is rebuilt from the elements on load. */
  toJSON() {
    return {
      id: this.id, title: this.title, project: this.project, createdAt: this.createdAt, updatedAt: new Date().toISOString(),
      boards: this.boards, active: this.active, chat: this.chat, nextUser: this.nextUser, tokens: this.tokens,
      aliases: [...this.aliasOf], aiShapes: [...this.aiShapes],
    };
  }

  static fromJSON(d: ReturnType<Session["toJSON"]> & { elements?: El[] }) {
    const s = new Session(d.title);
    Object.assign(s, { id: d.id, project: d.project, createdAt: d.createdAt, chat: d.chat, nextUser: d.nextUser });
    s.boards = d.boards ?? [{ id: "b1", name: "Main", elements: d.elements ?? [] }]; // pre-tabs sessions had one flat list
    s.active = d.active ?? s.boards[0].id;
    s.tokens = d.tokens ?? { in: 0, out: 0 };
    s.aliasOf = new Map(d.aliases);
    s.idOf = new Map(d.aliases.map(([ex, a]) => [a, ex]));
    s.aiShapes = new Map(d.aiShapes);
    s.baseline = s.snapshot().versions;
    return s;
  }

  get elements() { return this.boards.flatMap((b) => b.elements); }

  board(ref: string) {
    const r = ref.trim().toLowerCase();
    return this.boards.find((b) => b.id === ref || b.name.toLowerCase() === r);
  }

  addBoard(name: string) {
    let n = this.boards.length + 1;
    while (this.boards.some((b) => b.id === `b${n}`)) n++;
    const b = { id: `b${n}`, name: name.trim() || `Diagram ${n}`, elements: [] };
    this.boards.push(b);
    return b;
  }

  /** The browser owns tab add/rename/delete; it sends the full list. */
  setBoards(list: { id: string; name: string; template?: string }[]) {
    if (!list.length) return;
    this.boards = list.map((x) => {
      const old = this.boards.find((b) => b.id === x.id);
      return { id: x.id, name: x.name, elements: old?.elements ?? [], template: findTemplate(x.template)?.id ?? old?.template };
    });
    if (!this.board(this.active)) this.active = this.boards[0].id;
  }

  alias = (exId: string): string => {
    let a = this.aliasOf.get(exId);
    if (!a) {
      // AI shapes are claimed (id -> itself) on commit, so anything unmapped was drawn by the user
      do a = `u${this.nextUser++}`; while (this.idOf.has(a));
      this.aliasOf.set(exId, a);
      this.idOf.set(a, exId);
    }
    return a;
  };

  /** Pre-register an AI-chosen id so it maps to itself. */
  private claim(agentId: string) {
    this.aliasOf.set(agentId, agentId);
    this.idOf.set(agentId, agentId);
  }

  setElements(boardId: string, els: El[]) {
    const b = this.board(boardId) ?? this.boards[0];
    b.elements = els.filter((e) => !e.isDeleted);
  }

  /** All boards are summarized (ids are session-wide); `shapes` is just the requested board. */
  snapshot(boardId = this.active) {
    const all: Tagged[] = [];
    const versions = new Map<string, number>();
    for (const b of this.boards) {
      const r = summarize(b.elements, this.alias);
      for (const s of r.shapes) all.push({ ...s, board: b.id });
      r.versions.forEach((v, k) => versions.set(k, v));
    }
    const shapes = all.filter((s) => s.board === boardId).map(({ board: _, ...s }) => s);
    return { all, shapes, versions, layout_hints: layoutHints(shapes) };
  }

  boardList() {
    const { all } = this.snapshot();
    return this.boards.map((b) => ({ id: b.id, name: b.name, shapes: all.filter((s) => s.board === b.id).length }));
  }

  recentChat(n = CHAT_WINDOW) {
    return this.chat.slice(-n);
  }

  addChat(author: Author, text: string, questions?: Question[]) {
    const m: ChatMsg = { author, text, timestamp: new Date().toISOString(), ...(questions?.length && { questions }) };
    this.chat.push(m);
    return m;
  }

  /** Forget what the agent has seen (new agent, resumed session, or context may have been compacted). */
  resetAgentView() { this.agentSaw = null; }

  /** Called when the browser ends the user's turn. */
  userTurn(input_mode: InputMode, message: string, boardId: string, els: El[], extra: {
    selected?: string[]; image?: string; done?: boolean; answers?: { id: string; answer: string | string[] }[]; rejected?: boolean;
    applyTemplate?: string; interrupted?: boolean;
  } = {}) {
    this.heard = "";
    if (this.board(boardId)) this.active = this.board(boardId)!.id;
    this.setElements(this.active, els);
    const { all, shapes, versions, layout_hints } = this.snapshot();
    const changes = diff(all, versions, this.baseline);
    this.baseline = versions;

    const asked = [...this.chat].reverse().find((m) => m.author === "ai")?.questions ?? [];
    const answers = (extra.answers ?? []).flatMap((a) => {
      const q = asked.find((x) => x.id === a.id);
      return q ? [{ id: a.id, question: q.text, answer: a.answer }] : [];
    });
    let text = message.trim();
    if (!text && answers.length) text = answers.map((a) => [a.answer].flat().join(", ")).join("; ");
    const applying = findTemplate(extra.applyTemplate);
    if (!text && applying) text = `Please restructure this diagram to follow the "${applying.name}" template.`;
    const msg = text ? this.addChat("user", text) : null;
    this.turn = "ai";

    // Payload diet: the full canvas only when the agent hasn't seen this board, or much of it changed.
    const churn = changes.added.length + changes.modified.length + changes.deleted_ids.length;
    const full = this.agentSaw !== this.active || churn > Math.max(6, shapes.length * 0.4);
    const first = this.agentSaw === null;
    this.agentSaw = this.active;
    const b = this.board(this.active)!;
    const apply = findTemplate(extra.applyTemplate);
    if (apply) b.template = apply.id;
    const tpl = findTemplate(b.template);

    const turn: UserTurn = {
      status: "turn", input_mode, message: text,
      board: { id: b.id, name: b.name, ...(b.template && { template: b.template }) }, boards: this.boardList(),
      ...(full && tpl && !apply && { template_guide: tpl.guide }),
      ...(apply && { apply_template: { id: apply.id, name: apply.name, guide: apply.guide, ...(apply.example && { example: apply.example }), shapes: apply.shapes } }),
      changes,
      ...(full ? { canvas: shapes } : { canvas_omitted: "Unchanged apart from `changes`. Call get_canvas_snapshot if you lost track." }),
      layout_hints,
      recent_chat: this.recentChat(first ? CHAT_WINDOW : 3),
      selected_ids: (extra.selected ?? []).map(this.alias).filter((a) => shapes.some((s) => s.id === a)),
      ...(answers.length && { answers }),
      ...(extra.rejected && { rejected_ai_turn: true as const }),
      ...(extra.interrupted && { interrupted_ai: true as const }),
      ...(extra.done && { done: true as const }),
      ...(extra.image && { image: extra.image }),
    };
    if (this.waiter) { this.waiter(turn); this.waiter = null; } else this.queue.push(turn);
    return msg;
  }

  /**
   * The user paused while still talking. Only delivered if the agent is waiting right now; otherwise it's
   * dropped (the full turn arrives when they stop). Returns whether the agent got it.
   */
  partial(message: string, boardId: string, selected: string[]) {
    const text = message.trim();
    if (!this.waiter || this.turn !== "user" || !text || text === this.heard) return false;
    const fresh = text.startsWith(this.heard) ? text.slice(this.heard.length).trim() : text;
    this.heard = text;
    const b = this.board(boardId) ?? this.board(this.active)!;
    this.active = b.id; // they're talking about the tab they're on
    const { shapes } = this.snapshot(b.id);
    this.waiter({
      status: "listening", partial_message: text, new_since_last: fresh, board: { id: b.id, name: b.name },
      selected_ids: selected.map(this.alias).filter((a) => shapes.some((s) => s.id === a)),
    });
    this.waiter = null;
    return true;
  }

  /** Agent ids -> excalidraw ids without checking they exist yet (shapes drawn this turn keep their own ids). */
  exIds(ids: string[]) { return ids.map((a) => this.idOf.get(a) ?? a); }

  /** Agent ids on a board -> excalidraw ids, for highlighting. Unknown ids are dropped. */
  resolveIds(boardId: string, ids: string[]) {
    const { shapes } = this.snapshot(boardId);
    return ids.filter((a) => shapes.some((s) => s.id === a)).map((a) => this.idOf.get(a) ?? a);
  }

  /** Resolves with the next user turn (or a mid-turn partial), or null on timeout/abort. */
  nextTurn(timeoutMs: number, signal?: AbortSignal): Promise<UserTurn | Listening | null> {
    const queued = this.queue.shift();
    if (queued) { if (queued.done) this.finishing = true; return Promise.resolve(queued); }
    this.waiter?.(null); // only one waiter at a time; the older call gets still_waiting
    return new Promise((resolve) => {
      const done = (t: UserTurn | Listening | null) => {
        clearTimeout(timer); signal?.removeEventListener("abort", onAbort);
        if (t?.status === "turn" && t.done) this.finishing = true;
        resolve(t);
      };
      const onAbort = () => { if (this.waiter === done) this.waiter = null; done(null); };
      const timer = setTimeout(onAbort, timeoutMs);
      signal?.addEventListener("abort", onAbort);
      this.waiter = done;
    });
  }

  end() {
    this.waiter?.(null);
    this.waiter = null;
  }

  /**
   * Validate an AI turn against current state and resolve agent ids to excalidraw ids.
   * Valid items are returned for the browser; invalid ones are reported back to the agent.
   */
  prepareAiTurn(boardRef: string | undefined, templateRef: string | undefined, newShapes: AIShape[], updates: { id: string; changes: Partial<AIShape> }[], deleteIds: string[]) {
    let board = boardRef ? this.board(boardRef) : this.board(this.active);
    const createdBoard = !board;
    const lone = this.boards.length === 1 && !this.boards[0].elements.length ? this.boards[0] : undefined;
    if (!board && lone) { lone.name = boardRef!.trim(); board = lone; } // first named diagram: rename the empty default tab
    else if (!board) board = this.addBoard(boardRef!);
    const { all, shapes, layout_hints } = this.snapshot(board.id);
    const tpl = findTemplate(templateRef);
    const templateFailed: Failure[] = templateRef && !tpl ? [{ id: "template", reason: `unknown template "${templateRef}"; see list_templates` }] : [];
    if (tpl) {
      board.template = tpl.id;
      // starter shapes only on an empty tab and only when the agent isn't drawing its own version of it
      if (!shapes.length && !newShapes.length) newShapes = scaffold(tpl, `${board.id}_`);
    }
    const byAlias = new Map(shapes.map((s) => [s.id, s]));
    const elsewhere = new Map(all.filter((s) => s.board !== board!.id).map((s) => [s.id, s.board]));
    const failed: Failure[] = [...templateFailed];
    const known = new Set(byAlias.keys());
    const ex = (a: string) => this.idOf.get(a) ?? a;
    const missing = (ref: string) => {
      const other = elsewhere.has(ref) && this.board(elsewhere.get(ref)!)?.name;
      return other ? `"${ref}" is on the "${other}" tab: arrows can't cross tabs; to change it, make a separate submit_ai_turn with board:"${other}"`
        : `"${ref}" does not exist on this diagram`;
    };
    const inCall = new Set(newShapes.map((s) => s.id));
    const refsOk = (s: AIShape, extra: Set<string>): string | null => {
      for (const k of ["start", "end"] as const) {
        const ref = s[k]?.id;
        if (ref === undefined) continue;
        if (!LINEAR.has(s.type)) return `${k} is only valid on arrows/lines`;
        if (!known.has(ref) && !extra.has(ref)) return `${k}.id ${missing(ref)}`;
        const t = byAlias.get(ref)?.type;
        if (t && LINEAR.has(t)) return `${k}.id "${ref}" is an ${t}; point arrows at shapes or sketches, not other arrows`;
      }
      for (const c of s.children ?? []) {
        if (s.type !== "frame") return "children is only valid on frames";
        if (!known.has(c) && !inCall.has(c)) return `child ${missing(c)}`;
      }
      return null;
    };
    const resolveRefs = (s: AIShape): AIShape => ({
      ...s,
      ...(s.start && { start: { id: ex(s.start.id) } }),
      ...(s.end && { end: { id: ex(s.end.id) } }),
      ...(s.children && { children: s.children.map(ex) }),
    });

    const create: AIShape[] = [];
    const batch = new Set<string>();
    const fr = layout_hints.free_region;
    let auto = 0;
    for (const s of newShapes) {
      const err =
        !s.id ? "missing id"
        : s.id.includes("__") ? 'ids may not contain "__"'
        : known.has(s.id) || batch.has(s.id) || elsewhere.has(s.id) || (this.idOf.has(s.id) && this.idOf.get(s.id) !== s.id)
          ? `id "${s.id}" already exists; use update_shapes or pick a new id`
        : s.type === "text" && !s.text ? 'type "text" requires "text"'
        : refsOk(s, batch);
      if (err) { failed.push({ id: s.id ?? "?", reason: err }); continue; }
      const spec = { ...s };
      if (!LINEAR.has(s.type) && (spec.x === undefined || spec.y === undefined)) {
        // ponytail: simple 3-column grid in the free region when the agent omits coordinates
        spec.x ??= fr.x + (auto % 3) * 220;
        spec.y ??= fr.y + Math.floor(auto / 3) * 140;
        auto++;
      }
      batch.add(s.id);
      create.push(resolveRefs(spec));
    }

    const update: AIShape[] = [];
    for (const u of updates) {
      const cur = byAlias.get(u.id);
      const err =
        !cur ? `id ${missing(u.id)}`
        : cur.type === "freedraw" ? "freehand drawings can only be deleted, not updated"
        : u.changes.type && u.changes.type !== cur.type ? "changing type is not supported; delete and re-create"
        : refsOk({ ...(cur as AIShape), ...u.changes }, batch);
      if (err) { failed.push({ id: u.id, reason: err }); continue; }
      const base: AIShape = {
        ...(this.aiShapes.get(u.id) ?? {}),
        id: u.id, type: cur!.type as ShapeType, x: cur!.x, y: cur!.y, width: cur!.width, height: cur!.height,
        label: cur!.type === "text" ? undefined : cur!.label, text: cur!.type === "text" ? cur!.label : undefined,
        reason: cur!.reason,
        start: cur!.from ? { id: cur!.from } : undefined, end: cur!.to ? { id: cur!.to } : undefined,
      };
      update.push(resolveRefs({ ...base, ...u.changes, id: ex(u.id) }));
    }

    const del: string[] = [];
    for (const id of deleteIds) {
      if (!known.has(id)) failed.push({ id, reason: `id ${missing(id)}` });
      else del.push(ex(id));
    }
    return { board: { id: board.id, name: board.name, created: createdBoard, ...(board.template && { template: board.template }) }, create, update, del, failed, guide: tpl?.guide, example: tpl?.example };
  }

  /** Browser has rendered the AI turn: adopt its scene and make it the new baseline. */
  commitAiTurn(boardId: string, create: AIShape[], update: AIShape[], els: El[], speech: string, questions?: Question[]) {
    for (const s of create) { this.claim(s.id); this.aiShapes.set(s.id, s); }
    for (const s of update) {
      const a = this.aliasOf.get(s.id) ?? s.id;
      if (this.aiShapes.has(a)) this.aiShapes.set(a, { ...s, id: a });
    }
    this.setElements(boardId, els);
    this.active = boardId;
    this.agentSaw = boardId; // it just drew here, so it knows this board
    this.baseline = this.snapshot().versions;
    this.turn = "user";
    return speech.trim() || questions?.length ? this.addChat("ai", speech.trim(), questions) : null;
  }
}
