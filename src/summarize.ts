// Excalidraw elements -> compact summaries the agent reads. No Excalidraw type dependency on purpose.

export type Author = "user" | "ai";

export interface El {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted?: boolean;
  containerId?: string | null;
  text?: string;
  points?: [number, number][];
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  boundElements?: { id: string; type: string }[] | null;
  customData?: { author?: Author; reasonFor?: string; reason?: string; from?: string; to?: string };
  [k: string]: unknown;
}

export interface ShapeSummary {
  id: string;
  type: string;
  /** omitted for arrows bound at both ends: from/to says everything and saves tokens */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  reason?: string;
  from?: string;
  to?: string;
  /** id of the frame (zone) this shape sits in */
  in?: string;
  author: Author;
}

export interface Box { x: number; y: number; width: number; height: number }

export const isBoundText = (e: El) => e.type === "text" && !!e.containerId;
// Excalidraw stores wrapped text in `text`; `originalText` is what was typed. Line breaks are layout, not content.
const plain = (e?: El) => (((e?.originalText as string | undefined) ?? e?.text) || "").replace(/\s+/g, " ").trim() || undefined;

export function bbox(e: El): Box {
  if (e.points?.length) {
    const xs = e.points.map((p) => p[0]), ys = e.points.map((p) => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { x: e.x + minX, y: e.y + minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }
  return { x: e.x, y: e.y, width: e.width, height: e.height };
}

/**
 * Summaries plus a per-shape version (max of the shape, its label and its reason note),
 * so edits to a label or reason count as a modification of the owning shape.
 */
export function summarize(els: El[], alias: (exId: string) => string) {
  const live = els.filter((e) => !e.isDeleted);
  const ids = new Set(live.map((e) => e.id));
  const labels = new Map<string, El>();
  const reasons = new Map<string, El>();
  for (const e of live) {
    if (isBoundText(e)) labels.set(e.containerId!, e);
    const rf = e.customData?.reasonFor;
    if (rf && ids.has(rf)) reasons.set(rf, e);
  }
  const shapes: ShapeSummary[] = [];
  const versions = new Map<string, number>();
  for (const e of live) {
    if (isBoundText(e) || e.type === "selection") continue;
    const rf = e.customData?.reasonFor;
    if (rf && ids.has(rf)) continue; // folded into its owner
    const b = bbox(e);
    const s: ShapeSummary = {
      id: alias(e.id),
      type: e.type,
      x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height),
      author: e.customData?.author ?? "user",
    };
    const labelEl = labels.get(e.id);
    const label = e.type === "frame" || e.type === "magicframe" ? (e.name as string | undefined)?.trim() || undefined : plain(e.type === "text" ? e : labelEl);
    if (label) s.label = label;
    const reasonEl = reasons.get(e.id);
    const reason = plain(reasonEl) ?? (e.customData?.reason?.trim() || undefined);
    if (reason) s.reason = reason;
    const from = e.startBinding?.elementId ?? e.customData?.from, to = e.endBinding?.elementId ?? e.customData?.to;
    if (from && ids.has(from)) s.from = alias(from);
    if (to && ids.has(to)) s.to = alias(to);
    if (s.from && s.to) { delete s.x; delete s.y; delete s.width; delete s.height; }
    const frameId = e.frameId as string | null | undefined;
    if (frameId && ids.has(frameId)) s.in = alias(frameId);
    shapes.push(s);
    versions.set(s.id, Math.max(e.version, labelEl?.version ?? 0, reasonEl?.version ?? 0));
  }
  return { shapes, versions };
}

export function diff(shapes: ShapeSummary[], versions: Map<string, number>, baseline: Map<string, number>) {
  const added: ShapeSummary[] = [], modified: ShapeSummary[] = [];
  for (const s of shapes) {
    const before = baseline.get(s.id);
    if (before === undefined) added.push(s);
    else if (before !== versions.get(s.id)) modified.push(s);
  }
  const deleted_ids = [...baseline.keys()].filter((id) => !versions.has(id));
  return { added, modified, deleted_ids };
}

export function layoutHints(all: ShapeSummary[]) {
  const shapes = all.filter((s) => s.x !== undefined) as Required<Pick<ShapeSummary, "x" | "y" | "width" | "height">>[];
  if (!shapes.length) return { bounds: null, free_region: { x: 0, y: 0, width: 800, height: 600 } };
  const minX = Math.min(...shapes.map((s) => s.x)), minY = Math.min(...shapes.map((s) => s.y));
  const maxX = Math.max(...shapes.map((s) => s.x + s.width)), maxY = Math.max(...shapes.map((s) => s.y + s.height));
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  // ponytail: naive "strip to the right of everything"; real free-space packing if agents start overlapping
  return { bounds, free_region: { x: maxX + 100, y: minY, width: 600, height: Math.max(400, bounds.height) } };
}
