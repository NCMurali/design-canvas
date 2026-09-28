import { useState } from "react";
import type { AIShape } from "./Canvas";

export interface Template { id: string; name: string; kind: string; description: string; source: string; shapes: AIShape[] }

/** Template shapes with ids made unique (ids are session-wide). */
export function scaffold(t: Template, prefix: string): AIShape[] {
  const p = (id: string) => `${prefix}${id}`;
  return t.shapes.map((s) => ({
    ...s, id: p(s.id),
    ...(s.start && { start: { id: p(s.start.id) } }),
    ...(s.end && { end: { id: p(s.end.id) } }),
    ...(s.children && { children: s.children.map(p) }),
  }));
}

/** Tiny SVG thumbnail of a template's skeleton: good enough to tell layouts apart. */
function Preview({ t }: { t: Template }) {
  const boxes = t.shapes.filter((s) => s.x !== undefined && s.width !== undefined);
  if (!boxes.length) return <svg className="tpl-preview" />;
  const minX = Math.min(...boxes.map((s) => Math.min(s.x!, s.x! + s.width!))), minY = Math.min(...boxes.map((s) => Math.min(s.y!, s.y! + (s.height ?? 0))));
  const maxX = Math.max(...boxes.map((s) => Math.max(s.x!, s.x! + s.width!))), maxY = Math.max(...boxes.map((s) => Math.max(s.y!, s.y! + (s.height ?? 0))));
  const byId = new Map(boxes.map((s) => [s.id, s]));
  const c = (s: AIShape) => ({ x: s.x! + s.width! / 2, y: s.y! + (s.height ?? 0) / 2 });
  return (
    <svg className="tpl-preview" viewBox={`${minX - 20} ${minY - 20} ${maxX - minX + 40} ${maxY - minY + 40}`} preserveAspectRatio="xMidYMid meet">
      {t.shapes.map((s) => {
        if (s.type === "arrow" || s.type === "line") {
          const a = s.start && byId.get(s.start.id), b = s.end && byId.get(s.end.id);
          const p1 = a ? c(a) : { x: s.x ?? 0, y: s.y ?? 0 }, p2 = b ? c(b) : { x: (s.x ?? 0) + (s.width ?? 0), y: (s.y ?? 0) + (s.height ?? 0) };
          return <line key={s.id} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="pv-line" />;
        }
        if (s.x === undefined || s.width === undefined) return null;
        const h = s.height ?? 0;
        if (s.type === "ellipse") return <ellipse key={s.id} cx={s.x + s.width / 2} cy={s.y! + h / 2} rx={s.width / 2} ry={h / 2} className="pv-shape" />;
        if (s.type === "diamond") return <polygon key={s.id} points={`${s.x + s.width / 2},${s.y} ${s.x + s.width},${s.y! + h / 2} ${s.x + s.width / 2},${s.y! + h} ${s.x},${s.y! + h / 2}`} className="pv-shape" />;
        return <rect key={s.id} x={s.x} y={s.y} width={s.width} height={h} rx={s.type === "frame" ? 0 : 8} className={s.type === "frame" ? "pv-frame" : "pv-shape"} />;
      })}
    </svg>
  );
}

/**
 * New tab: pick a name and a template (or blank). Existing tab: pick a template to restructure toward;
 * that goes to the AI as a normal turn, so nothing on the canvas is thrown away.
 */
export function TemplatePicker(p: {
  mode: "new" | "apply";
  templates: Template[];
  defaultName: string;
  tabHasContent: boolean;
  onPick: (template: Template | null, name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(p.defaultName);
  const [pick, setPick] = useState<Template | null>(null);
  const kinds = [...new Set(p.templates.map((t) => t.kind))];
  const ok = p.mode === "new" ? !!name.trim() : !!pick;
  const submit = () => ok && p.onPick(pick, name.trim());

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal" role="dialog" aria-label={p.mode === "new" ? "New diagram" : "Apply a template"}
        onKeyDown={(e) => { if (e.key === "Escape") p.onClose(); }}>
        <h2>{p.mode === "new" ? "New diagram" : "Apply a template to this diagram"}</h2>
        {p.mode === "new" && (
          <label className="name-row">Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          </label>
        )}
        {p.mode === "apply" && (
          <p className="modal-note">
            {p.tabHasContent
              ? "The AI restructures what's already here toward the template: it reuses and relabels your shapes and adds what's missing. You can add a note in the chat box first."
              : "This tab is empty, so the template's starter shapes are added directly."}
          </p>
        )}
        <div className="tpl-grid">
          {p.mode === "new" && (
            <button type="button" className={`tpl ${pick === null ? "on" : ""}`} onClick={() => setPick(null)}>
              <svg className="tpl-preview" />
              <div className="tpl-name">Blank</div>
              <div className="tpl-desc">Start from an empty canvas.</div>
            </button>
          )}
          {kinds.map((k) => p.templates.filter((t) => t.kind === k).map((t) => (
            <button type="button" key={t.id} className={`tpl ${pick?.id === t.id ? "on" : ""}`} onClick={() => setPick(t)} onDoubleClick={() => p.onPick(t, name.trim() || t.name)} title={t.source}>
              <Preview t={t} />
              <div className="tpl-name">{t.name} <span className="tpl-kind">{t.kind}</span></div>
              <div className="tpl-desc">{t.description}</div>
            </button>
          )))}
        </div>
        <div className="modal-buttons">
          <button type="button" onClick={p.onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!ok} onClick={submit}>
            {p.mode === "new" ? "Create" : p.tabHasContent ? "Ask AI to apply" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
