// Sessions persist as one JSON file each in a per-user folder shared by every harness,
// so a diagram started in one host (Claude Code, Desktop, Cursor…) can be resumed in another.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Session } from "./session.js";

export const SESSIONS_DIR = process.env.DESIGN_CANVAS_HOME
  ? join(process.env.DESIGN_CANVAS_HOME, "sessions")
  : join(homedir(), ".design-canvas", "sessions");

type Saved = ReturnType<Session["toJSON"]>;

export function saveSession(s: Session) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = join(SESSIONS_DIR, `${s.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(s));
  renameSync(`${file}.tmp`, file); // atomic replace: a crash never leaves a half-written session
}

function readAll(): Saved[] {
  let files: string[];
  try { files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")); } catch { return []; }
  // ponytail: reads every file per call; fine for hundreds of sessions, add an index file beyond that
  return files.flatMap((f) => { try { return [JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8")) as Saved]; } catch { return []; } })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listSessions(query?: string, limit = 10) {
  const q = query?.toLowerCase();
  const here = process.cwd();
  return readAll()
    .filter((d) => !q || d.title.toLowerCase().includes(q) || d.id.includes(q) || d.project.toLowerCase().includes(q))
    .slice(0, limit)
    .map((d) => ({
      id: d.id, title: d.title, project: d.project, this_project: d.project === here, updated_at: d.updatedAt,
      shapes: (d.boards?.flatMap((b) => b.elements) ?? (d as { elements?: typeof d.boards[0]["elements"] }).elements ?? []).filter((e) => !e.containerId && !e.customData?.reasonFor).length,
      diagrams: d.boards?.map((b) => b.name) ?? ["Main"],
      last_message: d.chat.at(-1)?.text.slice(0, 120),
    }));
}

/** Exact id, "last" (newest here, else newest anywhere), or a title substring (newest match). */
export function findSession(ref: string): Session | null {
  const all = readAll();
  const r = ref.trim().toLowerCase();
  const d = r === "last" || r === "latest"
    ? all.find((x) => x.project === process.cwd()) ?? all[0]
    : all.find((x) => x.id === ref) ?? all.find((x) => x.title.toLowerCase().includes(r));
  return d ? Session.fromJSON(d) : null;
}
