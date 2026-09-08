import { useEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { getDocument, GlobalWorkerOptions, RenderingCancelledException } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  PDFDocument,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import "@fontsource/dancing-script/400.css";
import "@fontsource/dancing-script/700.css";
import "@fontsource/great-vibes/400.css";
import "@fontsource/pacifico/400.css";
import "@fontsource/caveat/400.css";
import "@fontsource/caveat/700.css";
import { ColorPicker } from "./ColorPicker";
import "./App.css";

GlobalWorkerOptions.workerSrc = workerUrl;

const DEFAULT_COLOR = "#1d4ed8";
const DEFAULT_HIGHLIGHT = "#ffe95c";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Tool = "select" | "text" | "draw" | "highlight" | "sign" | "image";

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
type Item = Stroke | Highlight | TextItem | ImageItem;

type Line = { y0: number; y1: number; x0: number; x1: number };

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

/** Tools with a colour/size fly-out. Text and Signature are excluded: their
 * floating toolbar already covers font, size and colour once a box exists. */
const TOOL_OPTIONS: Partial<Record<Tool, { sizeLabel: string; min: number; max: number }>> = {
  draw: { sizeLabel: "Thickness", min: 6, max: 72 },
  highlight: { sizeLabel: "Height", min: 6, max: 72 },
};
const QUICK_COLORS = ["#172033", "#1d4ed8", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#db2777", "#ffffff"];
const QUICK_HIGHLIGHTS = ["#ffe95c", "#a7f3d0", "#bae6fd", "#fbcfe8", "#fed7aa", "#ddd6fe", "#fecaca", "#e2e8f0"];

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
const HIGHLIGHT_ALPHA = 0.45;

let nextId = 1;
const uid = () => String(nextId++);

const measureCtx = document.createElement("canvas").getContext("2d")!;

function fontString(item: TextItem) {
  return `${item.italic ? "italic " : ""}${item.bold ? "bold " : ""}${
    item.size
  }px "${item.font}", sans-serif`;
}

function layoutText(item: TextItem) {
  measureCtx.font = fontString(item);
  const fits = (s: string) => measureCtx.measureText(s).width <= item.width;
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
  if (item.kind === "image") {
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

function paint(
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
  items: Item[],
  skipId: string | null = null,
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
  for (const item of items) {
    if (item.id === skipId) continue;
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
    } else if (item.kind === "highlight") {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.fillStyle = item.color;
      for (const r of item.rects) {
        roundRect(ctx, r, 2);
        ctx.fill();
      }
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
};

/** Group the page's text runs into visual rows (viewport coordinates). */
function buildLines(raw: unknown[], view: PageViewport): Line[] {
  const boxes: Rect[] = [];
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
      for (const s of [-0.22, 0.9]) {
        const px = e + dir[0] * w * tt + up[0] * h * s;
        const py = f + dir[1] * w * tt + up[1] * h * s;
        const [vx, vy] = view.convertToViewportPoint(px, py);
        x0 = Math.min(x0, vx);
        y0 = Math.min(y0, vy);
        x1 = Math.max(x1, vx);
        y1 = Math.max(y1, vy);
      }
    }
    if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  boxes.sort((p, q) => p.y + p.h / 2 - (q.y + q.h / 2));
  const lines: Line[] = [];
  let current: Line | null = null;
  let currentCy = 0;
  for (const b of boxes) {
    const cy = b.y + b.h / 2;
    if (current && Math.abs(cy - currentCy) < Math.max(b.h, current.y1 - current.y0) * 0.5) {
      current.x0 = Math.min(current.x0, b.x);
      current.x1 = Math.max(current.x1, b.x + b.w);
      current.y0 = Math.min(current.y0, b.y);
      current.y1 = Math.max(current.y1, b.y + b.h);
      currentCy = (current.y0 + current.y1) / 2;
    } else {
      current = { x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h };
      currentCy = cy;
      lines.push(current);
    }
  }
  return lines;
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
  const [font, setFont] = useState("Arial");
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [draft, setDraft] = useState<Item | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cssScale, setCssScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const pageCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
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
  const bitmapTask = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);

  useEffect(() => {
    if (!panelOpen) return;
    function onDown(event: PointerEvent) {
      if (!panelRoot.current?.contains(event.target as Node)) setPanelOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [panelOpen]);

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
    setSelectedId(null);
    setEditingId(null);
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
        setViewport(view);
        const content = await page.getTextContent();
        if (!cancelled) setTextLines(buildLines(content.items, view));
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
  }, [pdf, pageNumber]);

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

  // Paint annotations; repaint once any web fonts finish loading.
  useEffect(() => {
    if (!viewport || !overlayCanvas.current) return;
    const canvas = overlayCanvas.current;
    const all = draft ? [...items, draft] : items;
    paint(canvas, viewport, all, editingId);
    const fonts = all.filter((i): i is TextItem => i.kind === "text");
    if (!fonts.length) return;
    let cancelled = false;
    Promise.all(fonts.map((i) => document.fonts.load(fontString(i))))
      .then(() => {
        if (!cancelled) paint(canvas, viewport, all, editingId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [viewport, items, draft, editingId]);

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
    const pdfFile = files.find(
      (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
    );
    if (pdfFile) {
      void openPdf(pdfFile);
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
      if (event.key === "Escape") {
        if (editingId) finishEditing();
        else setSelectedId(null);
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      // Undo / redo work everywhere except inside a text field, where the
      // browser's own text undo takes over.
      if (mod && !typing && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && !typing && key === "y") {
        event.preventDefault();
        redo();
        return;
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
      if (!mod && !event.altKey && pdf && !busy) {
        const byKey: Record<string, Tool> = {
          v: "select",
          t: "text",
          d: "draw",
          h: "highlight",
          s: "sign",
          i: "image",
        };
        const next = byKey[key];
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
      `Removed ${count === 1 ? "1 annotation" : `${count} annotations`}. Undo on each page with ${MOD}Z.`,
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
  }

  async function openPdf(file: File) {
    if (
      source &&
      !window.confirm("Open another PDF? Unsaved edits will be discarded.")
    )
      return;
    setBusy(true);
    setStatus("Opening PDF…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // PDF.js can transfer ownership of its buffer; keep a separate copy.
      const document = await getDocument({ data: bytes.slice() }).promise;
      setSource(bytes);
      setPdf(document);
      setFilename(file.name.replace(/\.pdf$/i, "") + "-edited");
      setPageNumber(1);
      setAnnotations({});
      history.current = {};
      future.current = {};
      setStatus(
        `Opened ${file.name} · ${document.numPages} ${document.numPages === 1 ? "page" : "pages"}.`,
      );
    } catch (error) {
      setStatus(`Could not open PDF: ${message(error)}`);
    } finally {
      setBusy(false);
    }
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
      // A signature is a text box preset to a script font at a larger size.
      const sign = tool === "sign";
      const textSize = sign ? Math.max(28, size * 2) : size;
      const width = Math.max(
        sign ? 220 : 120,
        Math.min(sign ? 360 : 260, viewport.width - p.x - 8),
      );
      const item: TextItem = {
        kind: "text",
        id: uid(),
        x: p.x,
        y: p.y,
        width,
        text: "",
        color,
        size: textSize,
        font: sign ? SIGNATURE_FONT : font,
        bold: false,
        italic: false,
        underline: false,
        strike: false,
      };
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
      for (const [pageKey, pageItems] of Object.entries(itemsRef.current)) {
        const drawable = pageItems.filter(
          (i) => i.kind !== "text" || i.text.trim(),
        );
        if (!drawable.length) continue;
        const index = Number(pageKey);
        const originalPage = await pdf.getPage(index);
        const view = originalPage.getViewport({ scale: 1.25 });
        const canvas = document.createElement("canvas");
        paint(canvas, view, drawable);
        const png = await output.embedPng(
          await (await canvasBlob(canvas)).arrayBuffer(),
        );
        const target = output.getPage(index - 1);
        // Map the visible overlay back into PDF coordinates.
        // This also accounts for rotated pages and crop-box offsets.
        const origin = view.convertToPdfPoint(0, view.height);
        const right = view.convertToPdfPoint(view.width, view.height);
        const top = view.convertToPdfPoint(0, 0);
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
        target.drawImage(png, { x: 0, y: 0, width: 1, height: 1 });
        target.pushOperators(popGraphicsState());
        canvas.width = 0;
        canvas.height = 0;
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
      setStatus(`Downloaded ${outputName}.`);
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
          <button className="primary" disabled={!pdf || busy} onClick={() => void exportPdf()}>
            {busy ? "Please wait…" : "Export"}
          </button>
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".pdf,application/pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openPdf(file);
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
        {tools.map((t) => {
          const opts = TOOL_OPTIONS[t.id];
          const active = tool === t.id;
          const isHighlight = t.id === "highlight";
          const current = isHighlight ? highlightColor : color;
          const setCurrent = isHighlight ? setHighlightColor : setColor;
          return (
            <div
              key={t.id}
              className="rail-item"
              ref={active && opts ? panelRoot : undefined}
              data-tip={`${t.label}  ·  ${t.shortcut}`}
            >
              <button
                className={`rail-btn ${active ? "active" : ""} ${opts ? "has-options" : ""}`}
                aria-label={t.label}
                aria-pressed={active}
                aria-expanded={opts ? active && panelOpen : undefined}
                disabled={busy}
                onClick={() => {
                  pickTool(t.id);
                  setPanelOpen(opts ? (active ? !panelOpen : true) : false);
                }}
              >
                {t.icon}
                {opts && <span className="rail-dot" style={{ background: current }} />}
              </button>
              {active && opts && panelOpen && (
                <div className="rail-pop tool-pop" role="dialog" aria-label={`${t.label} options`}>
                  <div className="tool-pop-title">{t.label}</div>
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
                        label={isHighlight ? "Highlight color" : "Annotation color"}
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
                      value={Math.min(opts.max, size)}
                      onChange={(event) => setSize(Number(event.target.value))}
                    />
                    <input
                      aria-label={`${opts.sizeLabel} value`}
                      type="number"
                      min={opts.min}
                      max="200"
                      value={size}
                      onChange={(event) =>
                        setSize(Math.min(200, Math.max(1, Number(event.target.value) || 1)))
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
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
        {pdf ? (
          <div
            ref={pageBox}
            className={`page tool-${tool} ${zoom !== 1 ? "zoomed" : ""}`}
            style={{ width: (viewport?.width || 800) * zoom }}
          >
            <canvas ref={pageCanvas} className="pdf-canvas" />
            <canvas
              ref={overlayCanvas}
              className="overlay"
              aria-label="PDF annotation surface"
              style={{
                visibility: viewport ? "visible" : "hidden",
                pointerEvents: busy ? "none" : "auto",
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

            {viewport && selected && selectedRect && !editing && (
              <div
                className="selection"
                style={{
                  left: pct(selectedRect.x, viewport.width),
                  top: pct(selectedRect.y, viewport.height),
                  width: pct(selectedRect.w, viewport.width),
                  height: pct(selectedRect.h, viewport.height),
                }}
              >
                {(selected.kind === "image"
                  ? (["nw", "ne", "sw", "se"] as Handle[])
                  : (["nw", "ne", "sw", "se", "e", "w"] as Handle[])
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

            {viewport && selected && selectedRect && barPos && (
              <div
                ref={floatbar}
                className="floatbar"
                role="toolbar"
                onPointerDown={() => {
                  barPress.current = true;
                  window.setTimeout(() => (barPress.current = false), 0);
                }}
                aria-label={selected.kind === "text" ? "Text formatting" : "Image options"}
                style={{ left: barPos.left, top: barPos.top }}
              >
                {selected.kind === "text" && (
                  <>
                    <select
                      aria-label="Font"
                      value={selected.font}
                      style={{ fontFamily: `"${selected.font}"` }}
                      onChange={(event) => {
                        setFont(event.target.value);
                        updateItem(selected.id, { font: event.target.value });
                        refocusEditor();
                      }}
                    >
                      {FONTS.map((f) => (
                        <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>
                          {f}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label="Font size"
                      className="num"
                      type="number"
                      min="4"
                      max="200"
                      value={Math.round(selected.size)}
                      onChange={(event) =>
                        updateItem(selected.id, {
                          size: Math.min(200, Math.max(4, Number(event.target.value) || 4)),
                        })
                      }
                    />
                    <ColorPicker
                      label="Text color"
                      value={selected.color}
                      defaultValue={DEFAULT_COLOR}
                      onChange={(next) => {
                        updateItem(selected.id, { color: next });
                        refocusEditor();
                      }}
                    />
                    <span className="sep" />
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
                        className={`fmt ${key} ${selected[key] ? "selected" : ""}`}
                        aria-pressed={selected[key]}
                        aria-label={key}
                        title={`${key[0].toUpperCase()}${key.slice(1)}  ·  ${MOD}${key === "strike" ? "⇧X" : label}`}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => updateItem(selected.id, { [key]: !selected[key] })}
                      >
                        {label}
                      </button>
                    ))}
                    <span className="sep" />
                    {!editing && (
                      <button
                        className="icon"
                        aria-label="Edit text"
                        title="Edit text"
                        onClick={() => setEditingId(selected.id)}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                          <path
                            fill="currentColor"
                            d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                          />
                        </svg>
                      </button>
                    )}
                  </>
                )}
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
