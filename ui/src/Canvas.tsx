import { useRef, useState } from "react";
import { Excalidraw, convertToExcalidrawElements, CaptureUpdateAction, exportToBlob, exportToSvg } from "@excalidraw/excalidraw";

// Loose types on purpose: we build plain element objects and let Excalidraw validate them.
type El = Record<string, any>;
type Api = any;
export interface AIShape {
  id: string; type: "rectangle" | "ellipse" | "diamond" | "arrow" | "line" | "text" | "frame";
  children?: string[];
  x?: number; y?: number; width?: number; height?: number;
  label?: string; text?: string; reason?: string;
  start?: { id: string }; end?: { id: string };
  strokeColor?: string; backgroundColor?: string;
}
export interface AiTurnMsg { create: AIShape[]; update: AIShape[]; del: string[] }

export const AI_COLOR = "#1971c2";
const AI_FILL = "#e7f5ff";
const LINEAR = new Set(["arrow", "line"]);
const KEEP_STYLE = ["roughness", "strokeWidth", "strokeStyle", "fillStyle", "opacity", "customData", "strokeColor",
  "backgroundColor", "roundness", "fontSize", "fontFamily", "startArrowhead", "endArrowhead"];
const rand = () => Math.floor(Math.random() * 2 ** 31);

/** Scene as sent to the server: live elements, every one tagged with an author. */
export function serialize(api: Api): El[] {
  return api.getSceneElements().map((e: El) =>
    e.customData?.author ? e : { ...e, customData: { ...e.customData, author: "user" } });
}

type Box = { x: number; y: number; width: number; height: number };
const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// ponytail: bounding-box intersection; on ellipses/diamonds the tip floats slightly off the outline
function edge(b: Box, toward: { x: number; y: number }, gap = 6) {
  const c = center(b);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? b.width / 2 / Math.abs(dx) : Infinity, dy ? b.height / 2 / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  return { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap };
}

// How much of a shape's box its label may use: ellipse ≈ inscribed rectangle, diamond ≈ half.
const ROOM: Record<string, number> = { rectangle: 1, ellipse: 1.42, diamond: 2 };
/** Grow a box until its label fits (~11px per char, 25px per line at the default font), so text never wraps letter by letter. */
function fitLabel(type: string, label: string | undefined, b: Box): Box {
  const k = ROOM[type];
  if (!k || !label) return b;
  const lines = label.split("\n");
  const inner = Math.min(Math.max(...lines.map((l) => l.length * 11), 60), 260); // longer lines wrap at ~260px
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 11) / inner)), 0);
  return { ...b, width: Math.max(b.width, Math.round((inner + 20) * k)), height: Math.max(b.height, Math.round((rows * 25 + 20) * k)) };
}

/**
 * Older sessions drew reasons as separate text notes. Reasons now live in the shape's customData and show
 * in a card on selection, so fold any legacy notes into their owners.
 */
export function migrateNotes(els: El[]): El[] {
  const ids = new Set(els.map((e) => e.id));
  const notes = new Map(els.filter((e) => e.customData?.reasonFor && ids.has(e.customData.reasonFor)).map((e) => [e.customData.reasonFor, e]));
  if (!notes.size) return els;
  return els.filter((e) => !(e.customData?.reasonFor && notes.has(e.customData.reasonFor))).map((e) => {
    const groupIds = e.groupIds?.filter((g: string) => !g.endsWith("__g"));
    const n = notes.get(e.id);
    if (!n && groupIds?.length === e.groupIds?.length) return e;
    return {
      ...e, groupIds, version: e.version + 1,
      ...(n && { customData: { ...e.customData, reason: String(n.originalText ?? n.text).replace(/\s+/g, " ").trim() } }),
    };
  });
}

/**
 * Render an AI turn into the scene. Everything goes through one convertToExcalidrawElements batch;
 * arrow geometry and bindings are computed here because convert only binds within its own batch
 * and never re-routes endpoints.
 */
export function applyAiTurn(api: Api, t: AiTurnMsg, opts: { author?: "ai" | "user" } = {}) {
  const asUser = opts.author === "user"; // template starter shapes: they're the user's to edit, so no AI styling
  const failed: { id: string; reason: string }[] = [];
  const scene: El[] = api.getSceneElementsIncludingDeleted();
  const live = scene.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const ownedBy = (id: string) => live.filter((e) => e.containerId === id || e.customData?.reasonFor === id).map((e) => e.id);

  const deleted = new Set<string>();
  for (const id of t.del) { deleted.add(id); ownedBy(id).forEach((x) => deleted.add(x)); }

  // Specs to (re)build. Updated shapes are rebuilt with the same id; arrows touching them are re-routed.
  const jobs: { s: AIShape; old?: El }[] = [
    ...t.create.map((s) => ({ s })),
    ...t.update.map((s) => ({ s, old: byId.get(s.id) })),
  ];
  const touched = new Set(t.update.map((s) => s.id));
  for (const e of live) {
    if (e.type !== "arrow" || touched.has(e.id) || deleted.has(e.id)) continue;
    const a = e.startBinding?.elementId, b = e.endBinding?.elementId;
    if (!touched.has(a) && !touched.has(b)) continue;
    const label = live.find((x) => x.containerId === e.id)?.text;
    jobs.push({ s: { id: e.id, type: "arrow", label, start: a ? { id: a } : undefined, end: b ? { id: b } : undefined }, old: e });
  }

  const boxes = new Map<string, Box>();
  for (const { s, old } of jobs) {
    if (LINEAR.has(s.type)) continue;
    const text = s.type === "text";
    boxes.set(s.id, fitLabel(s.type, s.label, { x: s.x ?? 0, y: s.y ?? 0, width: s.width ?? old?.width ?? (text ? 120 : 160), height: s.height ?? old?.height ?? (text ? 25 : 80) }));
  }
  const boxOf = (id: string): Box | undefined => {
    if (boxes.has(id)) return boxes.get(id);
    const e = !deleted.has(id) ? byId.get(id) : undefined;
    if (!e?.points?.length) return e as Box | undefined;
    // freehand: x/y is the first point, so take the bounds of the stroke
    const xs = e.points.map((p: number[]) => p[0]), ys = e.points.map((p: number[]) => p[1]);
    return { x: e.x + Math.min(...xs), y: e.y + Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  };
  // Excalidraw can't bind arrows to freehand strokes or frames: those arrows just point at their bounds.
  const kind = (id: string) => byId.get(id)?.type ?? jobs.find((j) => j.s.id === id)?.s.type;
  const bindable = (id?: string) => (id && kind(id) !== "freedraw" && kind(id) !== "frame" ? id : undefined);

  const skels: El[] = [];
  const bindings: { id: string; start?: string; end?: string }[] = [];
  const replaced = new Set<string>();
  const frames: { id: string; box: Box; children?: string[] }[] = [];
  for (const { s, old } of jobs) {
    const ai = !old && !asUser;
    const style: El = old
      ? Object.fromEntries(KEEP_STYLE.filter((k) => old[k] !== undefined).map((k) => [k, old[k]]))
      : { strokeColor: asUser ? "#343a40" : AI_COLOR, customData: { author: asUser ? "user" : "ai" },
          ...(!LINEAR.has(s.type) && s.type !== "text" && s.type !== "frame" && { backgroundColor: asUser ? "#f8f9fa" : AI_FILL, fillStyle: "solid" }),
          ...(s.type === "rectangle" && { roundness: { type: 3 } }) };
    if (s.reason !== undefined) style.customData = { ...style.customData, reason: s.reason };
    if (s.strokeColor) style.strokeColor = s.strokeColor;
    if (s.backgroundColor) style.backgroundColor = s.backgroundColor;
    const label = s.label ? { label: { text: s.label, strokeColor: style.strokeColor, customData: { author: ai ? "ai" : style.customData?.author ?? "user" } } } : {};
    if (old) { replaced.add(s.id); ownedBy(s.id).filter((x) => !x.endsWith("__reason") || s.reason !== undefined).forEach((x) => replaced.add(x)); }

    if (LINEAR.has(s.type)) {
      const sb = s.start && boxOf(s.start.id), eb = s.end && boxOf(s.end.id);
      if ((s.start && !sb) || (s.end && !eb)) { failed.push({ id: s.id, reason: "bound shape not found in the browser scene" }); replaced.delete(s.id); continue; }
      let p1, p2;
      if (sb && eb) { p1 = edge(sb, center(eb)); p2 = edge(eb, center(sb)); }
      else if (sb) { const c = center(sb); p1 = edge(sb, { x: c.x + 1000, y: c.y }); p2 = { x: p1.x + (s.width || 150), y: p1.y + (s.height ?? 0) }; }
      else if (eb) { const c = center(eb); p2 = edge(eb, { x: c.x - 1000, y: c.y }); p1 = { x: p2.x - (s.width || 150), y: p2.y - (s.height ?? 0) }; }
      else { p1 = { x: s.x ?? 0, y: s.y ?? 0 }; p2 = { x: p1.x + (s.width ?? 150), y: p1.y + (s.height ?? 0) }; }
      // unbound ends (sketch targets) are remembered in customData so the agent still sees from/to
      const sketchEnds = { ...(s.start && !bindable(s.start.id) && { from: s.start.id }), ...(s.end && !bindable(s.end.id) && { to: s.end.id }) };
      if (Object.keys(sketchEnds).length) style.customData = { ...style.customData, ...sketchEnds };
      skels.push({ ...style, ...label, id: s.id, type: s.type, x: p1.x, y: p1.y, points: [[0, 0], [p2.x - p1.x, p2.y - p1.y]],
        ...(s.type === "arrow" && !old && { endArrowhead: "arrow" }) });
      if (s.type === "arrow" && (bindable(s.start?.id) || bindable(s.end?.id))) bindings.push({ id: s.id, start: bindable(s.start?.id), end: bindable(s.end?.id) });
    } else {
      const b = boxes.get(s.id)!;
      if (s.type === "text") skels.push({ ...style, id: s.id, type: "text", x: b.x, y: b.y, text: s.text ?? "" });
      else if (s.type === "frame") {
        skels.push({ ...style, id: s.id, type: "frame", ...b, name: s.label ?? null, children: [] });
        if (!old || s.children) frames.push({ id: s.id, box: b, children: s.children });
      }
      else skels.push({ ...style, ...label, id: s.id, type: s.type, ...b });
    }
  }

  let out: El[];
  try {
    out = convertToExcalidrawElements(skels as any, { regenerateIds: false }) as El[];
  } catch (e) {
    return { failed: [...failed, ...jobs.map(({ s }) => ({ id: s.id, reason: `render error: ${(e as Error).message}` }))] };
  }
  const oldVersion = new Map(scene.map((e) => [e.id, e.version]));
  out = out.map((e) => (oldVersion.has(e.id) ? { ...e, version: oldVersion.get(e.id)! + 1 } : e));
  const outIds = new Set(out.map((e) => e.id));

  const map = new Map<string, El>();
  for (const e of scene) {
    if (outIds.has(e.id) || replaced.has(e.id)) continue;
    map.set(e.id, deleted.has(e.id) ? { ...e, isDeleted: true, version: e.version + 1, versionNonce: rand() } : e);
  }
  for (const e of out) map.set(e.id, e);

  // Frames: attach listed children, or whatever lies fully inside. Bound labels follow their container.
  for (const f of frames) {
    const inside = (e: El) => {
      const b = boxOf(e.id) ?? e;
      return b.x >= f.box.x && b.y >= f.box.y && b.x + b.width <= f.box.x + f.box.width && b.y + b.height <= f.box.y + f.box.height;
    };
    const kids = new Set(f.children ?? [...map.values()].filter((e) => !e.isDeleted && e.id !== f.id && e.type !== "frame" && !e.containerId && inside(e)).map((e) => e.id));
    for (const [id, e] of map) {
      if (kids.has(id) || (e.containerId && kids.has(e.containerId))) map.set(id, { ...e, frameId: f.id });
    }
  }
  // Frames go last so their children stay in front of the frame.
  for (const [id, e] of [...map]) if (e.type === "frame") { map.delete(id); map.set(id, e); }

  for (const b of bindings) {
    const a = map.get(b.id)!;
    const bind = (id?: string) => (id ? { elementId: id, focus: 0, gap: 6 } : null);
    map.set(b.id, { ...a, startBinding: bind(b.start), endBinding: bind(b.end) });
    for (const tid of [b.start, b.end]) {
      if (!tid || !map.has(tid)) continue;
      const tgt = map.get(tid)!;
      map.set(tid, { ...tgt, boundElements: [...(tgt.boundElements ?? []).filter((x: El) => x.id !== b.id), { id: b.id, type: "arrow" }] });
    }
  }
  // Drop stale boundElements refs (replaced label texts, re-routed or deleted arrows).
  for (const [id, e] of map) {
    if (!e.boundElements?.length) continue;
    const ok = e.boundElements.filter((r: El) => {
      const x = map.get(r.id);
      if (!x || x.isDeleted) return false;
      return r.type === "text" ? x.containerId === id : x.startBinding?.elementId === id || x.endBinding?.elementId === id;
    });
    if (ok.length !== e.boundElements.length) map.set(id, { ...e, boundElements: ok });
  }

  api.updateScene({ elements: [...map.values()], captureUpdate: CaptureUpdateAction.IMMEDIATELY });

  // If anything the AI drew is off-screen, zoom to fit the whole diagram.
  const { scrollX, scrollY, zoom, width, height } = api.getAppState();
  const vx = -scrollX, vy = -scrollY, vw = width / zoom.value, vh = height / zoom.value;
  const offscreen = out.some((e) => e.x < vx || e.y < vy || e.x + (e.width ?? 0) > vx + vw || e.y + (e.height ?? 0) > vy + vh);
  if (offscreen) fit(api);
  return { failed };
}

/** Fit the diagram in view, but never zoom past 100%: a small diagram blown up looks broken. */
export const fit = (api: Api) => api?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 });

/** PNG as base64 (or SVG markup). `maxSide` caps the image for sending to the agent; `els` renders another tab. */
export async function exportImage(api: Api, format: "png" | "svg", maxSide?: number, els?: El[]): Promise<string> {
  const elements = els ? els.filter((e) => !e.isDeleted) : api.getSceneElements();
  if (!elements.length) throw new Error("canvas is empty");
  const appState = { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false, exportScale: maxSide ? 1 : 2 };
  const files = api.getFiles();
  if (format === "svg") return (await exportToSvg({ elements, appState, files, exportPadding: 24 })).outerHTML;
  const blob = await exportToBlob({ elements, appState, files, exportPadding: 24, mimeType: "image/png", ...(maxSide && { maxWidthOrHeight: maxSide }) });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Card = { id: string; reason: string; left: number; top: number };

/**
 * Excalidraw plus the reason card. The AI-turn lock is an overlay (in App), not view mode, because
 * toggling view mode resets the user's active tool every turn.
 */
export function Canvas({ locked, onApi, onChange, initialData, highlight }: { locked: boolean; onApi: (api: Api) => void; onChange: () => void; initialData: Promise<any>; highlight: string[] }) {
  const api = useRef<Api>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [, setView] = useState(""); // re-render the pointing rings when the view pans/zooms
  const size = useRef<{ w: number; h: number } | null>(null);

  // Rings around the shapes the AI is talking about, in screen coordinates.
  const rings = (() => {
    const a = api.current;
    if (!a || !highlight.length) return [];
    const st = a.getAppState(), z = st.zoom.value;
    return a.getSceneElements().filter((e: El) => highlight.includes(e.id)).map((e: El) => {
      const xs = e.points?.length ? e.points.map((p: number[]) => e.x + p[0]) : [e.x, e.x + e.width];
      const ys = e.points?.length ? e.points.map((p: number[]) => e.y + p[1]) : [e.y, e.y + e.height];
      const x = Math.min(...xs), y = Math.min(...ys);
      return { id: e.id, left: (x + st.scrollX) * z - 8, top: (y + st.scrollY) * z - 8, width: (Math.max(...xs) - x) * z + 16, height: (Math.max(...ys) - y) * z + 16 };
    });
  })();

  const handleChange = (els: readonly El[], st: El) => {
    onChange();
    // Excalidraw keeps the top-left fixed on resize (chat opening, window resize); keep the center fixed instead
    const prev = size.current;
    size.current = { w: st.width, h: st.height };
    if (prev && (prev.w !== st.width || prev.h !== st.height)) {
      const z = st.zoom.value;
      api.current?.updateScene({ appState: { scrollX: st.scrollX + (st.width - prev.w) / 2 / z, scrollY: st.scrollY + (st.height - prev.h) / 2 / z } });
    }
    // only when the view really moved: Excalidraw calls onChange on every render, so an unconditional update loops
    if (highlight.length) setView(`${st.scrollX},${st.scrollY},${st.zoom.value}`);
    const ids = Object.keys(st.selectedElementIds ?? {});
    let next: Card | null = null;
    if (ids.length <= 2 && !st.editingTextElement) {
      // selecting a labeled box selects its bound text too; resolve to the container
      const sel = els.filter((e) => ids.includes(e.id)).map((e) => (e.containerId ? els.find((x) => x.id === e.containerId) : e));
      const e = sel[0];
      if (e && sel.every((x) => x?.id === e.id) && e.customData?.reason !== undefined) {
        const z = st.zoom.value;
        next = { id: e.id, reason: e.customData.reason, left: (e.x + st.scrollX) * z, top: (e.y + Math.abs(e.height) + st.scrollY) * z + 10 };
      }
    }
    setCard((c) => (c && next && c.id === next.id && c.reason === next.reason && c.left === next.left && c.top === next.top ? c : next));
  };

  const saveReason = (id: string, reason: string) => {
    const els: El[] = api.current.getSceneElementsIncludingDeleted();
    api.current.updateScene({
      elements: els.map((e) => (e.id === id ? { ...e, customData: { ...e.customData, reason }, version: e.version + 1, versionNonce: rand() } : e)),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  return (
    <>
      <Excalidraw
        excalidrawAPI={(a: Api) => { api.current = a; onApi(a); }}
        initialData={initialData}
        onChange={handleChange as any}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
      />
      {rings.map((r) => <div key={r.id} className="hl-ring" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />)}
      {card && !locked && (
        <div className="reason-card" style={{ left: Math.max(8, card.left), top: card.top }}>
          <div className="reason-title">Why</div>
          <textarea
            key={card.id}
            defaultValue={card.reason}
            rows={2}
            onBlur={(e) => { if (e.target.value.trim() !== card.reason) saveReason(card.id, e.target.value.trim()); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
          />
        </div>
      )}
    </>
  );
}
