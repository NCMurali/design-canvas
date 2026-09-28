import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import PDFDocument from "pdfkit";
import pptxModule from "pptxgenjs";
import type { Session } from "./session.js";
import type { ShapeSummary } from "./summarize.js";

// pptxgenjs types are CJS-shaped under NodeNext; at runtime the ESM default export is the class itself
const PptxGenJS = pptxModule as unknown as typeof pptxModule.default;

export type Format = "png" | "svg" | "excalidraw" | "markdown" | "mermaid" | "pdf" | "pptx";
const EXT: Record<Format, string> = { png: "png", svg: "svg", excalidraw: "excalidraw", markdown: "md", mermaid: "mermaid.md", pdf: "pdf", pptx: "pptx" };
export const needsBrowser = (f: Format) => f === "png" || f === "svg" || f === "pdf" || f === "pptx";

export async function outPath(format: Format, path?: string) {
  const name = `design-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${EXT[format]}`;
  if (!path) {
    const dir = process.env.DESIGN_CANVAS_EXPORT_DIR || process.cwd();
    await mkdir(dir, { recursive: true });
    return join(dir, name);
  }
  const p = resolve(path);
  const isDir = await stat(p).then((s) => s.isDirectory(), () => false);
  return isDir ? join(p, name) : p;
}

const LINKS = new Set(["arrow", "line"]);

/** Per tab: its shapes plus readable component / connection lines. Empty tabs are skipped. */
function outline(s: Session) {
  return s.boards.map((b) => {
    const { shapes } = s.snapshot(b.id);
    const name = new Map(shapes.map((x) => [x.id, x.label ? `${x.label} (${x.id})` : x.id]));
    const line = (x: ShapeSummary) => `${x.label ?? x.id} [${x.type}, ${x.author}]${x.in ? ` in ${name.get(x.in)}` : ""}${x.reason ? ` — ${x.reason}` : ""}`;
    const conn = (x: ShapeSummary) =>
      `${x.from ? name.get(x.from) : "?"} -> ${x.to ? name.get(x.to) : "?"}${x.label ? ` : ${x.label}` : ""}${x.reason ? ` — ${x.reason}` : ""}`;
    return {
      board: b.name,
      shapes,
      components: shapes.filter((x) => !LINKS.has(x.type) && x.type !== "freedraw" && x.label).map(line),
      connections: shapes.filter((x) => x.type === "arrow" && (x.from || x.to)).map(conn),
      freedraws: shapes.filter((x) => x.type === "freedraw").length,
    };
  }).filter((o) => o.shapes.length);
}

/** Canvas summary -> Mermaid flowchart. Frames become subgraphs; freehand sketches only appear if something points at them. */
export function mermaid(shapes: ShapeSummary[]) {
  const nid = (id: string) => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const q = (t: string) => `"${t.replace(/"/g, "#quot;").replace(/\n/g, "<br/>")}"`;
  const byId = new Map(shapes.map((x) => [x.id, x]));
  const linked = new Set(shapes.flatMap((x) => (LINKS.has(x.type) ? [x.from, x.to] : [])).filter(Boolean) as string[]);
  const node = (x: ShapeSummary) => {
    const l = q(x.label ?? (x.type === "freedraw" ? "sketch" : x.id));
    return x.type === "ellipse" ? `${nid(x.id)}([${l}])` : x.type === "diamond" ? `${nid(x.id)}{${l}}` : `${nid(x.id)}[${l}]`;
  };
  const isNode = (x: ShapeSummary) =>
    !LINKS.has(x.type) && x.type !== "frame" && x.type !== "magicframe" && (x.type !== "freedraw" || linked.has(x.id)) && (x.type !== "text" || linked.has(x.id) || !!x.label);
  const out = ["flowchart LR"];
  for (const f of shapes.filter((x) => x.type === "frame" || x.type === "magicframe")) {
    out.push(`  subgraph ${nid(f.id)}[${q(f.label ?? f.id)}]`);
    for (const x of shapes.filter((y) => y.in === f.id && isNode(y))) out.push(`    ${node(x)}`);
    out.push("  end");
  }
  for (const x of shapes.filter((y) => isNode(y) && !(y.in && byId.has(y.in)))) out.push(`  ${node(x)}`);
  for (const x of shapes.filter((y) => LINKS.has(y.type) && y.from && y.to)) {
    const edge = x.type === "arrow" ? "-->" : "---";
    out.push(`  ${nid(x.from!)} ${edge}${x.label ? `|${q(x.label)}|` : ""} ${nid(x.to!)}`);
  }
  return out.join("\n");
}

export function mermaidDoc(s: Session) {
  return [`# ${s.title}`, "", ...outline(s).flatMap((o) => [`## ${o.board}`, "", "```mermaid", mermaid(o.shapes), "```", ""])].join("\n");
}

export function markdown(s: Session) {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "_none_");
  return [
    `# ${s.title}`, "", `_Design log exported ${new Date().toISOString()}_`, "",
    ...outline(s).flatMap((o) => [
      `## ${o.board}`, "", "```mermaid", mermaid(o.shapes), "```", "",
      "### Components", list(o.components), "",
      "### Connections", list(o.connections), "",
      ...(o.freedraws ? [`_${o.freedraws} freehand sketch(es) not listed above._`, ""] : []),
    ]),
    "## Transcript",
    ...s.chat.map((m) => `**${m.author === "ai" ? "AI" : "User"}** (${m.timestamp}): ${m.text}\n`),
  ].join("\n");
}

export function excalidrawFile(s: Session, boardId: string) {
  return JSON.stringify({
    type: "excalidraw", version: 2, source: "design-canvas-mcp",
    elements: s.board(boardId)?.elements ?? [], appState: { viewBackgroundColor: "#ffffff" }, files: {},
  }, null, 2);
}

const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
type Img = { board: string; png: Buffer };
const transcript = (s: Session) => s.chat.map((m) => `${m.author === "ai" ? "AI" : "User"}: ${m.text}`);

export function pdf(s: Session, images: Img[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 40, autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((ok) => doc.on("end", () => ok(Buffer.concat(chunks))));
  for (const { board, png } of images) {
    doc.addPage().fontSize(20).text(`${s.title} — ${board}`).moveDown(0.5);
    doc.image(png, { fit: [doc.page.width - 80, doc.page.height - 120], align: "center" });
  }
  doc.addPage();
  const section = (title: string, lines: string[], size = 16) => {
    doc.fontSize(size).text(title).moveDown(0.3).fontSize(11);
    (lines.length ? lines : ["(none)"]).forEach((l) => doc.text(`• ${l}`));
    doc.moveDown();
  };
  for (const o of outline(s)) {
    doc.fontSize(18).text(o.board).moveDown(0.3);
    section("Components", o.components, 14);
    section("Connections", o.connections, 14);
  }
  section("Transcript", transcript(s));
  doc.end();
  return done;
}

export async function pptx(s: Session, images: Img[]): Promise<Buffer> {
  const p = new PptxGenJS(); // default 16:9, 10 x 5.625 in
  p.title = s.title;
  // ponytail: each tab is one image slide; native editable pptx shapes if anyone asks
  for (const { board, png } of images) {
    const { w, h } = pngSize(png);
    const scale = Math.min(9.4 / w, 4.6 / h);
    const sl = p.addSlide();
    sl.addText(`${s.title} — ${board}`, { x: 0.3, y: 0.15, w: 9.4, h: 0.5, fontSize: 22, bold: true });
    sl.addImage({ data: `data:image/png;base64,${png.toString("base64")}`, x: (10 - w * scale) / 2, y: 0.8, w: w * scale, h: h * scale });
  }
  const textSlides = (title: string, lines: string[]) => {
    const per = 12;
    for (let i = 0; i < Math.max(lines.length, 1); i += per) {
      const sl = p.addSlide();
      sl.addText(i ? `${title} (cont.)` : title, { x: 0.3, y: 0.15, w: 9.4, h: 0.5, fontSize: 20, bold: true });
      const chunk = lines.slice(i, i + per);
      sl.addText(chunk.length ? chunk.map((t) => ({ text: t, options: { bullet: true } })) : "(none)",
        { x: 0.4, y: 0.8, w: 9.2, h: 4.6, fontSize: 13, valign: "top" });
    }
  };
  for (const o of outline(s)) textSlides(`${o.board}: components & connections`, [...o.components, ...o.connections]);
  textSlides("Transcript", transcript(s));
  return (await p.write({ outputType: "nodebuffer" })) as Buffer;
}
