// One-off importer: converts selected official draw.io templates (© JGraph Ltd, CC BY 4.0) into
// design-canvas template skeletons and writes src/templates-drawio.ts. Re-run to refresh:
//   node scripts/import-drawio.mjs
// The output is checked in so builds never need the network.
import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const BASE = "https://raw.githubusercontent.com/jgraph/drawio/dev/src/main/webapp/templates/";

const PICKS = [
  {
    path: "uml/activity_diagram_1", id: "uml-activity", name: "UML activity (swimlanes)", kind: "Flow",
    description: "Concurrent activities in swimlanes with start/end nodes, decisions and fork/join bars.",
    guide: "UML activity diagram: one swimlane (frame) per actor or thread; rounded boxes are actions, diamonds are decisions with labeled " +
      "guards ([yes]/[no]), thick bars are fork/join. Start at a filled start node and end at an end node; flows read top to bottom.",
  },
  {
    path: "uml/state_machine", id: "uml-state", name: "UML state machine", kind: "Flow",
    description: "States and transitions, with a composite state container.",
    guide: "UML state machine: boxes are states (name what the thing IS, not what it does), arrows are transitions labeled " +
      "'event [guard] / action'. One initial state, explicit final states, and composite states as frames containing their sub-states.",
  },
  {
    path: "software/entity_relationship", id: "erd", name: "Entity relationship (tables)", kind: "Data",
    description: "Tables with primary/foreign keys and the relationships between them.",
    guide: "Entity-relationship diagram: one box per table/entity, first line the name, then one line per column with PK/FK markers. " +
      "Arrows are relationships labeled with cardinality (1, 0..1, 1..*, *) at the foreign-key side; name join tables for many-to-many.",
  },
  {
    path: "flowcharts/cross_functional_flowchart_1", id: "swimlane-flow", name: "Cross-functional flowchart", kind: "Flow",
    description: "A process across teams or systems: one lane per role, steps flowing between lanes.",
    guide: "Cross-functional (swimlane) flowchart: one lane (frame) per role, team or system; each step sits in the lane that owns it. " +
      "Arrows crossing lanes are hand-offs: label what is handed over. Keep time flowing one way (top to bottom).",
  },
];

const decode = (s) => s
  .replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&#10;/g, "\n").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&lt;[^&]*&gt;/g, " ")
  .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");

async function load(path) {
  const xml = await (await fetch(BASE + path + ".xml")).text();
  let model = xml.match(/<diagram[^>]*>([\s\S]*?)<\/diagram>/)[1].trim();
  if (!model.startsWith("<")) model = decodeURIComponent(inflateRawSync(Buffer.from(model, "base64")).toString());
  return [...model.matchAll(/<mxCell ([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g)].map((m) => {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const g = Object.fromEntries([...(m[3]?.match(/<mxGeometry ([^>]*)/)?.[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], +x[2]]));
    return { ...a, style: a.style ?? "", value: decode(decode(a.value ?? "")), geo: { x: g.x ?? 0, y: g.y ?? 0, w: g.width ?? 0, h: g.height ?? 0 } };
  });
}

function convert(cells) {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const kids = (c) => cells.filter((k) => k.parent === c.id && k.vertex);
  const has = (c, k) => c.style.split(";").some((t) => t === k || t.startsWith(k + "=") || t === `shape=${k}`);
  const lane = (c) => has(c, "swimlane") || has(c, "umlFrame");
  const table = (c) => lane(c) && kids(c).length > 0 && kids(c).every((k) => has(k, "partialRectangle"));
  const pool = (c) => lane(c) && kids(c).some(lane);
  const abs = (c) => {
    const p = byId.get(c.parent);
    if (!p || !p.vertex) return { x: c.geo.x, y: c.geo.y };
    const o = abs(p);
    return { x: o.x + c.geo.x, y: o.y + c.geo.y };
  };

  const shapes = [];
  const alias = new Map(); // draw.io id -> our id (table rows map to their table)
  let n = 0;
  for (const c of cells.filter((x) => x.vertex === "1")) {
    const p = byId.get(c.parent);
    if (p && table(p)) continue; // rows are folded into their table
    if (p && byId.get(p.parent) && table(byId.get(p.parent))) continue;
    if (pool(c)) continue; // Excalidraw frames can't nest: keep the lanes, drop the pool
    const { x, y } = abs(c);
    const id = `v${++n}`;
    alias.set(c.id, id);
    const base = { id, x, y, width: c.geo.w, height: c.geo.h };
    if (table(c)) {
      const rows = kids(c).sort((a, b) => a.geo.y - b.geo.y).map((r) => {
        for (const k of kids(r)) alias.set(k.id, id);
        alias.set(r.id, id);
        const key = kids(r).map((k) => k.value).filter(Boolean).join(",");
        return [key, r.value].filter(Boolean).join(" ");
      }).filter(Boolean);
      shapes.push({ ...base, type: "rectangle", label: [c.value || "Table", ...rows].join("\n") });
    } else if (lane(c)) shapes.push({ ...base, type: "frame", label: c.value || "Lane" });
    else if (has(c, "startState") || has(c, "endState")) {
      const start = has(c, "startState");
      shapes.push({ id, type: "ellipse", x: x + c.geo.w / 2 - 35, y: y + c.geo.h / 2 - 22, width: 70, height: 44, label: start ? "start" : "end" });
    } else if (has(c, "rhombus")) shapes.push({ ...base, type: "diamond", label: c.value || "Decision?" });
    else if (has(c, "ellipse")) shapes.push({ ...base, type: "ellipse", label: c.value || undefined });
    else if (has(c, "text")) { if (c.value) shapes.push({ id, type: "text", x, y, text: c.value }); }
    else if (has(c, "note")) shapes.push({ ...base, type: "rectangle", label: c.value || "Note", backgroundColor: "#fff9db" });
    else shapes.push({ ...base, type: "rectangle", label: c.value || (c.geo.w > 30 && c.geo.h > 30 ? "Step" : undefined) });
  }
  let e = 0;
  for (const c of cells.filter((x) => x.edge === "1")) {
    const a = alias.get(c.source), b = alias.get(c.target);
    if (!a || !b || a === b) continue;
    const kind = shapes.find((s) => s.id === a)?.type;
    if (kind === "frame" && shapes.find((s) => s.id === b)?.type === "frame") continue;
    shapes.push({ id: `e${++e}`, type: c.style.includes("endArrow=none") ? "line" : "arrow", start: { id: a }, end: { id: b }, ...(c.value && { label: c.value }) });
  }
  // move to the origin and round
  const boxes = shapes.filter((s) => s.x !== undefined);
  const mx = Math.min(...boxes.map((s) => s.x)), my = Math.min(...boxes.map((s) => s.y));
  for (const s of boxes) {
    s.x = Math.round(s.x - mx); s.y = Math.round(s.y - my);
    if (s.width !== undefined) { s.width = Math.round(s.width); s.height = Math.round(s.height); }
  }
  return shapes;
}

const out = [];
for (const p of PICKS) {
  const shapes = convert(await load(p.path));
  console.log(`${p.id}: ${shapes.length} shapes`);
  const { path, ...meta } = p;
  out.push({ ...meta, source: `draw.io template "${path}" (© JGraph Ltd, CC BY 4.0), converted`, shapes });
}
writeFileSync(new URL("../src/templates-drawio.ts", import.meta.url), [
  "// GENERATED by scripts/import-drawio.mjs from official draw.io templates.",
  "// Source: https://github.com/jgraph/drawio/tree/dev/src/main/webapp/templates (© JGraph Ltd, licensed CC BY 4.0).",
  "// Converted to design-canvas skeletons (layout and labels kept; styling simplified). Do not edit by hand.",
  'import type { Template } from "./templates.js";',
  "",
  `export const DRAWIO_TEMPLATES: Template[] = ${JSON.stringify(out, null, 2)};`,
  "",
].join("\n"));
