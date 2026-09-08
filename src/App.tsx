import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { getDocument, GlobalWorkerOptions, OPS, RenderingCancelledException } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  BlendMode,
  PDFDocument,
  degrees,
  radians,
  rgb,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { FontBook } from "./fonts";
import { stripFromPage, type Removal } from "./content";
import "@fontsource/dancing-script/400.css";
import "@fontsource/dancing-script/700.css";
import "@fontsource/great-vibes/400.css";
import "@fontsource/pacifico/400.css";
import "@fontsource/caveat/400.css";
import "@fontsource/caveat/700.css";
import { ColorPicker } from "./ColorPicker";
import { PageThumb } from "./PageThumb";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerUrl;

const DEFAULT_COLOR = "#1d4ed8";
const DEFAULT_HIGHLIGHT = "#fff3a3";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Tool = "select" | "text" | "draw" | "highlight" | "sign" | "image" | "edit";

type Stroke = {
  kind: "stroke";
  id: string;
  points: Point[];
  color: string;
  width: number;
};
type Highlight = {
  kind: "highlight";
  id: string;
  rects: Rect[];
  color: string;
};
type TextItem = {
  kind: "text";
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  color: string;
  size: number;
  font: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Created with the Signature tool: fixed script font, no text toolbar. */
  signature?: boolean;
};
type ImageItem = {
  kind: "image";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  image: HTMLImageElement;
};
/** Opaque patch that hides original page content underneath an edited copy. */
type Cover = {
  kind: "cover";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  /** Original content this cover stands in for. While it is set, the live
   * document is rebuilt with that content deleted. */
  removal?: Removal;
  /** True once the original has really been deleted from the document; the
   * cover is then never painted. */
  stripped?: boolean;
};
type Item = Stroke | Highlight | TextItem | ImageItem | Cover;

type Watermark = {
  text: string;
  color: string;
  size: number;
  opacity: number;
  angle: number;
  layout: "tile" | "center";
};
const DEFAULT_WATERMARK: Watermark = { text: "CONFIDENTIAL", color: "#f43f5e", size: 28, opacity: 0.25, angle: -30, layout: "tile" };
const WATERMARK_COLORS = ["#f43f5e", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#172033"];

/** Something on the original page the Edit tool can lift into an item. */
type Region = { kind: "text"; rect: Rect; line: Line } | { kind: "image"; rect: Rect };
type FontInfo = { family: string; bold: boolean; italic: boolean };

type Line = {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  /** Present when the row carries readable text (from the PDF or OCR). */
  text?: string;
  size?: number;
  font?: string;
  bold?: boolean;
  italic?: boolean;
};

type Handle = "nw" | "ne" | "sw" | "se" | "e" | "w";
type Drag =
  | { mode: "stroke" }
  | { mode: "highlight"; start: Point }
  | { mode: "move"; id: string; start: Point; orig: Item; snapshot: Item[] }
  | {
      mode: "resize";
      id: string;
      handle: Handle;
      start: Point;
      orig: Item;
      snapshot: Item[];
    };

/** Turn the editable name into a safe download file name ending in .pdf. */
function exportFilename(raw: string): string {
  const base = raw
    .trim()
    .replace(/\.pdf$/i, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return (base || "document") + ".pdf";
}

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
/** Rail order; also the 1–6 keyboard shortcuts. */
const TOOL_ORDER: Tool[] = ["select", "text", "draw", "highlight", "sign", "image", "edit"];

/** Tools with a fly-out panel. The Text and Signature panels double as an
 * inspector: while a matching item is selected they edit that item. */
const TOOL_OPTIONS: Partial<Record<Tool, { sizeLabel: string; min: number; max: number }>> = {
  text: { sizeLabel: "Font size", min: 6, max: 72 },
  sign: { sizeLabel: "Size", min: 16, max: 96 },
  draw: { sizeLabel: "Thickness", min: 6, max: 72 },
  highlight: { sizeLabel: "Height", min: 6, max: 72 },
};
const QUICK_COLORS = ["#172033", "#1d4ed8", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#ffffff"];
// Soft marker tints; they blend with multiply, so lighter means gentler.
const QUICK_HIGHLIGHTS = ["#fff3a3", "#c9f5e3", "#cfeafe", "#fdddf0", "#fee4c4", "#e8e3fe", "#fedadb", "#e9edf4"];

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 1.25;
const clampZoom = (z: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

const FONTS = [
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Trebuchet MS",
  "Dancing Script",
  "Great Vibes",
  "Pacifico",
  "Caveat",
];
const SIGNATURE_FONT = "Dancing Script";
const LINE_HEIGHT = 1.3;
/** Highlights are blended with "multiply", so they sit behind the ink: text
 * keeps its colour and white paper takes the highlight colour. */
type PaintLayer = "highlights" | "marks";

let nextId = 1;
const uid = () => String(nextId++);

const measureCtx = document.createElement("canvas").getContext("2d")!;

function fontString(item: TextItem) {
  return `${item.italic ? "italic " : ""}${item.bold ? "bold " : ""}${
    item.size
  }px "${item.font}", sans-serif`;
}

function layoutText(item: TextItem, measure?: (s: string) => number) {
  measureCtx.font = fontString(item);
  const width = measure ?? ((s: string) => measureCtx.measureText(s).width);
  const fits = (s: string) => width(s) <= item.width;
  const lines: string[] = [];
  for (const para of item.text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (!line) {
        line = word;
      } else if (fits(line + " " + word)) {
        line += " " + word;
      } else {
        lines.push(line);
        line = word;
      }
      if (!fits(line)) {
        // Break an overlong word across lines.
        let chunk = "";
        for (const ch of line) {
          if (chunk && !fits(chunk + ch)) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      }
    }
    lines.push(line);
  }
  const lineHeight = item.size * LINE_HEIGHT;
  return { lines, lineHeight, height: Math.max(1, lines.length) * lineHeight };
}

function itemRect(item: Item): Rect {
  if (item.kind === "text") {
    return { x: item.x, y: item.y, w: item.width, h: layoutText(item).height };
  }
  if (item.kind === "image" || item.kind === "cover") {
    return { x: item.x, y: item.y, w: item.width, h: item.height };
  }
  if (item.kind === "highlight") {
    const xs = item.rects.map((r) => r.x);
    const ys = item.rects.map((r) => r.y);
    const x2 = item.rects.map((r) => r.x + r.w);
    const y2 = item.rects.map((r) => r.y + r.h);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...x2) - x, h: Math.max(...y2) - y };
  }
  const xs = item.points.map((p) => p.x);
  const ys = item.points.map((p) => p.y);
  const x = Math.min(...xs) - item.width;
  const y = Math.min(...ys) - item.width;
  return {
    x,
    y,
    w: Math.max(...xs) + item.width - x,
    h: Math.max(...ys) + item.width - y,
  };
}

function inRect(p: Point, r: Rect) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number) {
  const rad = Math.min(radius, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}

function paintWatermark(ctx: CanvasRenderingContext2D, viewport: PageViewport, wm: Watermark) {
  const text = wm.text.trim();
  if (!text) return;
  ctx.save();
  ctx.globalAlpha = wm.opacity;
  ctx.fillStyle = wm.color;
  ctx.font = `700 ${wm.size}px Inter, system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const W = viewport.width;
  const H = viewport.height;
  ctx.translate(W / 2, H / 2);
  ctx.rotate((wm.angle * Math.PI) / 180);
  if (wm.layout === "center") {
    ctx.fillText(text, 0, 0);
  } else {
    const stepX = ctx.measureText(text).width + wm.size * 2.5;
    const stepY = wm.size * 4;
    const reach = Math.hypot(W, H) / 2 + stepX;
    let row = 0;
    for (let y = -reach; y <= reach; y += stepY, row++) {
      const offset = row % 2 ? stepX / 2 : 0;
      for (let x = -reach + offset; x <= reach; x += stepX) ctx.fillText(text, x, y);
    }
  }
  ctx.restore();
}

function paint(
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
  items: Item[],
  skipId: string | null = null,
  layer: PaintLayer = "marks",
  watermark: Watermark | null = null,
) {
  // Higher-resolution transparent overlay for crisp exports.
  const density = 2;
  canvas.width = Math.ceil(viewport.width * density);
  canvas.height = Math.ceil(viewport.height * density);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable.");
  ctx.setTransform(
    canvas.width / viewport.width,
    0,
    0,
    canvas.height / viewport.height,
    0,
    0,
  );
  if (layer === "highlights") {
    // The watermark shares this multiply-blended layer so it sits behind the ink.
    if (watermark) paintWatermark(ctx, viewport, watermark);
    // Opaque fills: overlapping strokes never stack up, and the multiply blend
    // applied by the caller keeps the text beneath fully legible.
    for (const item of items) {
      if (item.kind !== "highlight" || item.id === skipId) continue;
      ctx.fillStyle = item.color;
      for (const r of item.rects) {
        roundRect(ctx, r, 2);
        ctx.fill();
      }
    }
    return;
  }
  // Covers first: they hide original page content under edited copies.
  for (const item of items) {
    if (item.kind !== "cover" || item.id === skipId) continue;
    ctx.fillStyle = item.color;
    ctx.fillRect(item.x, item.y, item.width, item.height);
  }
  for (const item of items) {
    if (item.id === skipId || item.kind === "highlight" || item.kind === "cover") continue;
    ctx.save();
    if (item.kind === "text") {
      const { lines, lineHeight } = layoutText(item);
      ctx.fillStyle = item.color;
      ctx.strokeStyle = item.color;
      ctx.font = fontString(item);
      ctx.textBaseline = "top";
      ctx.lineWidth = Math.max(1, item.size / 14);
      lines.forEach((line, i) => {
        const top = item.y + i * lineHeight + (lineHeight - item.size) / 2;
        ctx.fillText(line, item.x, top);
        const w = ctx.measureText(line).width;
        if (item.underline) {
          ctx.beginPath();
          ctx.moveTo(item.x, top + item.size * 0.92);
          ctx.lineTo(item.x + w, top + item.size * 0.92);
          ctx.stroke();
        }
        if (item.strike) {
          ctx.beginPath();
          ctx.moveTo(item.x, top + item.size * 0.55);
          ctx.lineTo(item.x + w, top + item.size * 0.55);
          ctx.stroke();
        }
      });
    } else if (item.kind === "image") {
      ctx.drawImage(item.image, item.x, item.y, item.width, item.height);
    } else {
      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineWidth = item.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const first = item.points[0];
      if (first) {
        if (item.points.length === 1) {
          ctx.beginPath();
          ctx.arc(first.x, first.y, item.width / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(first.x, first.y);
          for (const point of item.points.slice(1)) {
            ctx.lineTo(point.x, point.y);
          }
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

type RawTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
};

/** Group the page's text runs into visual rows (viewport coordinates), keeping
 * the row's text and a best-guess font so the Edit tool can lift it. */
function buildLines(raw: unknown[], view: PageViewport, fontOf: (name: string) => FontInfo): Line[] {
  type Piece = { box: Rect; str: string; font: FontInfo };
  const pieces: Piece[] = [];
  for (const it of raw) {
    const t = it as Partial<RawTextItem>;
    if (typeof t.str !== "string" || !t.str.trim() || !t.transform) continue;
    const [a, b, c, d, e, f] = t.transform;
    const dl = Math.hypot(a, b) || 1;
    const ul = Math.hypot(c, d) || 1;
    const dir = [a / dl, b / dl];
    const up = [c / ul, d / ul];
    const w = t.width ?? 0;
    const h = t.height || ul;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const tt of [0, 1]) {
      for (const sc of [-0.22, 0.9]) {
        const px = e + dir[0] * w * tt + up[0] * h * sc;
        const py = f + dir[1] * w * tt + up[1] * h * sc;
        const [vx, vy] = view.convertToViewportPoint(px, py);
        x0 = Math.min(x0, vx);
        y0 = Math.min(y0, vy);
        x1 = Math.max(x1, vx);
        y1 = Math.max(y1, vy);
      }
    }
    if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
    pieces.push({ box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, str: t.str, font: fontOf(t.fontName ?? "") });
  }
  pieces.sort((p, q) => p.box.y + p.box.h / 2 - (q.box.y + q.box.h / 2));
  const rows: { line: Line; pieces: Piece[] }[] = [];
  let current: { line: Line; pieces: Piece[] } | null = null;
  let currentCy = 0;
  for (const piece of pieces) {
    const b = piece.box;
    const cy = b.y + b.h / 2;
    if (current && Math.abs(cy - currentCy) < Math.max(b.h, current.line.y1 - current.line.y0) * 0.5) {
      current.line.x0 = Math.min(current.line.x0, b.x);
      current.line.x1 = Math.max(current.line.x1, b.x + b.w);
      current.line.y0 = Math.min(current.line.y0, b.y);
      current.line.y1 = Math.max(current.line.y1, b.y + b.h);
      current.pieces.push(piece);
      currentCy = (current.line.y0 + current.line.y1) / 2;
    } else {
      current = { line: { x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h }, pieces: [piece] };
      currentCy = cy;
      rows.push(current);
    }
  }
  // A visual row can hold several columns or table cells. Split it wherever the
  // horizontal gap is far wider than a word space, so each cell is its own line.
  const lines: Line[] = [];
  for (const { line, pieces: ps } of rows) {
    ps.sort((p, q) => p.box.x - q.box.x);
    const rowSize = (line.y1 - line.y0) / 1.12;
    const groups: Piece[][] = [];
    let cursor = -Infinity;
    for (const p of ps) {
      const gap = p.box.x - cursor;
      if (!groups.length || gap > Math.max(rowSize * 1.6, 10)) groups.push([p]);
      else groups[groups.length - 1].push(p);
      cursor = Math.max(cursor, p.box.x + p.box.w);
    }
    for (const g of groups) {
      const x0 = Math.min(...g.map((p) => p.box.x));
      const x1 = Math.max(...g.map((p) => p.box.x + p.box.w));
      const y0 = Math.min(...g.map((p) => p.box.y));
      const y1 = Math.max(...g.map((p) => p.box.y + p.box.h));
      const size = (y1 - y0) / 1.12;
      let text = "";
      let end = -Infinity;
      for (const p of g) {
        const gap = p.box.x - end;
        if (text && gap > size * 0.15 && !text.endsWith(" ") && !p.str.startsWith(" ")) text += " ";
        text += p.str;
        end = Math.max(end, p.box.x + p.box.w);
      }
      const dominant = g.reduce((best, p) => (p.str.length > best.str.length ? p : best), g[0]);
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      lines.push({ x0, x1, y0, y1, text, size, font: dominant.font.family, bold: dominant.font.bold, italic: dominant.font.italic });
    }
  }
  return lines;
}

/** Bounding boxes (viewport coordinates) of the images drawn on a page. */
async function findImageRegions(page: PDFPageProxy, view: PageViewport): Promise<Rect[]> {
  const ops = await page.getOperatorList();
  const mul = (m: number[], c: number[]) => [
    m[0] * c[0] + m[1] * c[2],
    m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2],
    m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4],
    m[4] * c[1] + m[5] * c[3] + c[5],
  ];
  const O = OPS as unknown as Record<string, number>;
  const imageOps = new Set(
    ["paintImageXObject", "paintInlineImageXObject", "paintImageMaskXObject", "paintImageXObjectRepeat", "paintImageMaskXObjectRepeat"]
      .map((k) => O[k])
      .filter((v) => typeof v === "number"),
  );
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const rects: Rect[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? ctm;
    else if (fn === O.transform) ctm = mul(args as number[], ctm);
    else if (fn === O.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args[0] as number[] | null;
      if (m) ctm = mul(m, ctm);
    } else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (imageOps.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) =>
        view.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]),
      );
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      if (r.w > 4 && r.h > 4 && r.w <= view.width * 1.05 && r.h <= view.height * 1.05) rects.push(r);
    }
  }
  return rects;
}

/** Ink and paper colours inside a region of the rendered page. */
function sampleRegion(canvas: HTMLCanvasElement, view: PageViewport, r: Rect): { ink: string; paper: string } {
  const fallback = { ink: "#172033", paper: "#ffffff" };
  const ctx = canvas.getContext("2d");
  if (!ctx || !canvas.width) return fallback;
  const sx = canvas.width / view.width;
  const sy = canvas.height / view.height;
  const x = Math.max(0, Math.floor(r.x * sx));
  const y = Math.max(0, Math.floor(r.y * sy));
  const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(r.w * sx)));
  const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(r.h * sy)));
  const data = ctx.getImageData(x, y, w, h).data;
  const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let dark = 0;
  let darkL = Infinity;
  const step = Math.max(1, Math.floor((w * h) / 30000));
  for (let i = 0; i < data.length; i += 4 * step) {
    const l = lum(i);
    if (l < darkL) {
      darkL = l;
      dark = i;
    }
  }
  // Paper: brightest common tone along the edges of the region.
  const edge: number[] = [];
  for (let px = 0; px < w; px++) edge.push(px * 4, ((h - 1) * w + px) * 4);
  for (let py = 0; py < h; py++) edge.push(py * w * 4, (py * w + w - 1) * 4);
  let paper = [255, 255, 255];
  let best = -1;
  for (const i of edge) {
    const l = lum(i);
    if (l > best) {
      best = l;
      paper = [data[i], data[i + 1], data[i + 2]];
    }
  }
  return {
    ink: darkL < 170 ? hex([data[dark], data[dark + 1], data[dark + 2]]) : fallback.ink,
    paper: best >= 0 ? hex(paper) : fallback.paper,
  };
}

/** Snap a drag from `a` to `b` onto the text rows it sweeps across. */
function highlightRects(lines: Line[], a: Point, b: Point, fallback: number) {
  const find = (p: Point) => {
    let best = -1;
    let bestDist = Infinity;
    lines.forEach((l, i) => {
      const pad = (l.y1 - l.y0) * 0.35;
      if (p.y < l.y0 - pad || p.y > l.y1 + pad) return;
      const cx = Math.min(Math.max(p.x, l.x0), l.x1);
      const dist = Math.abs(cx - p.x);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  };
  let ia = find(a);
  let ib = find(b);
  if (ia === -1 && ib === -1) {
    // Free-form highlight when there is no text under the pointer.
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y) - fallback / 2;
    return [{ x, y, w: Math.max(2, Math.abs(b.x - a.x)), h: fallback }];
  }
  if (ia === -1) ia = ib;
  if (ib === -1) ib = ia;
  let [p0, p1] = [a, b];
  if (ia > ib || (ia === ib && a.x > b.x)) {
    [ia, ib] = [ib, ia];
    [p0, p1] = [b, a];
  }
  const rects: Rect[] = [];
  for (let i = ia; i <= ib; i++) {
    const l = lines[i];
    const xs = i === ia ? Math.max(l.x0, Math.min(p0.x, l.x1)) : l.x0;
    const xe = i === ib ? Math.min(l.x1, Math.max(p1.x, l.x0)) : l.x1;
    if (xe - xs < 1) continue;
    const pad = (l.y1 - l.y0) * 0.08;
    rects.push({ x: xs, y: l.y0 - pad, w: xe - xs, h: l.y1 - l.y0 + pad * 2 });
  }
  return rects.length ? rects : [{ x: p0.x, y: p0.y, w: 2, h: fallback }];
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not export the annotation layer.")),
      "image/png",
    );
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

type Annotations = Record<number, Item[]>;
type StructSnapshot = { pdf: PDFDocumentProxy; source: Uint8Array; baseSource: Uint8Array; annotations: Annotations };
/** Everything that belongs to one open file; swapped in and out when tabs change. */
type DocState = {
  pdf: PDFDocumentProxy;
  /** Bytes currently shown and exported (lifted originals already deleted). */
  source: Uint8Array;
  /** Bytes with nothing deleted; live removals are re-applied from here. */
  baseSource: Uint8Array;
  exportName: string;
  annotations: Annotations;
  history: Record<number, Item[][]>;
  future: Record<number, Item[][]>;
  structHistory: StructSnapshot[];
  pageNumber: number;
  zoom: number;
  watermark: Watermark | null;
};
type Doc = { id: string; name: string; tone: number; state: DocState };

/** Soft tab colours, Chrome-style: a weak tint, a lighter tint for the
 * gradient, and a strong accent for the file icon. */
const TAB_TONES = [
  { tint: "#dbe7fe", light: "#f1f6ff", strong: "#2563eb" },
  { tint: "#ede4fe", light: "#f7f4ff", strong: "#7c3aed" },
  { tint: "#cdf5ea", light: "#effdf8", strong: "#0d9488" },
  { tint: "#fdecc8", light: "#fff8ea", strong: "#d97706" },
  { tint: "#ffe1e6", light: "#fff3f5", strong: "#e11d48" },
  { tint: "#d9f7e3", light: "#f1fdf5", strong: "#16a34a" },
];
function tabStyle(tone: number): CSSProperties {
  const t = TAB_TONES[tone % TAB_TONES.length];
  return { "--tab-tint": t.tint, "--tab-light": t.light, "--tab-strong": t.strong } as CSSProperties;
}

function freshDocState(pdf: PDFDocumentProxy, source: Uint8Array, exportName: string, annotations: Annotations = {}): DocState {
  return { pdf, source, baseSource: source, exportName, annotations, history: {}, future: {}, structHistory: [], pageNumber: 1, zoom: 1, watermark: null };
}

/** Move items to where they land after the page turns `delta` degrees clockwise.
 * W/H are the page's viewport size before the turn. Text and images keep their
 * size and stay upright; only their centre moves. */
function rotateItems(items: Item[], delta: number, W: number, H: number): Item[] {
  const turns = (((delta / 90) % 4) + 4) % 4;
  if (!turns) return items;
  const pt = (p: Point): Point =>
    turns === 1 ? { x: H - p.y, y: p.x } : turns === 2 ? { x: W - p.x, y: H - p.y } : { x: p.y, y: W - p.x };
  const rect = (r: Rect): Rect => {
    const a = pt({ x: r.x, y: r.y });
    const b = pt({ x: r.x + r.w, y: r.y + r.h });
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  };
  return items.map((i) => {
    if (i.kind === "stroke") return { ...i, points: i.points.map(pt) };
    if (i.kind === "highlight") return { ...i, rects: i.rects.map(rect) };
    if (i.kind === "cover") {
      const r = rect({ x: i.x, y: i.y, w: i.width, h: i.height });
      return { ...i, x: r.x, y: r.y, width: r.w, height: r.h };
    }
    const r = itemRect(i);
    const c = pt({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    return { ...i, x: c.x - r.w / 2, y: c.y - r.h / 2 };
  });
}

function shiftItems(items: Item[], dx: number, dy: number): Item[] {
  return items.map((i) =>
    i.kind === "stroke"
      ? { ...i, points: i.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) }
      : i.kind === "highlight"
        ? { ...i, rects: i.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) }
        : { ...i, x: i.x + dx, y: i.y + dy },
  );
}

/** Re-key annotations for a new page order: `order[i]` is the 1-based old page that becomes page i+1. */
function remapAnnotations(ann: Annotations, order: number[]): Annotations {
  const out: Annotations = {};
  order.forEach((oldPage, i) => {
    if (ann[oldPage]?.length) out[i + 1] = ann[oldPage];
  });
  return out;
}

async function rotatePdfPage(bytes: Uint8Array, index: number, delta: number) {
  const doc = await PDFDocument.load(bytes.slice());
  const page = doc.getPage(index);
  page.setRotation(degrees((((page.getRotation().angle + delta) % 360) + 360) % 360));
  return doc.save();
}

async function cropPdfPage(bytes: Uint8Array, index: number, box: Rect) {
  const doc = await PDFDocument.load(bytes.slice());
  doc.getPage(index).setCropBox(box.x, box.y, box.w, box.h);
  return doc.save();
}

/** Build a new document from `order` (0-based page indices of `bytes`). Used for reorder, remove and extract. */
async function pickPdfPages(bytes: Uint8Array, order: number[]) {
  const src = await PDFDocument.load(bytes.slice());
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(src, order)) out.addPage(page);
  return out.save();
}

async function mergePdfs(sources: Uint8Array[]) {
  const out = await PDFDocument.create();
  for (const bytes of sources) {
    const src = await PDFDocument.load(bytes.slice());
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
  }
  return out.save();
}

function pdfColor(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return rgb(0.09, 0.13, 0.2);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

function pct(value: number, total: number) {
  return `${(value / total) * 100}%`;
}

export default function App() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [source, setSource] = useState<Uint8Array | null>(null);
  const [filename, setFilename] = useState("document-edited");
  const [pageNumber, setPageNumber] = useState(1);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [textLines, setTextLines] = useState<Line[]>([]);
  const [annotations, setAnnotations] = useState<Record<number, Item[]>>({});
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [highlightColor, setHighlightColor] = useState(DEFAULT_HIGHLIGHT);
  const [size, setSize] = useState(18);
  const [signSize, setSignSize] = useState(36);
  const [signText, setSignText] = useState("");
  const [textStyle, setTextStyle] = useState({ bold: false, italic: false, underline: false, strike: false });
  const [imageRegions, setImageRegions] = useState<Rect[]>([]);
  const [hoverRegion, setHoverRegion] = useState<Rect | null>(null);
  const hoverKey = useRef("");
  const [ocr, setOcr] = useState({ running: false, progress: 0 });
  // OCR results per page of the active file; cleared when the file or its pages change.
  const ocrCache = useRef<Record<number, Line[]>>({});
  const [watermark, setWatermark] = useState<Watermark | null>(null);
  const [baseSource, setBaseSource] = useState<Uint8Array | null>(null);
  // Live removal bookkeeping: which cover set the shown document reflects, a
  // run counter to drop stale rebuilds, and a flag so the page re-render that
  // follows a rebuild keeps the current selection.
  const removalKey = useRef("");
  const removalRun = useRef(0);
  const keepSelection = useRef(false);
  const [wmOpen, setWmOpen] = useState(false);
  const wmRoot = useRef<HTMLDivElement>(null);
  const [font, setFont] = useState("Arial");
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [draft, setDraft] = useState<Item | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cssScale, setCssScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const structHistory = useRef<StructSnapshot[]>([]);
  const toneSeq = useRef(0);
  const newDoc = (name: string, state: DocState): Doc => ({ id: uid(), name, tone: toneSeq.current++, state });
  const [organizing, setOrganizing] = useState(false);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [dragPage, setDragPage] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const [cropRect, setCropRect] = useState<Rect | null>(null);
  const [cropPending, setCropPending] = useState(false);
  const cropDrag = useRef<{ mode: "move" | "resize" | "draw"; handle?: Handle; start: Point; orig: Rect } | null>(null);

  const pageCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const highlightCanvas = useRef<HTMLCanvasElement>(null);
  const pageBox = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const floatbar = useRef<HTMLDivElement>(null);
  // True while a pointer is down inside the floating toolbar, so the text box
  // being edited survives the focus change (Safari gives blur no relatedTarget).
  const barPress = useRef(false);
  const skipFocusHistory = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvasBox = useRef<HTMLElement>(null);
  const panelRoot = useRef<HTMLDivElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const prevZoom = useRef(1);
  const pageProxy = useRef<PDFPageProxy | null>(null);
  // Last known page size, so the sheet keeps its footprint while re-rendering.
  const lastViewport = useRef<PageViewport | null>(null);
  const bitmapTask = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);

  useEffect(() => {
    if (!panelOpen) return;
    function onDown(event: PointerEvent) {
      if (!panelRoot.current?.contains(event.target as Node)) setPanelOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [panelOpen]);

  useEffect(() => {
    if (!wmOpen) return;
    function onDown(event: PointerEvent) {
      if (!wmRoot.current?.contains(event.target as Node)) setWmOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [wmOpen]);

  /** Rasterise the page into the canvas, sharp enough for the current zoom. */
  async function drawBitmap(
    page: PDFPageProxy,
    view: PageViewport,
    canvas: HTMLCanvasElement,
    zoomLevel: number,
  ) {
    bitmapTask.current?.cancel();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const density = Math.min(6, (window.devicePixelRatio || 1) * Math.max(1, zoomLevel));
    canvas.width = Math.ceil(view.width * density);
    canvas.height = Math.ceil(view.height * density);
    const task = page.render({
      canvas,
      canvasContext: ctx,
      viewport: view,
      transform: [canvas.width / view.width, 0, 0, canvas.height / view.height, 0, 0],
    });
    bitmapTask.current = task;
    try {
      await task.promise;
    } finally {
      if (bitmapTask.current === task) bitmapTask.current = null;
    }
  }

  function zoomBy(factor: number, anchor: { x: number; y: number } | null = null) {
    zoomAnchor.current = anchor;
    setZoom((z) => clampZoom(z * factor));
  }
  const drag = useRef<Drag | null>(null);
  const itemsRef = useRef<Record<number, Item[]>>({});
  const history = useRef<Record<number, Item[][]>>({});
  const future = useRef<Record<number, Item[][]>>({});
  itemsRef.current = annotations;

  const items = annotations[pageNumber] ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const editing =
    (items.find((i) => i.id === editingId) as TextItem | undefined) ?? null;

  // Render the current page.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    setViewport(null);
    setTextLines([]);
    drag.current = null;
    setDraft(null);
    if (keepSelection.current) keepSelection.current = false;
    else {
      setSelectedId(null);
      setEditingId(null);
    }
    async function renderPage() {
      try {
        const page = await pdf!.getPage(pageNumber);
        if (cancelled) return;
        const view = page.getViewport({ scale: 1.25 });
        const canvas = pageCanvas.current;
        if (!canvas) return;
        pageProxy.current = page;
        await drawBitmap(page, view, canvas, zoomRef.current);
        if (cancelled) return;
        lastViewport.current = view;
        setViewport(view);
        const content = await page.getTextContent();
        const fontOf = (name: string): FontInfo => {
          let f: { name?: string; isSerifFont?: boolean; isMonospace?: boolean } | null = null;
          try {
            f = name && page.commonObjs.has(name) ? page.commonObjs.get(name) : null;
          } catch {
            f = null;
          }
          const nm = (f?.name ?? "").toLowerCase();
          return {
            bold: /bold|black|heavy|semibold|demibold/.test(nm),
            italic: /italic|oblique/.test(nm),
            family:
              f?.isMonospace || /courier|mono/.test(nm)
                ? "Courier New"
                : f?.isSerifFont || /times|georgia|serif|garamond|book|roman/.test(nm)
                  ? "Times New Roman"
                  : "Arial",
          };
        };
        const lines = buildLines(content.items, view, fontOf);
        if (!cancelled) setTextLines(lines.length ? lines : (ocrCache.current[pageNumber] ?? lines));
      } catch (error) {
        if (cancelled || error instanceof RenderingCancelledException) return;
        setStatus(`Preview error: ${message(error)}`);
      }
    }
    void renderPage();
    return () => {
      cancelled = true;
      bitmapTask.current?.cancel();
    };
    // `organizing` is included because leaving the page grid remounts the
    // canvas element, which then needs painting again.
  }, [pdf, pageNumber, organizing]);

  // Re-rasterise at the new zoom (debounced) so the page stays crisp, and keep
  // the point under the cursor (or the centre of the view) fixed while zooming.
  useEffect(() => {
    const box = canvasBox.current;
    const from = prevZoom.current;
    prevZoom.current = zoom;
    zoomRef.current = zoom;
    if (box && from !== zoom) {
      const rect = box.getBoundingClientRect();
      const anchor = zoomAnchor.current ?? { x: rect.width / 2, y: rect.height / 2 };
      const ratio = zoom / from;
      box.scrollLeft = (box.scrollLeft + anchor.x) * ratio - anchor.x;
      box.scrollTop = (box.scrollTop + anchor.y) * ratio - anchor.y;
    }
    zoomAnchor.current = null;
    const page = pageProxy.current;
    const canvas = pageCanvas.current;
    if (!page || !canvas || !viewport) return;
    const id = window.setTimeout(() => {
      drawBitmap(page, viewport, canvas, zoom).catch(() => undefined);
    }, 150);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Ctrl/⌘ + wheel (and trackpad pinch, which the browser reports the same way).
  useEffect(() => {
    const box = canvasBox.current;
    if (!box) return;
    function onWheel(event: WheelEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = box!.getBoundingClientRect();
      // Mouse wheels report ~100px per notch, trackpad pinches a few px per
      // event; cap the step so a notch is ~1.2x and a pinch stays smooth.
      const delta = Math.max(-25, Math.min(25, event.deltaMode === 1 ? event.deltaY * 20 : event.deltaY));
      zoomBy(Math.exp(-delta * 0.008), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    }
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  // The Edit tool needs to know where the page's images are.
  useEffect(() => {
    setImageRegions([]);
    setHoverRegion(null);
    hoverKey.current = "";
    const page = pageProxy.current;
    if (tool !== "edit" || !viewport || !page) return;
    let cancelled = false;
    findImageRegions(page, viewport)
      .then((rects) => {
        if (!cancelled) setImageRegions(rects);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tool, viewport]);

  // Start a crop once the page it targets has rendered.
  useEffect(() => {
    if (!cropPending || !viewport) return;
    setCropPending(false);
    const inset = Math.round(Math.min(viewport.width, viewport.height) * 0.08);
    setCropRect({ x: inset, y: inset, w: viewport.width - inset * 2, h: viewport.height - inset * 2 });
  }, [cropPending, viewport]);

  // Live removal: rebuild the shown document from the untouched base with every
  // lifted original deleted, whenever the set of lifted originals changes.
  // Undo, redo, delete and Clear all therefore bring originals back for free.
  useEffect(() => {
    if (!pdf || !baseSource) return;
    const pending: { page: number; id: string; removal: Removal }[] = [];
    for (const [key, list] of Object.entries(annotations)) {
      for (const it of list) if (it.kind === "cover" && it.removal) pending.push({ page: Number(key), id: it.id, removal: it.removal });
    }
    const key = pending.map((p) => `${p.page}:${p.id}`).sort().join("|");
    if (key === removalKey.current) return;
    removalKey.current = key;
    const run = ++removalRun.current;
    const currentPdf = pdf;
    (async () => {
      let nextBytes = baseSource;
      const strippedIds = new Set<string>();
      if (pending.length) {
        const doc = await PDFDocument.load(baseSource.slice());
        const pages = [...new Set(pending.map((p) => p.page))];
        for (const page of pages) {
          const onPage = pending.filter((p) => p.page === page);
          const view = (await currentPdf.getPage(page)).getViewport({ scale: 1.25 });
          const ok = stripFromPage(doc, page - 1, view, onPage.map((p) => p.removal));
          onPage.forEach((p, k) => {
            if (ok[k]) strippedIds.add(p.id);
          });
        }
        nextBytes = strippedIds.size ? await doc.save() : baseSource;
      }
      if (run !== removalRun.current) return;
      const nextPdf = nextBytes === baseSource && source === baseSource ? currentPdf : await getDocument({ data: nextBytes.slice() }).promise;
      if (run !== removalRun.current) return;
      // Record which covers no longer need painting (no history entry).
      setAnnotations((current) => {
        let changed = false;
        const next: Annotations = {};
        for (const [k, list] of Object.entries(current)) {
          next[Number(k)] = list.map((it) => {
            if (it.kind !== "cover") return it;
            const stripped = it.removal ? strippedIds.has(it.id) : !!it.stripped;
            if (stripped === !!it.stripped) return it;
            changed = true;
            return { ...it, stripped };
          });
        }
        return changed ? next : current;
      });
      if (nextPdf !== currentPdf) {
        keepSelection.current = true;
        setSource(nextBytes);
        setPdf(nextPdf);
      }
    })().catch((error) => setStatus(`Could not update page content: ${message(error)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotations, baseSource]);

  // Paint annotations; repaint once any web fonts finish loading.
  useEffect(() => {
    if (!viewport || !overlayCanvas.current) return;
    const canvas = overlayCanvas.current;
    const visible = items.filter((i) => !(i.kind === "cover" && i.stripped));
    const all = draft ? [...visible, draft] : visible;
    if (highlightCanvas.current) paint(highlightCanvas.current, viewport, all, editingId, "highlights", watermark);
    paint(canvas, viewport, all, editingId, "marks");
    const fonts = all.filter((i): i is TextItem => i.kind === "text");
    if (!fonts.length) return;
    let cancelled = false;
    Promise.all(fonts.map((i) => document.fonts.load(fontString(i))))
      .then(() => {
        if (!cancelled) paint(canvas, viewport, all, editingId, "marks");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [viewport, items, draft, editingId, watermark]);

  // Track how much the page is scaled down by CSS (narrow screens).
  useEffect(() => {
    const el = pageBox.current;
    if (!el || !viewport) return;
    const update = () =>
      setCssScale(el.getBoundingClientRect().width / viewport.width || 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewport]);

  useEffect(() => {
    if (!editingId) return;
    const id = window.setTimeout(
      () => textarea.current?.focus({ preventScroll: true }),
      0,
    );
    return () => window.clearTimeout(id);
  }, [editingId]);

  // Paste a PDF (or an image, once a PDF is open) from the clipboard.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const files = Array.from(event.clipboardData?.files ?? []);
      const pdfFile = files.find(
        (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
      );
      if (pdfFile) {
        event.preventDefault();
        void openPdf(pdfFile);
        return;
      }
      const imageFile = files.find((f) => f.type.startsWith("image/"));
      if (imageFile && pdf) {
        event.preventDefault();
        void openImage(imageFile);
      } else if (files.length && !pdf) {
        setStatus("That is not a PDF. Paste or open a PDF file to get started.");
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  function onDrop(event: ReactDragEvent) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const pdfFiles = files.filter(
      (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
    );
    if (pdfFiles.length) {
      void openPdfs(pdfFiles);
      return;
    }
    const imageFile = files.find((f) => f.type.startsWith("image/"));
    if (imageFile && pdf) void openImage(imageFile);
    else if (files.length) setStatus("Drop a PDF file to open it.");
  }

  // Keyboard: delete the selection, escape to deselect.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT");
      // Escape (and Enter outside a text field) backs out of whatever is
      // active and returns to the Select tool.
      const onControl =
        target instanceof Element && !!target.closest('button, a, [role="button"], [role="tab"]');
      if (event.key === "Escape" || (event.key === "Enter" && !typing && !onControl)) {
        if (typing && event.key === "Escape") (target as HTMLElement).blur();
        if (cropRect) setCropRect(null);
        if (editingId) finishEditing();
        if (organizing) setOrganizing(false);
        setPanelOpen(false);
        setSelectedId(null);
        if (tool !== "select") pickTool("select");
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      // Undo / redo work everywhere except inside a text field, where the
      // browser's own text undo takes over.
      if (mod && !typing && key === "z") {
        event.preventDefault();
        if (organizing) {
          if (!event.shiftKey) undoStructure();
        } else if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !typing && key === "y") {
        event.preventDefault();
        if (!organizing) redo();
        return;
      }
      if (organizing && pdf && !typing) {
        if (mod && key === "a") {
          event.preventDefault();
          setSelectedPages(new Set(Array.from({ length: pdf.numPages }, (_, i) => i)));
          return;
        }
        if ((event.key === "Delete" || event.key === "Backspace") && selectedPages.size) {
          event.preventDefault();
          void removePages([...selectedPages]);
          return;
        }
      }
      if (mod && key === "o") {
        event.preventDefault();
        if (!busy) fileInput.current?.click();
        return;
      }
      if (mod && (key === "=" || key === "+")) {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
        return;
      }
      if (mod && key === "-") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
        return;
      }
      if (mod && key === "0") {
        event.preventDefault();
        setZoom(1);
        return;
      }
      // Text formatting: ⌘/Ctrl+B, I, U and ⌘/Ctrl+Shift+X (strikethrough).
      // Works on the selected text box, including while typing inside it.
      const textTarget =
        editing ?? (selected?.kind === "text" ? selected : null);
      if (mod && textTarget && (!typing || target === textarea.current)) {
        const format: Partial<Record<string, "bold" | "italic" | "underline" | "strike">> = {
          b: "bold",
          i: "italic",
          u: "underline",
        };
        const field = event.shiftKey && key === "x" ? "strike" : !event.shiftKey ? format[key] : undefined;
        if (field) {
          event.preventDefault();
          updateItem(textTarget.id, { [field]: !textTarget[field] });
          return;
        }
      }
      if (typing) return;
      // Left/Right arrows flip pages (unless a box is being edited).
      if (!mod && !event.altKey && pdf && !busy && !editingId && !cropRect) {
        if (event.key === "ArrowLeft" && pageNumber > 1) {
          event.preventDefault();
          finishEditing();
          setPageNumber((n) => Math.max(1, n - 1));
          return;
        }
        if (event.key === "ArrowRight" && pageNumber < pdf.numPages) {
          event.preventDefault();
          finishEditing();
          setPageNumber((n) => Math.min(pdf.numPages, n + 1));
          return;
        }
        // Up/Down arrows scroll the page area.
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && canvasBox.current) {
          event.preventDefault();
          canvasBox.current.scrollBy({
            top: (event.key === "ArrowDown" ? 1 : -1) * (event.shiftKey ? 320 : 96),
            behavior: "smooth",
          });
          return;
        }
      }
      if (!mod && !event.altKey && pdf && !busy) {
        const byKey: Record<string, Tool> = {
          v: "select",
          t: "text",
          d: "draw",
          h: "highlight",
          s: "sign",
          i: "image",
          e: "edit",
        };
        // Digits pick tools in rail order: 1 Select, 2 Text, 3 Draw, ...
        const next = byKey[key] ?? TOOL_ORDER[Number(key) - 1];
        if (next) {
          event.preventDefault();
          pickTool(next);
          return;
        }
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        removeItem(selectedId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function pushHistory(snapshot: Item[]) {
    const stack = history.current[pageNumber] ?? [];
    history.current[pageNumber] = [...stack.slice(-49), snapshot];
    // A new change invalidates anything that could be redone.
    future.current[pageNumber] = [];
  }

  function setItems(next: Item[], record = true) {
    if (record) pushHistory(itemsRef.current[pageNumber] ?? []);
    setAnnotations((current) => ({ ...current, [pageNumber]: next }));
  }

  function addItem(item: Item) {
    setItems([...(itemsRef.current[pageNumber] ?? []), item]);
  }

  function updateItem(id: string, patch: Partial<Item>, record = true) {
    setItems(
      (itemsRef.current[pageNumber] ?? []).map((i) =>
        i.id === id ? ({ ...i, ...patch } as Item) : i,
      ),
      record,
    );
  }

  function removeItem(id: string) {
    setItems((itemsRef.current[pageNumber] ?? []).filter((i) => i.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (editingId === id) setEditingId(null);
  }

  /** Remove every annotation on every page; each page stays undoable. */
  function clearAll() {
    const pages = Object.entries(itemsRef.current).filter(([, list]) => list.length);
    const count = pages.reduce((n, [, list]) => n + list.length, 0);
    if (!count) return;
    for (const [key, list] of pages) {
      const n = Number(key);
      history.current[n] = [...(history.current[n] ?? []).slice(-49), list];
      future.current[n] = [];
    }
    setEditingId(null);
    setSelectedId(null);
    setAnnotations({});
    setStatus(
      count === 1 ? "Annotation removed" : `${count} annotations removed`,
    );
  }

  function undo() {
    const stack = history.current[pageNumber] ?? [];
    const previous = stack.pop();
    if (!previous) return;
    const redoStack = future.current[pageNumber] ?? [];
    future.current[pageNumber] = [
      ...redoStack.slice(-49),
      itemsRef.current[pageNumber] ?? [],
    ];
    setEditingId(null);
    setSelectedId(null);
    setAnnotations((current) => ({ ...current, [pageNumber]: previous }));
    setStatus("Undone");
  }

  function redo() {
    const redoStack = future.current[pageNumber] ?? [];
    const next = redoStack.pop();
    if (!next) return;
    const stack = history.current[pageNumber] ?? [];
    history.current[pageNumber] = [
      ...stack.slice(-49),
      itemsRef.current[pageNumber] ?? [],
    ];
    setEditingId(null);
    setSelectedId(null);
    setAnnotations((current) => ({ ...current, [pageNumber]: next }));
    setStatus("Redone");
  }

  /** Snapshot of the active file, taken before switching or closing tabs. */
  function snapshotState(): DocState {
    return {
      pdf: pdf!,
      source: source!,
      baseSource: baseSource ?? source!,
      exportName: filename,
      annotations: itemsRef.current,
      history: history.current,
      future: future.current,
      structHistory: structHistory.current,
      pageNumber,
      zoom,
      watermark,
    };
  }

  function loadState(state: DocState) {
    setPdf(state.pdf);
    setSource(state.source);
    setBaseSource(state.baseSource);
    removalKey.current = "";
    setFilename(state.exportName);
    setAnnotations(state.annotations);
    history.current = state.history;
    future.current = state.future;
    structHistory.current = state.structHistory;
    setPageNumber(state.pageNumber);
    setZoom(state.zoom);
    setWatermark(state.watermark);
    ocrCache.current = {};
    setSelectedId(null);
    setEditingId(null);
    setSelectedPages(new Set());
    setCropRect(null);
  }

  /** Add files as tabs (saving the current one first) and show the last of them. */
  function addDocs(added: Doc[]) {
    if (!added.length) return;
    setDocs((list) => [
      ...list.map((d) => (d.id === activeDocId && pdf && source ? { ...d, state: snapshotState() } : d)),
      ...added,
    ]);
    const last = added[added.length - 1];
    loadState(last.state);
    setActiveDocId(last.id);
  }

  function activateDoc(id: string) {
    if (id === activeDocId) return;
    const target = docs.find((d) => d.id === id);
    if (!target) return;
    finishEditing();
    setDocs((list) => list.map((d) => (d.id === activeDocId && pdf && source ? { ...d, state: snapshotState() } : d)));
    loadState(target.state);
    setActiveDocId(id);
  }

  function closeDoc(id: string) {
    const index = docs.findIndex((d) => d.id === id);
    if (index < 0) return;
    const remaining = docs.filter((d) => d.id !== id);
    setDocs(remaining);
    if (id !== activeDocId) return;
    const next = remaining[Math.min(index, remaining.length - 1)];
    if (next) {
      loadState(next.state);
      setActiveDocId(next.id);
    } else {
      setPdf(null);
      setSource(null);
      setBaseSource(null);
      removalKey.current = "";
      setAnnotations({});
      history.current = {};
      future.current = {};
      structHistory.current = [];
      ocrCache.current = {};
      setWatermark(null);
      setActiveDocId(null);
      setOrganizing(false);
      setCropRect(null);
    }
    setStatus("File closed");
  }

  async function openPdfs(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setStatus(files.length === 1 ? "Opening file…" : "Opening files…");
    const added: Doc[] = [];
    try {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        // PDF.js can transfer ownership of its buffer; keep a separate copy.
        const document = await getDocument({ data: bytes.slice() }).promise;
        const name = file.name.replace(/\.pdf$/i, "");
        added.push(newDoc(name, freshDocState(document, bytes, `${name}-edited`)));
      }
      addDocs(added);
      setStatus(added.length === 1 ? "Opened new file" : `Opened ${added.length} files`);
    } catch (error) {
      addDocs(added);
      setStatus(`Could not open PDF: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }
  const openPdf = (file: File) => openPdfs([file]);

  // ---- Page organisation: rotate, crop, reorder, remove, extract, combine ----

  /** Swap in a restructured document, keeping the previous one for undo. */
  async function applyStructure(nextBytes: Uint8Array, nextAnnotations: Annotations, statusText: string, nextPage?: number) {
    if (!pdf || !source) return;
    setBusy(true);
    try {
      const nextPdf = await getDocument({ data: nextBytes.slice() }).promise;
      structHistory.current = [
        ...structHistory.current.slice(-9),
        { pdf, source, baseSource: baseSource ?? source, annotations: itemsRef.current },
      ];
      finishEditing();
      // The rebuilt file already has lifted originals deleted; it becomes the
      // new base, and its covers are baked (no longer re-applied or painted).
      const baked: Annotations = {};
      for (const [k, list] of Object.entries(nextAnnotations)) {
        baked[Number(k)] = list.map((it) =>
          it.kind === "cover" && it.removal ? { ...it, removal: undefined, stripped: it.stripped ?? true } : it,
        );
      }
      setBaseSource(nextBytes);
      removalKey.current = "";
      setSource(nextBytes);
      setPdf(nextPdf);
      setAnnotations(baked);
      // Per-page item history no longer lines up with the pages; start fresh.
      history.current = {};
      future.current = {};
      ocrCache.current = {};
      setPageNumber(Math.min(Math.max(1, nextPage ?? pageNumber), nextPdf.numPages));
      setSelectedId(null);
      setSelectedPages(new Set());
      setStatus(statusText);
    } catch (error) {
      setStatus(`Could not change pages: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function undoStructure() {
    const snap = structHistory.current.pop();
    if (!snap) return;
    setBaseSource(snap.baseSource);
    removalKey.current = "";
    setSource(snap.source);
    setPdf(snap.pdf);
    setAnnotations(snap.annotations);
    history.current = {};
    future.current = {};
    setPageNumber((n) => Math.min(n, snap.pdf.numPages));
    setSelectedPages(new Set());
    setStatus("Page change undone");
  }

  async function rotatePage(index: number, delta: number) {
    if (!pdf || !source) return;
    const view = (await pdf.getPage(index + 1)).getViewport({ scale: 1.25 });
    const bytes = await rotatePdfPage(source, index, delta);
    const items = itemsRef.current;
    await applyStructure(
      bytes,
      { ...items, [index + 1]: rotateItems(items[index + 1] ?? [], delta, view.width, view.height) },
      "Page rotated",
    );
  }

  async function removePages(indices: number[]) {
    if (!pdf || !source) return;
    const gone = new Set(indices);
    const keep = Array.from({ length: pdf.numPages }, (_, i) => i).filter((i) => !gone.has(i));
    if (!keep.length) {
      setStatus("A file needs at least one page");
      return;
    }
    const bytes = await pickPdfPages(source, keep);
    await applyStructure(
      bytes,
      remapAnnotations(itemsRef.current, keep.map((i) => i + 1)),
      gone.size === 1 ? "Page removed" : `${gone.size} pages removed`,
      Math.min(pageNumber, keep.length),
    );
  }

  async function movePage(from: number, to: number) {
    if (!pdf || !source || from === to) return;
    const order = Array.from({ length: pdf.numPages }, (_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    const bytes = await pickPdfPages(source, order);
    await applyStructure(bytes, remapAnnotations(itemsRef.current, order.map((i) => i + 1)), "Page moved", to + 1);
  }

  async function extractPages(indices: number[]) {
    if (!pdf || !source || !indices.length) return;
    const order = [...indices].sort((a, b) => a - b);
    setBusy(true);
    try {
      const bytes = await pickPdfPages(source, order);
      const nextPdf = await getDocument({ data: bytes.slice() }).promise;
      const base = docs.find((d) => d.id === activeDocId)?.name ?? "document";
      const name = `${base} (${order.length === 1 ? `page ${order[0] + 1}` : `${order.length} pages`})`;
      addDocs([newDoc(name, freshDocState(nextPdf, bytes, name, remapAnnotations(itemsRef.current, order.map((i) => i + 1))))]);
      setOrganizing(true);
      setStatus("Pages extracted to new file");
    } catch (error) {
      setStatus(`Could not extract pages: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function combineAll() {
    if (docs.length < 2 || !pdf || !source) return;
    setBusy(true);
    try {
      const all = docs.map((d) => (d.id === activeDocId ? { ...d, state: snapshotState() } : d));
      const bytes = await mergePdfs(all.map((d) => d.state.source));
      const nextPdf = await getDocument({ data: bytes.slice() }).promise;
      const annotations: Annotations = {};
      let offset = 0;
      for (const d of all) {
        for (const [key, list] of Object.entries(d.state.annotations)) {
          if (list.length) annotations[Number(key) + offset] = list;
        }
        offset += d.state.pdf.numPages;
      }
      addDocs([newDoc("Combined", freshDocState(nextPdf, bytes, "Combined", annotations))]);
      setOrganizing(true);
      setStatus(`${all.length} files combined`);
    } catch (error) {
      setStatus(`Could not combine files: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function startCrop(index: number) {
    setOrganizing(false);
    setPageNumber(index + 1);
    setCropPending(true);
  }

  async function applyCrop() {
    if (!cropRect || !viewport || !source || !pdf) return;
    const a = viewport.convertToPdfPoint(cropRect.x, cropRect.y);
    const b = viewport.convertToPdfPoint(cropRect.x + cropRect.w, cropRect.y + cropRect.h);
    const box = { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
    const bytes = await cropPdfPage(source, pageNumber - 1, box);
    const items = itemsRef.current;
    setCropRect(null);
    await applyStructure(bytes, { ...items, [pageNumber]: shiftItems(items[pageNumber] ?? [], -cropRect.x, -cropRect.y) }, "Page cropped");
  }

  function cropPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!cropRect || !viewport || event.button !== 0) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    const handle = target.dataset.handle as Handle | undefined;
    const p = point(event);
    const inside = inRect(p, cropRect);
    cropDrag.current = handle
      ? { mode: "resize", handle, start: p, orig: cropRect }
      : inside
        ? { mode: "move", start: p, orig: cropRect }
        : { mode: "draw", start: p, orig: { x: p.x, y: p.y, w: 0, h: 0 } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function cropPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const d = cropDrag.current;
    if (!d || !viewport) return;
    const p = point(event);
    const clampX = (x: number) => Math.min(viewport.width, Math.max(0, x));
    const clampY = (y: number) => Math.min(viewport.height, Math.max(0, y));
    const o = d.orig;
    if (d.mode === "move") {
      const x = Math.min(viewport.width - o.w, Math.max(0, o.x + p.x - d.start.x));
      const y = Math.min(viewport.height - o.h, Math.max(0, o.y + p.y - d.start.y));
      setCropRect({ ...o, x, y });
      return;
    }
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (d.mode === "draw") {
      x0 = d.start.x; y0 = d.start.y; x1 = clampX(p.x); y1 = clampY(p.y);
    } else {
      const h = d.handle!;
      if (h.includes("w")) x0 = clampX(p.x);
      if (h.includes("e")) x1 = clampX(p.x);
      if (h.startsWith("n")) y0 = clampY(p.y);
      if (h.startsWith("s")) y1 = clampY(p.y);
    }
    const x = Math.min(x0, x1), y = Math.min(y0, y1);
    setCropRect({ x, y, w: Math.max(16, Math.abs(x1 - x0)), h: Math.max(16, Math.abs(y1 - y0)) });
  }

  function cropPointerUp() {
    cropDrag.current = null;
  }

  async function openImage(file: File) {
    const url = URL.createObjectURL(file);
    try {
      const loaded = new Image();
      loaded.src = url;
      await loaded.decode();
      setImage(loaded);
      setTool("image");
      setStatus("Click the page to place the image, then drag it or its corners.");
    } catch {
      setStatus("Could not read that image. Try PNG or JPEG.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function point(event: { clientX: number; clientY: number }): Point {
    const rect = overlayCanvas.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * viewport!.width) / rect.width,
      y: ((event.clientY - rect.top) * viewport!.height) / rect.height,
    };
  }

  function hitTest(p: Point): Item | null {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind !== "text" && item.kind !== "image") continue;
      if (inRect(p, itemRect(item))) return item;
    }
    return null;
  }

  /** Hand focus back to the text box after using a toolbar control. */
  function refocusEditor() {
    if (!editingId || !textarea.current) return;
    skipFocusHistory.current = true;
    textarea.current.focus();
  }

  function finishEditing() {
    if (!editingId) return;
    const item = (itemsRef.current[pageNumber] ?? []).find(
      (i) => i.id === editingId,
    );
    if (item && item.kind === "text" && !item.text.trim()) {
      setItems(
        (itemsRef.current[pageNumber] ?? []).filter((i) => i.id !== editingId),
        false,
      );
      setSelectedId(null);
    }
    setEditingId(null);
  }

  function startMove(item: Item, p: Point, event: ReactPointerEvent<Element>) {
    drag.current = {
      mode: "move",
      id: item.id,
      start: p,
      orig: item,
      snapshot: itemsRef.current[pageNumber] ?? [],
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** Page content under a point that the Edit tool can lift; text wins over images. */
  function findRegion(p: Point): Region | null {
    for (const line of textLines) {
      if (!line.text) continue;
      const rect = { x: line.x0, y: line.y0, w: line.x1 - line.x0, h: line.y1 - line.y0 };
      if (inRect(p, rect)) return { kind: "text", rect, line };
    }
    for (const rect of imageRegions) if (inRect(p, rect)) return { kind: "image", rect };
    return null;
  }

  /** Cover the original text and put an editable copy on top. */
  function liftText(line: Line) {
    const canvas = pageCanvas.current;
    if (!viewport || !canvas || !line.text) return;
    const r = { x: line.x0, y: line.y0, w: line.x1 - line.x0, h: line.y1 - line.y0 };
    const { ink, paper } = sampleRegion(canvas, viewport, r);
    const size = line.size ?? r.h / 1.12;
    const cover: Cover = {
      kind: "cover",
      id: uid(),
      x: r.x - 2,
      y: r.y - 1,
      width: r.w + 4,
      height: r.h + 2,
      color: paper,
      removal: { kind: "text", rect: r },
    };
    const item: TextItem = {
      kind: "text",
      id: uid(),
      x: r.x,
      y: r.y - size * 0.15,
      width: r.w,
      text: line.text,
      color: ink,
      size,
      font: line.font ?? "Arial",
      bold: !!line.bold,
      italic: !!line.italic,
      underline: false,
      strike: false,
    };
    // Wide enough that the copy never wraps where the original did not.
    measureCtx.font = fontString(item);
    item.width = Math.max(r.w, Math.ceil(measureCtx.measureText(item.text).width) + size * 0.6);
    setItems([...(itemsRef.current[pageNumber] ?? []), cover, item]);
    setSelectedId(item.id);
    setStatus("Text lifted · drag to move, double-click to retype");
  }

  /** Cover the original image and put a movable copy (cut from the render) on top. */
  async function liftImage(r: Rect) {
    const canvas = pageCanvas.current;
    if (!viewport || !canvas) return;
    const sx = canvas.width / viewport.width;
    const sy = canvas.height / viewport.height;
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(r.w * sx));
    crop.height = Math.max(1, Math.round(r.h * sy));
    crop.getContext("2d")?.drawImage(canvas, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, crop.width, crop.height);
    const image = new Image();
    image.src = crop.toDataURL("image/png");
    try {
      await image.decode();
    } catch {
      setStatus("Could not lift that image");
      return;
    }
    const ring = { x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 };
    const { paper } = sampleRegion(canvas, viewport, ring);
    const cover: Cover = {
      kind: "cover",
      id: uid(),
      x: r.x - 1,
      y: r.y - 1,
      width: r.w + 2,
      height: r.h + 2,
      color: paper,
      removal: { kind: "image", rect: r },
    };
    const item: ImageItem = { kind: "image", id: uid(), x: r.x, y: r.y, width: r.w, height: r.h, image };
    setItems([...(itemsRef.current[pageNumber] ?? []), cover, item]);
    setSelectedId(item.id);
    setStatus("Image lifted · drag to move, corner to resize");
  }

  /** Recognise text on the current page, on this device, for scanned PDFs. */
  async function runOcr() {
    const page = pageProxy.current;
    if (!page || !viewport || ocr.running) return;
    const targetPage = pageNumber;
    setOcr({ running: true, progress: 0 });
    setStatus("Recognizing text…");
    try {
      const scale = 2; // relative to the 1.25 viewport → about 180 dpi
      const view = page.getViewport({ scale: 1.25 * scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(view.width);
      canvas.height = Math.ceil(view.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas is unavailable.");
      // Print intent renders without animation frames, so it also works while hidden.
      await page.render({ canvas, canvasContext: ctx, viewport: view, intent: "print" }).promise;
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng", 1, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr/core",
        langPath: "/ocr/lang",
        gzip: true,
        logger: (m: { status?: string; progress?: number }) => {
          if (m.status === "recognizing text") setOcr({ running: true, progress: Math.round((m.progress ?? 0) * 100) });
        },
      });
      const result = await worker.recognize(canvas, {}, { blocks: true });
      await worker.terminate();
      const lines: Line[] = [];
      for (const block of result.data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const ln of para.lines) {
            const text = ln.text.replace(/\s+/g, " ").trim();
            if (!text) continue;
            const b = ln.bbox;
            const line: Line = { x0: b.x0 / scale, x1: b.x1 / scale, y0: b.y0 / scale, y1: b.y1 / scale, text };
            line.size = (line.y1 - line.y0) / 1.2;
            line.font = "Arial";
            lines.push(line);
          }
        }
      }
      canvas.width = 0;
      canvas.height = 0;
      ocrCache.current[targetPage] = lines;
      if (pageNumber === targetPage) setTextLines(lines);
      setStatus(lines.length ? `Text recognized · ${lines.length} lines` : "No text recognized on this page");
    } catch (error) {
      setStatus(`Text recognition failed: ${message(error)}`);
    } finally {
      setOcr({ running: false, progress: 0 });
    }
  }

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!viewport || busy || event.button !== 0 || !event.isPrimary) return;
    // Stop the browser's mousedown focus change from blurring a text box we
    // are about to focus.
    event.preventDefault();
    const p = point(event);
    if (editingId) {
      finishEditing();
      return;
    }
    if (tool === "edit") {
      const hit = hitTest(p);
      if (hit) {
        setSelectedId(hit.id);
        startMove(hit, p, event);
        return;
      }
      const region = findRegion(p);
      if (region?.kind === "text") liftText(region.line);
      else if (region) void liftImage(region.rect);
      else setSelectedId(null);
      return;
    }
    if (tool === "select" || tool === "text" || tool === "image" || tool === "sign") {
      const hit = hitTest(p);
      if (hit) {
        setSelectedId(hit.id);
        startMove(hit, p, event);
        return;
      }
    }
    if (tool === "select") {
      setSelectedId(null);
      return;
    }
    if (tool === "text" || tool === "sign") {
      // A signature is a text box fixed to a script font with its own size.
      const sign = tool === "sign";
      const textSize = sign ? signSize : size;
      const preset = sign ? signText.trim() : "";
      const item: TextItem = {
        kind: "text",
        id: uid(),
        x: p.x,
        y: p.y,
        width: Math.max(sign ? 220 : 120, Math.min(sign ? 360 : 260, viewport.width - p.x - 8)),
        text: preset,
        color,
        size: textSize,
        font: sign ? SIGNATURE_FONT : font,
        signature: sign,
        bold: !sign && textStyle.bold,
        italic: !sign && textStyle.italic,
        underline: !sign && textStyle.underline,
        strike: !sign && textStyle.strike,
      };
      if (preset) {
        // A saved signature drops in ready-made: size the box to the text.
        measureCtx.font = fontString(item);
        item.width = Math.min(viewport.width - p.x - 8, Math.ceil(measureCtx.measureText(preset).width) + textSize * 0.6);
        addItem(item);
        setSelectedId(item.id);
        setStatus("Signature placed");
        return;
      }
      addItem(item);
      setSelectedId(item.id);
      setEditingId(item.id);
      return;
    }
    if (tool === "image") {
      if (!image) {
        setStatus("Paste an image (Ctrl+V / ⌘+V) or drop one onto the page, then click to place it.");
        return;
      }
      const width = Math.min(size * 10, viewport.width / 2);
      const item: ImageItem = {
        kind: "image",
        id: uid(),
        x: p.x - width / 2,
        y: p.y - (width * image.naturalHeight) / image.naturalWidth / 2,
        image,
        width,
        height: (width * image.naturalHeight) / image.naturalWidth,
      };
      addItem(item);
      setSelectedId(item.id);
      setTool("select");
      return;
    }
    setSelectedId(null);
    if (tool === "highlight") {
      drag.current = { mode: "highlight", start: p };
      setDraft({
        kind: "highlight",
        id: "draft",
        color: highlightColor,
        rects: highlightRects(textLines, p, p, size),
      });
    } else {
      drag.current = { mode: "stroke" };
      setDraft({
        kind: "stroke",
        id: "draft",
        points: [p],
        color,
        width: Math.max(1, size / 8),
      });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function applyResize(d: Extract<Drag, { mode: "resize" }>, p: Point) {
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const o = d.orig;
    if (o.kind === "image") {
      const ratio = o.height / o.width;
      let w = o.width;
      if (d.handle === "se" || d.handle === "ne") w = o.width + dx;
      if (d.handle === "sw" || d.handle === "nw") w = o.width - dx;
      w = Math.max(16, w);
      const h = w * ratio;
      const x = d.handle === "sw" || d.handle === "nw" ? o.x + o.width - w : o.x;
      const y = d.handle === "nw" || d.handle === "ne" ? o.y + o.height - h : o.y;
      updateItem(o.id, { x, y, width: w, height: h }, false);
      return;
    }
    if (o.kind === "text") {
      if (d.handle === "e" || d.handle === "w") {
        const w = Math.max(24, d.handle === "e" ? o.width + dx : o.width - dx);
        const x = d.handle === "w" ? o.x + o.width - w : o.x;
        updateItem(o.id, { x, width: w }, false);
        return;
      }
      const grow = d.handle === "se" || d.handle === "ne" ? dx : -dx;
      const factor = Math.max(0.1, (o.width + grow) / o.width);
      const w = o.width * factor;
      const x = d.handle === "sw" || d.handle === "nw" ? o.x + o.width - w : o.x;
      const origH = layoutText(o).height;
      const y =
        d.handle === "nw" || d.handle === "ne" ? o.y + origH - origH * factor : o.y;
      void dy;
      updateItem(
        o.id,
        { x, y, width: w, size: Math.max(4, o.size * factor) },
        false,
      );
    }
  }

  function pointerMove(event: ReactPointerEvent<Element>) {
    const d = drag.current;
    if (tool === "edit" && !d && viewport) {
      const region = findRegion(point(event));
      const key = region ? `${region.rect.x},${region.rect.y},${region.rect.w},${region.rect.h}` : "";
      if (key !== hoverKey.current) {
        hoverKey.current = key;
        setHoverRegion(region?.rect ?? null);
      }
    }
    if (!d || !viewport || !event.isPrimary) return;
    const p = point(event);
    if (d.mode === "stroke") {
      setDraft((current) =>
        current && current.kind === "stroke"
          ? { ...current, points: [...current.points, p] }
          : current,
      );
    } else if (d.mode === "highlight") {
      const rects = highlightRects(textLines, d.start, p, size);
      setDraft((current) =>
        current && current.kind === "highlight" ? { ...current, rects } : current,
      );
    } else if (d.mode === "move") {
      const o = d.orig;
      if (o.kind === "text" || o.kind === "image") {
        updateItem(
          o.id,
          { x: o.x + p.x - d.start.x, y: o.y + p.y - d.start.y },
          false,
        );
      }
    } else {
      applyResize(d, p);
    }
  }

  function pointerUp(event: ReactPointerEvent<Element>) {
    if (!event.isPrimary) return;
    const d = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!d) return;
    if (d.mode === "stroke" || d.mode === "highlight") {
      setDraft((current) => {
        if (current) addItem({ ...current, id: uid() });
        return null;
      });
      return;
    }
    const now = (itemsRef.current[pageNumber] ?? []).find((i) => i.id === d.id);
    if (now && now !== d.orig) pushHistory(d.snapshot);
  }

  function cancelDrag() {
    const d = drag.current;
    drag.current = null;
    setDraft(null);
    if (d && (d.mode === "move" || d.mode === "resize")) {
      setItems(d.snapshot, false);
    }
  }

  function handleDown(handle: Handle) {
    return (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!selected || !viewport || event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      drag.current = {
        mode: "resize",
        id: selected.id,
        handle,
        start: point(event),
        orig: selected,
        snapshot: itemsRef.current[pageNumber] ?? [],
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };
  }

  function pickTool(next: Tool) {
    finishEditing();
    setOrganizing(false);
    setCropRect(null);
    setTool(next);
    if (next !== "select") setSelectedId(null);
    if (next === "image" && !image) {
      setStatus("Paste an image (Ctrl+V / ⌘+V) or drop one onto the page, then click to place it.");
    }
  }

  async function exportPdf() {
    if (!source || !pdf) return;
    finishEditing();
    setBusy(true);
    setStatus("Preparing your PDF…");
    try {
      const outputName = exportFilename(filename);
      const allText = Object.values(itemsRef.current)
        .flat()
        .filter((i): i is TextItem => i.kind === "text");
      await Promise.all(allText.map((i) => document.fonts.load(fontString(i))));
      const output = await PDFDocument.load(source.slice());
      output.registerFontkit(fontkit);
      const fonts = new FontBook(output);
      const pageKeys = watermark
        ? Array.from({ length: pdf.numPages }, (_, i) => String(i + 1))
        : Object.keys(itemsRef.current);
      for (const pageKey of pageKeys) {
        const pageItems = itemsRef.current[Number(pageKey)] ?? [];
        const drawable = pageItems.filter(
          (i) => i.kind !== "text" || i.text.trim(),
        );
        if (!drawable.length && !watermark) continue;
        const index = Number(pageKey);
        const originalPage = await pdf.getPage(index);
        const view = originalPage.getViewport({ scale: 1.25 });
        const target = output.getPage(index - 1);

        // Lifted originals were already deleted from `source` by the live
        // rebuild; covers that succeeded are never painted.
        const stripped = new Set(drawable.filter((i): i is Cover => i.kind === "cover" && !!i.stripped).map((c) => c.id));

        // Map the visible overlay back into PDF coordinates.
        // This also accounts for rotated pages and crop-box offsets.
        const origin = view.convertToPdfPoint(0, view.height);
        const right = view.convertToPdfPoint(view.width, view.height);
        const top = view.convertToPdfPoint(0, 0);
        const drawLayer = async (items: Item[], layer: PaintLayer, blendMode: BlendMode, wm: Watermark | null) => {
          const canvas = document.createElement("canvas");
          paint(canvas, view, items, null, layer, wm);
          const png = await output.embedPng(await (await canvasBlob(canvas)).arrayBuffer());
          canvas.width = 0;
          canvas.height = 0;
          target.pushOperators(
            pushGraphicsState(),
            concatTransformationMatrix(
              right[0] - origin[0],
              right[1] - origin[1],
              top[0] - origin[0],
              top[1] - origin[1],
              origin[0],
              origin[1],
            ),
          );
          target.drawImage(png, { x: 0, y: 0, width: 1, height: 1, blendMode });
          target.pushOperators(popGraphicsState());
        };

        // 1. Highlights and watermark, blended behind the ink.
        if (drawable.some((i) => i.kind === "highlight") || watermark) {
          await drawLayer(drawable, "highlights", BlendMode.Multiply, watermark);
        }
        // 2. Strokes, images and any covers that still need painting.
        const raster = drawable.filter((i) => i.kind !== "text" && i.kind !== "highlight" && !(i.kind === "cover" && stripped.has(i.id)));
        if (raster.length) await drawLayer(raster, "marks", BlendMode.Normal, null);

        // 3. Tier 1: text as real, selectable PDF text. Anything a font cannot
        //    encode falls back to the raster layer.
        const pxToPt = Math.hypot(right[0] - origin[0], right[1] - origin[1]) / view.width;
        const angle = Math.atan2(right[1] - origin[1], right[0] - origin[0]);
        const fallback: Item[] = [];
        for (const item of drawable) {
          if (item.kind !== "text") continue;
          try {
            const { font, ascent } = await fonts.get({ family: item.font, bold: item.bold, italic: item.italic });
            const { lines, lineHeight } = layoutText(item, (str) => font.widthOfTextAtSize(str, item.size));
            for (const line of lines) font.encodeText(line); // throws for unsupported characters
            const color = pdfColor(item.color);
            lines.forEach((line, i) => {
              const lineTop = item.y + i * lineHeight + (lineHeight - item.size) / 2;
              const baseline = lineTop + item.size * ascent;
              const [x, y] = view.convertToPdfPoint(item.x, baseline);
              target.drawText(line, { x, y, size: item.size * pxToPt, font, color, rotate: radians(angle) });
              const w = font.widthOfTextAtSize(line, item.size);
              const rule = (yy: number) => {
                const a = view.convertToPdfPoint(item.x, yy);
                const b = view.convertToPdfPoint(item.x + w, yy);
                target.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: Math.max(0.5, (item.size / 14) * pxToPt), color });
              };
              if (item.underline) rule(lineTop + item.size * 0.92);
              if (item.strike) rule(lineTop + item.size * 0.55);
            });
          } catch {
            fallback.push(item);
          }
        }
        if (fallback.length) await drawLayer(fallback, "marks", BlendMode.Normal, null);
      }
      const bytes = await output.save();
      const blob = new Blob([new Uint8Array(bytes).buffer], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = outputName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setStatus("Exported");
    } catch (error) {
      setStatus(`Export failed: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const annotationCount = Object.values(annotations).reduce((n, list) => n + list.length, 0);
  const selectedRect = selected && viewport ? itemRect(selected) : null;
  // Anchor the contextual toolbar above the selection (below it near the top
  // edge), clamped to the page so it never causes layout to shift.
  const barPos = (() => {
    if (!viewport || !selected || !selectedRect) return null;
    const barW = selected.kind === "text" ? 520 : 44;
    const barH = 44;
    const pageW = viewport.width * cssScale;
    const cx = (selectedRect.x + selectedRect.w / 2) * cssScale;
    const left = Math.min(Math.max(cx - barW / 2, 4), Math.max(4, pageW - barW - 4));
    const above = selectedRect.y * cssScale - barH - 10;
    const top = above >= 4 ? above : (selectedRect.y + selectedRect.h) * cssScale + 10;
    return { left, top };
  })();
  const editingLayout = editing ? layoutText(editing) : null;

  const PRIVACY =
    "Your PDF, images, and signatures are processed entirely on your own computer, inside this browser tab. Nothing is uploaded, transmitted, or stored on any server, and the page makes no network requests after it loads. You can disconnect from the internet and keep working. Edits are kept in memory only until you save a copy.";

  const icon = (d: string, extra?: ReactNode) => (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
      {extra}
    </svg>
  );
  const tools: { id: Tool; label: string; shortcut: string; icon: ReactNode }[] = [
    { id: "select", label: "Select", shortcut: "V", icon: icon("M5 3.5 19 11l-6.2 1.6L9.5 19z") },
    { id: "text", label: "Text", shortcut: "T", icon: icon("M5 7V4h14v3M12 4v16M9 20h6") },
    { id: "draw", label: "Draw", shortcut: "D", icon: icon("M4 20l4.5-1L19 8.5a2.1 2.1 0 0 0-3-3L5.5 16zM14 7l3 3") },
    { id: "highlight", label: "Highlight", shortcut: "H", icon: icon("M9.5 14.5 5 19v1h4l3-3M8 14l7.5-7.5a2 2 0 0 1 3 3L11 17zM3 22h18") },
    { id: "sign", label: "Signature", shortcut: "S", icon: icon("M3 16c2.5-6 4.5-7 5.5-1 .7 4.5 2.5 3 4-1.5 1-3 2.5-2 3 1 .5 2.5 2 2 5.5-1M3 21h18") },
    { id: "image", label: "Image", shortcut: "I", icon: icon("M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4", <circle cx="16" cy="9" r="1.3" fill="currentColor" stroke="none" />) },
    { id: "edit", label: "Edit content", shortcut: "E", icon: icon("M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17zM13.5 8.5l3 3M3 4h9") },
  ];

  return (
    <div
      className={`app ${pdf ? "has-pdf" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
              <path d="M7 3h7l5 5v13H7z" />
              <path d="M14 3v5h5M10 13h5M10 17h5" strokeLinecap="round" />
            </svg>
            <span>PDF Studio</span>
          </div>
          <span className="pill" title={PRIVACY}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            Processed locally, never uploaded
          </span>
        </div>
        {docs.length > 0 && (
          <div className="tabs" role="tablist" aria-label="Open files">
            {docs.map((d) => (
              <div
                key={d.id}
                role="tab"
                tabIndex={0}
                aria-selected={d.id === activeDocId}
                className={`tab ${d.id === activeDocId ? "active" : ""}`}
                style={tabStyle(d.tone)}
                title={d.name}
                onClick={() => activateDoc(d.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") activateDoc(d.id);
                }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                  <path d="M7 3h7l5 5v13H7z" />
                </svg>
                <span className="tab-name">{d.name}</span>
                <button
                  className="tab-close"
                  aria-label={`Close ${d.name}`}
                  title="Close"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeDoc(d.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            ))}
            <button
              className="tab-add"
              aria-label="Open another PDF"
              title={`Open another PDF · ${MOD}O`}
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        )}
        <div className="topbar-right">
          <label className="filename" title="File name for the exported PDF">
            <input
              type="text"
              value={filename}
              disabled={!pdf}
              spellCheck={false}
              aria-label="Export file name"
              onChange={(event) => setFilename(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && pdf && !busy) void exportPdf();
              }}
            />
            <span>.pdf</span>
          </label>
          <button className="primary" disabled={!pdf || busy} aria-busy={busy} onClick={() => void exportPdf()}>
            Export
          </button>
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        hidden
        onChange={(event) => {
          void openPdfs(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />

      <aside className="rail" aria-label="Tools">
        <button
          className="rail-btn"
          aria-label="Open PDF"
          data-tip={`Open PDF  ·  ${MOD}O`}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {icon(
            "M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6a1 1 0 0 1 .8.4L11.5 7h7A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5zM12 10.5v5M9.5 13h5",
          )}
        </button>
        <div className="rail-sep" />
        {tools.map((t, index) => {
          const opts = TOOL_OPTIONS[t.id];
          const active = tool === t.id;
          const isHighlight = t.id === "highlight";
          const isSign = t.id === "sign";
          const isText = t.id === "text";
          // A selected text box (or signature) binds its panel to itself.
          const bound =
            selected?.kind === "text" && ((isSign && selected.signature) || (isText && !selected.signature))
              ? selected
              : null;
          const isEdit = t.id === "edit";
          const hasPanel = !!opts || isEdit;
          const showPanel = hasPanel && ((active && panelOpen) || !!bound);
          const current = bound ? bound.color : isHighlight ? highlightColor : color;
          const setCurrent = (c: string) => {
            if (bound) updateItem(bound.id, { color: c });
            if (isHighlight) setHighlightColor(c);
            else setColor(c);
            if (bound) refocusEditor();
          };
          const sizeValue = bound ? Math.round(bound.size) : isSign ? signSize : size;
          const setSizeValue = (v: number) => {
            if (bound) updateItem(bound.id, { size: v });
            if (isSign) setSignSize(v);
            else setSize(v);
          };
          const fontValue = bound?.font ?? font;
          const styleOf = (key: "bold" | "italic" | "underline" | "strike") => (bound ? bound[key] : textStyle[key]);
          const toggleStyle = (key: "bold" | "italic" | "underline" | "strike") => {
            if (bound) updateItem(bound.id, { [key]: !bound[key] });
            else setTextStyle((st) => ({ ...st, [key]: !st[key] }));
          };
          return (
            <div
              key={t.id}
              className="rail-item"
              ref={showPanel ? panelRoot : undefined}
              data-tip={`${t.label}  ·  ${index + 1}  ·  ${t.shortcut}`}
            >
              <button
                className={`rail-btn ${active ? "active" : ""} ${hasPanel ? "has-options" : ""}`}
                aria-label={t.label}
                aria-pressed={active}
                aria-expanded={hasPanel ? showPanel : undefined}
                disabled={busy}
                onClick={() => {
                  pickTool(t.id);
                  setWmOpen(false);
                  setPanelOpen(hasPanel ? (active ? !panelOpen : true) : false);
                }}
              >
                {t.icon}
                {opts && <span className="rail-dot" style={{ background: current }} />}
              </button>
              {showPanel && isEdit && (
                <div className="rail-pop tool-pop" role="dialog" aria-label="Edit content">
                  <div className="tool-pop-title">Edit content</div>
                  <p className="tool-pop-help">
                    Click any text line or image on the page to lift it into an editable, movable copy.
                    Double-click lifted text to retype it.
                  </p>
                  <div className="tool-pop-row">
                    <span className="tool-pop-label">OCR</span>
                    <button className="tool-pop-action" disabled={ocr.running || !pdf || busy} onClick={() => void runOcr()}>
                      {ocr.running
                        ? `Recognizing… ${ocr.progress}%`
                        : textLines.some((l) => l.text)
                          ? "Re-run text recognition"
                          : "Recognize text on this page"}
                    </button>
                  </div>
                  <p className="tool-pop-help small">
                    {textLines.some((l) => l.text)
                      ? `${textLines.filter((l) => l.text).length} text lines on this page${imageRegions.length ? ` · ${imageRegions.length} ${imageRegions.length === 1 ? "image" : "images"}` : ""}.`
                      : "No selectable text on this page. For scans, run text recognition. It runs on your device; nothing is uploaded."}
                  </p>
                </div>
              )}
              {showPanel && opts && (
                <div
                  className="rail-pop tool-pop"
                  role="dialog"
                  aria-label={`${t.label} options`}
                  ref={bound ? floatbar : undefined}
                  onPointerDown={() => {
                    // Keep an in-progress text box alive while its panel is used.
                    barPress.current = true;
                    window.setTimeout(() => (barPress.current = false), 0);
                  }}
                >
                  <div className="tool-pop-title">
                    {t.label}
                    {bound && (
                      <button
                        className="tool-pop-delete"
                        aria-label={isSign ? "Delete signature" : "Delete text"}
                        title={isSign ? "Delete signature" : "Delete text"}
                        onClick={() => removeItem(bound.id)}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {isSign && !bound && (
                    <div className="tool-pop-row">
                      <span className="tool-pop-label">Text</span>
                      <input
                        className="tool-pop-text"
                        type="text"
                        value={signText}
                        placeholder="Type your signature once"
                        spellCheck={false}
                        aria-label="Signature text"
                        style={{ fontFamily: `"${SIGNATURE_FONT}"` }}
                        onChange={(event) => setSignText(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") setPanelOpen(false);
                        }}
                      />
                    </div>
                  )}
                  {isText && (
                    <div className="tool-pop-row">
                      <span className="tool-pop-label">Font</span>
                      <select
                        className="tool-pop-select"
                        aria-label="Font"
                        value={fontValue}
                        style={{ fontFamily: `"${fontValue}"` }}
                        onChange={(event) => {
                          setFont(event.target.value);
                          if (bound) {
                            updateItem(bound.id, { font: event.target.value });
                            refocusEditor();
                          }
                        }}
                      >
                        {FONTS.map((f) => (
                          <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="tool-pop-row">
                    <span className="tool-pop-label">Color</span>
                    <div className="quick-colors">
                      {(isHighlight ? QUICK_HIGHLIGHTS : QUICK_COLORS).map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`quick-swatch ${c === current.toLowerCase() ? "selected" : ""}`}
                          style={{ background: c }}
                          aria-label={c}
                          aria-pressed={c === current.toLowerCase()}
                          onClick={() => setCurrent(c)}
                        />
                      ))}
                      <ColorPicker
                        label={isHighlight ? "Highlight color" : isText ? "Text color" : "Annotation color"}
                        value={current}
                        defaultValue={isHighlight ? DEFAULT_HIGHLIGHT : DEFAULT_COLOR}
                        onChange={setCurrent}
                      />
                    </div>
                  </div>
                  <div className="tool-pop-row">
                    <span className="tool-pop-label">{opts.sizeLabel}</span>
                    <input
                      aria-label={opts.sizeLabel}
                      type="range"
                      min={opts.min}
                      max={opts.max}
                      value={Math.min(opts.max, sizeValue)}
                      onChange={(event) => setSizeValue(Number(event.target.value))}
                    />
                    <input
                      aria-label={`${opts.sizeLabel} value`}
                      type="number"
                      min={opts.min}
                      max="200"
                      value={sizeValue}
                      onChange={(event) =>
                        setSizeValue(Math.min(200, Math.max(1, Number(event.target.value) || 1)))
                      }
                    />
                  </div>
                  {isText && (
                    <div className="tool-pop-row">
                      <span className="tool-pop-label">Style</span>
                      <div className="tool-pop-styles">
                        {(
                          [
                            ["bold", "B"],
                            ["italic", "I"],
                            ["underline", "U"],
                            ["strike", "S"],
                          ] as const
                        ).map(([key, label]) => (
                          <button
                            key={key}
                            type="button"
                            className={`fmt ${key} ${styleOf(key) ? "selected" : ""}`}
                            aria-pressed={styleOf(key)}
                            aria-label={key}
                            title={`${key[0].toUpperCase()}${key.slice(1)}  ·  ${MOD}${key === "strike" ? "⇧X" : label}`}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={() => toggleStyle(key)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div className="rail-sep" />
        <div className="rail-item low" ref={wmOpen ? wmRoot : undefined} data-tip="Watermark">
          <button
            className={`rail-btn has-options ${wmOpen ? "active" : ""}`}
            aria-label="Watermark"
            aria-expanded={wmOpen}
            disabled={busy || !pdf}
            onClick={() => {
              setPanelOpen(false);
              setWmOpen((o) => !o);
            }}
          >
            {icon("M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z")}
            {watermark && <span className="rail-dot" style={{ background: watermark.color }} />}
          </button>
          {wmOpen && (() => {
            const wm = watermark ?? DEFAULT_WATERMARK;
            const patch = (next: Partial<Watermark>) => setWatermark({ ...wm, ...next });
            return (
              <div className="rail-pop tool-pop" role="dialog" aria-label="Watermark">
                <div className="tool-pop-title">
                  Watermark
                  <button
                    className={`tool-pop-toggle ${watermark ? "on" : ""}`}
                    onClick={() => {
                      setWatermark(watermark ? null : DEFAULT_WATERMARK);
                      setStatus(watermark ? "Watermark removed" : "Watermark added");
                    }}
                  >
                    {watermark ? "Remove" : "Add"}
                  </button>
                </div>
                <div className="tool-pop-row">
                  <span className="tool-pop-label">Text</span>
                  <input
                    className="tool-pop-text plain"
                    type="text"
                    value={wm.text}
                    placeholder="CONFIDENTIAL"
                    aria-label="Watermark text"
                    onChange={(event) => patch({ text: event.target.value })}
                  />
                </div>
                <div className="tool-pop-row">
                  <span className="tool-pop-label">Color</span>
                  <div className="quick-colors">
                    {WATERMARK_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`quick-swatch ${c === wm.color.toLowerCase() ? "selected" : ""}`}
                        style={{ background: c }}
                        aria-label={c}
                        aria-pressed={c === wm.color.toLowerCase()}
                        onClick={() => patch({ color: c })}
                      />
                    ))}
                    <ColorPicker label="Watermark color" value={wm.color} defaultValue={DEFAULT_WATERMARK.color} onChange={(c) => patch({ color: c })} />
                  </div>
                </div>
                <div className="tool-pop-row">
                  <span className="tool-pop-label">Size</span>
                  <input aria-label="Watermark size" type="range" min="12" max="120" value={wm.size} onChange={(event) => patch({ size: Number(event.target.value) })} />
                  <input aria-label="Watermark size value" type="number" min="8" max="300" value={wm.size} onChange={(event) => patch({ size: Math.min(300, Math.max(8, Number(event.target.value) || 8)) })} />
                </div>
                <div className="tool-pop-row">
                  <span className="tool-pop-label">Opacity</span>
                  <input aria-label="Watermark opacity" type="range" min="5" max="100" value={Math.round(wm.opacity * 100)} onChange={(event) => patch({ opacity: Number(event.target.value) / 100 })} />
                  <input aria-label="Watermark opacity value" type="number" min="5" max="100" value={Math.round(wm.opacity * 100)} onChange={(event) => patch({ opacity: Math.min(100, Math.max(5, Number(event.target.value) || 5)) / 100 })} />
                </div>
                <div className="tool-pop-row">
                  <span className="tool-pop-label">Angle</span>
                  <input aria-label="Watermark angle" type="range" min="-90" max="90" value={wm.angle} onChange={(event) => patch({ angle: Number(event.target.value) })} />
                  <input aria-label="Watermark angle value" type="number" min="-90" max="90" value={wm.angle} onChange={(event) => patch({ angle: Math.min(90, Math.max(-90, Number(event.target.value) || 0)) })} />
                </div>
                <div className="tool-pop-row">
                  <span className="tool-pop-label">Layout</span>
                  <div className="tool-pop-seg" role="radiogroup" aria-label="Watermark layout">
                    {(["tile", "center"] as const).map((layout) => (
                      <button
                        key={layout}
                        type="button"
                        role="radio"
                        aria-checked={wm.layout === layout}
                        className={wm.layout === layout ? "selected" : ""}
                        onClick={() => patch({ layout })}
                      >
                        {layout === "tile" ? "Tiled" : "Centered"}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="tool-pop-help small">Applies to every page of this file and is included in the export.</p>
              </div>
            );
          })()}
        </div>
        <button
          className={`rail-btn ${organizing ? "active" : ""}`}
          aria-label="Organize pages"
          aria-pressed={organizing}
          data-tip="Organize pages"
          disabled={busy || !pdf}
          onClick={() => {
            finishEditing();
            setCropRect(null);
            setSelectedId(null);
            setOrganizing((o) => !o);
          }}
        >
          {icon("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z")}
        </button>
        <div className="rail-spacer" />
        <button
          className="rail-btn danger"
          aria-label="Clear all annotations"
          data-tip="Clear all annotations"
          disabled={busy || !annotationCount}
          onClick={clearAll}
        >
          {icon(
            "M4 20h9M8.5 20 3.6 15.1a1.5 1.5 0 0 1 0-2.1l8.4-8.4a1.5 1.5 0 0 1 2.1 0l5.3 5.3a1.5 1.5 0 0 1 0 2.1L12.5 20M6.5 10.5l7 7",
          )}
        </button>
      </aside>

      <section className="canvas" ref={canvasBox}>
        {pdf && organizing ? (
          <div className="organize">
            <div className="organize-bar">
              <div className="organize-info">
                <strong>{docs.find((d) => d.id === activeDocId)?.name}</strong>
                <span>
                  {pdf.numPages} {pdf.numPages === 1 ? "page" : "pages"}
                  {selectedPages.size ? ` · ${selectedPages.size} selected` : " · drag to reorder, hover a page for actions"}
                </span>
              </div>
              <div className="organize-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    setSelectedPages(
                      selectedPages.size === pdf.numPages
                        ? new Set()
                        : new Set(Array.from({ length: pdf.numPages }, (_, i) => i)),
                    )
                  }
                >
                  {selectedPages.size === pdf.numPages ? "Deselect all" : "Select all"}
                </button>
                <button disabled={busy || !selectedPages.size} onClick={() => void extractPages([...selectedPages])}>
                  Extract to new file
                </button>
                <button
                  className="danger"
                  disabled={busy || !selectedPages.size || selectedPages.size >= pdf.numPages}
                  onClick={() => void removePages([...selectedPages])}
                >
                  Remove
                </button>
                <span className="sep" />
                <button disabled={busy || docs.length < 2} title="Merge every open file, in tab order, into a new file" onClick={() => void combineAll()}>
                  Combine {docs.length > 1 ? `${docs.length} files` : "files"}
                </button>
                <button disabled={busy || !structHistory.current.length} onClick={undoStructure}>
                  Undo
                </button>
                <button className="primary" onClick={() => setOrganizing(false)}>
                  Done
                </button>
              </div>
            </div>
            <div className="page-grid" onDragOver={(event) => event.preventDefault()}>
              {Array.from({ length: pdf.numPages }, (_, i) => (
                <div
                  key={i}
                  className={`page-card ${selectedPages.has(i) ? "selected" : ""} ${dropTarget === i && dragPage !== i ? "drop-target" : ""} ${dragPage === i ? "dragging" : ""} ${pageNumber === i + 1 ? "current" : ""}`}
                  draggable={!busy}
                  onDragStart={(event) => {
                    setDragPage(i);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(i));
                  }}
                  onDragEnter={() => setDropTarget(i)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDragEnd={() => {
                    setDragPage(null);
                    setDropTarget(null);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const from = dragPage ?? Number(event.dataTransfer.getData("text/plain"));
                    setDragPage(null);
                    setDropTarget(null);
                    if (Number.isFinite(from)) void movePage(from, i);
                  }}
                  onClick={() =>
                    setSelectedPages((set) => {
                      const next = new Set(set);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                  onDoubleClick={() => {
                    setPageNumber(i + 1);
                    setOrganizing(false);
                  }}
                >
                  <PageThumb pdf={pdf} index={i + 1} width={148} />
                  <label className="page-check" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedPages.has(i)}
                      aria-label={`Select page ${i + 1}`}
                      onChange={(event) =>
                        setSelectedPages((set) => {
                          const next = new Set(set);
                          if (event.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                  </label>
                  <div className="page-actions" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
                    <button aria-label="Rotate left" title="Rotate left" disabled={busy} onClick={() => void rotatePage(i, -90)}>
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 8V3m0 5h5M3 8a9 9 0 1 1 2.6 8.4" />
                      </svg>
                    </button>
                    <button aria-label="Rotate right" title="Rotate right" disabled={busy} onClick={() => void rotatePage(i, 90)}>
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 8V3m0 5h-5M21 8a9 9 0 1 0-2.6 8.4" />
                      </svg>
                    </button>
                    <button aria-label="Crop" title="Crop" disabled={busy} onClick={() => startCrop(i)}>
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 2v16h16M2 6h16v16" />
                      </svg>
                    </button>
                    <button className="danger" aria-label="Remove page" title="Remove page" disabled={busy || pdf.numPages < 2} onClick={() => void removePages([i])}>
                      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                      </svg>
                    </button>
                  </div>
                  <span className="page-num">{i + 1}</span>
                </div>
              ))}
            </div>
          </div>
        ) : pdf ? (
          <div
            ref={pageBox}
            className={`page tool-${tool} ${zoom !== 1 ? "zoomed" : ""}`}
            style={{ width: ((viewport ?? lastViewport.current)?.width ?? 800) * zoom }}
          >
            {viewport && !cropRect &&
              // Neighbouring pages fan out behind the current sheet: previous
              // pages to the left, following pages to the right. Deeper sheets
              // render first so nearer ones paint on top. Click one to jump.
              [-1, 1]
                .flatMap((side) =>
                  Array.from({ length: 3 }, (_, i) => ({ n: pageNumber + side * (i + 1), depth: i + 1, side })),
                )
                .filter(({ n }) => n >= 1 && n <= pdf.numPages)
                .sort((a, b) => b.depth - a.depth)
                .map(({ n, depth, side }) => (
                  <button
                    key={n}
                    type="button"
                    className="sheet"
                    style={{ "--depth": depth, "--side": side } as CSSProperties}
                    title={`Go to page ${n}`}
                    aria-label={`Go to page ${n}`}
                    disabled={busy}
                    onClick={() => {
                      finishEditing();
                      setPageNumber(n);
                    }}
                  >
                    <PageThumb pdf={pdf} index={n} width={Math.round(viewport.width)} fill />
                  </button>
                ))}
            <canvas ref={pageCanvas} className="pdf-canvas" />
            <canvas ref={highlightCanvas} className="highlight-layer" aria-hidden="true" />
            <canvas
              ref={overlayCanvas}
              className="overlay"
              aria-label="PDF annotation surface"
              style={{
                visibility: viewport ? "visible" : "hidden",
                pointerEvents: busy ? "none" : "auto",
                cursor: tool === "edit" ? (hoverRegion ? "pointer" : "default") : undefined,
              }}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={cancelDrag}
              onDoubleClick={(event) => {
                if (!viewport) return;
                const hit = hitTest(point(event));
                if (hit?.kind === "text") {
                  setSelectedId(hit.id);
                  setEditingId(hit.id);
                }
              }}
            />

            {tool === "edit" && hoverRegion && viewport && !cropRect && (
              <div
                className="edit-hover"
                style={{
                  left: pct(hoverRegion.x, viewport.width),
                  top: pct(hoverRegion.y, viewport.height),
                  width: pct(hoverRegion.w, viewport.width),
                  height: pct(hoverRegion.h, viewport.height),
                }}
              />
            )}

            {viewport && cropRect && (
              <div
                className="crop-layer"
                onPointerDown={cropPointerDown}
                onPointerMove={cropPointerMove}
                onPointerUp={cropPointerUp}
                onPointerCancel={cropPointerUp}
              >
                <div
                  className="crop-rect"
                  style={{
                    left: pct(cropRect.x, viewport.width),
                    top: pct(cropRect.y, viewport.height),
                    width: pct(cropRect.w, viewport.width),
                    height: pct(cropRect.h, viewport.height),
                  }}
                >
                  {(["nw", "ne", "sw", "se"] as Handle[]).map((h) => (
                    <div key={h} className={`handle ${h}`} data-handle={h} />
                  ))}
                </div>
                <div className="floatbar crop-bar" role="toolbar" onPointerDown={(event) => event.stopPropagation()}>
                  <span className="crop-label">
                    Crop page {pageNumber} · {Math.round(cropRect.w / 1.25)} × {Math.round(cropRect.h / 1.25)} pt
                  </span>
                  <span className="sep" />
                  <button onClick={() => setCropRect(null)}>Cancel</button>
                  <button className="primary" disabled={busy} onClick={() => void applyCrop()}>
                    Apply
                  </button>
                </div>
              </div>
            )}

            {viewport && selected && selectedRect && !editing && (
              <div
                className={`selection ${selected.kind === "text" && selected.signature ? "signature" : ""}`}
                style={{
                  left: pct(selectedRect.x, viewport.width),
                  top: pct(selectedRect.y, viewport.height),
                  width: pct(selectedRect.w, viewport.width),
                  height: pct(selectedRect.h, viewport.height),
                }}
              >
                {/* One visible dot (bottom right) scales the item. Plain text
                    boxes also keep invisible side strips to change wrapping width. */}
                {(selected.kind === "text" && !selected.signature
                  ? (["se", "e", "w"] as Handle[])
                  : (["se"] as Handle[])
                ).map((h) => (
                  <div
                    key={h}
                    className={`handle ${h}`}
                    onPointerDown={handleDown(h)}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    onPointerCancel={cancelDrag}
                  />
                ))}
              </div>
            )}

            {viewport && selected && selectedRect && barPos && selected.kind !== "text" && (
              <div
                ref={floatbar}
                className="floatbar"
                role="toolbar"
                onPointerDown={() => {
                  barPress.current = true;
                  window.setTimeout(() => (barPress.current = false), 0);
                }}
                aria-label="Selection options"
                style={{ left: barPos.left, top: barPos.top }}
              >
                <button
                  className="icon danger"
                  aria-label="Delete"
                  title="Delete"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => removeItem(selected.id)}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
                    />
                  </svg>
                </button>
              </div>
            )}

            {viewport && editing && editingLayout && (
              <textarea
                ref={textarea}
                className="text-editor"
                aria-label="Text content"
                value={editing.text}
                placeholder="Type here"
                spellCheck={false}
                style={{
                  left: pct(editing.x, viewport.width),
                  top: pct(editing.y, viewport.height),
                  width: pct(editing.width, viewport.width),
                  height: pct(editingLayout.height, viewport.height),
                  fontFamily: `"${editing.font}", sans-serif`,
                  fontSize: editing.size * cssScale,
                  lineHeight: LINE_HEIGHT,
                  fontWeight: editing.bold ? 700 : 400,
                  fontStyle: editing.italic ? "italic" : "normal",
                  textDecoration:
                    [
                      editing.underline ? "underline" : "",
                      editing.strike ? "line-through" : "",
                    ]
                      .join(" ")
                      .trim() || "none",
                  color: editing.color,
                }}
                onChange={(event) =>
                  updateItem(editing.id, { text: event.target.value }, false)
                }
                onFocus={() => {
                  if (skipFocusHistory.current) {
                    skipFocusHistory.current = false;
                    return;
                  }
                  pushHistory(itemsRef.current[pageNumber] ?? []);
                }}
                onBlur={(event) => {
                  // Keep editing while focus moves into the floating toolbar.
                  if (barPress.current) return;
                  if (floatbar.current?.contains(event.relatedTarget as Node)) return;
                  finishEditing();
                }}
              />
            )}
          </div>
        ) : (
          <div className="welcome">
            <div
              className="empty"
              role="button"
              tabIndex={0}
              aria-label="Open a PDF"
              onClick={() => fileInput.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInput.current?.click();
                }
              }}
            >
              <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4M7 9l5-5 5 5" />
                <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
              </svg>
              <p>
                Click or drop a PDF here, or paste it with{" "}
                <kbd>Ctrl</kbd>+<kbd>V</kbd> / <kbd>⌘</kbd>+<kbd>V</kbd>.
              </p>
            </div>
            <p className="privacy">
              <strong>Privacy notice.</strong> {PRIVACY}
            </p>
          </div>
        )}
      </section>

      <nav className="bottombar" aria-label="Page navigation">
        <a
          className="bottombar-left"
          href="https://github.com/chesterchong/pdf-editor"
          target="_blank"
          rel="noreferrer noopener"
          title="Source code on GitHub"
          aria-label="Source code on GitHub"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.35.78 1.05.78 2.12v3.14c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
          </svg>
          <span>Open source</span>
        </a>
        {pdf && (
          <div className="pages">
            <button
              aria-label="Previous page"
              disabled={busy || pageNumber <= 1}
              onClick={() => setPageNumber((n) => n - 1)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
              </svg>
            </button>
            <span>
              Page <strong>{pageNumber}</strong> of {pdf.numPages}
            </span>
            <button
              aria-label="Next page"
              disabled={busy || pageNumber >= pdf.numPages}
              onClick={() => setPageNumber((n) => n + 1)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
              </svg>
            </button>
          </div>
        )}
        <div className="bottombar-right">
          <p className="status" role="status" title={status}>
            {status}
          </p>
          {pdf && (
          <div className="zoomctl" role="group" aria-label="Zoom">
            <button aria-label="Zoom out" disabled={zoom <= ZOOM_MIN} onClick={() => zoomBy(1 / ZOOM_STEP)}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 12h12" />
              </svg>
            </button>
            <button className="zoom-value" title={`Reset zoom (${MOD}0)`} onClick={() => setZoom(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button aria-label="Zoom in" disabled={zoom >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 6v12M6 12h12" />
              </svg>
            </button>
          </div>
          )}
        </div>
      </nav>
    </div>
  );
}
