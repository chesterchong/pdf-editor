import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy, PageViewport } from "pdfjs-dist";
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
import "./App.css";

GlobalWorkerOptions.workerSrc = workerUrl;

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

type SaveHandle = {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
};
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveHandle>;

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
const SIGNATURE_FONTS = ["Dancing Script", "Great Vibes", "Pacifico", "Caveat"];
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
  const [filename, setFilename] = useState("document.pdf");
  const [pageNumber, setPageNumber] = useState(1);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [textLines, setTextLines] = useState<Line[]>([]);
  const [annotations, setAnnotations] = useState<Record<number, Item[]>>({});
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState("#1d4ed8");
  const [highlightColor, setHighlightColor] = useState("#ffe95c");
  const [size, setSize] = useState(18);
  const [font, setFont] = useState("Arial");
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [draft, setDraft] = useState<Item | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sigText, setSigText] = useState("");
  const [sigFont, setSigFont] = useState(SIGNATURE_FONTS[0]);
  const [cssScale, setCssScale] = useState(1);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Open a PDF to get started.");
  const [historyLength, setHistoryLength] = useState(0);

  const pageCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const pageBox = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<Drag | null>(null);
  const itemsRef = useRef<Record<number, Item[]>>({});
  const history = useRef<Record<number, Item[][]>>({});
  itemsRef.current = annotations;

  const items = annotations[pageNumber] ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const editing =
    (items.find((i) => i.id === editingId) as TextItem | undefined) ?? null;

  // Render the current page.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask:
      | ReturnType<
          Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]
        >
      | undefined;
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
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const density = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(view.width * density);
        canvas.height = Math.ceil(view.height * density);
        renderTask = page.render({
          canvas,
          canvasContext: ctx,
          viewport: view,
          transform: [
            canvas.width / view.width,
            0,
            0,
            canvas.height / view.height,
            0,
            0,
          ],
        });
        await renderTask.promise;
        if (cancelled) return;
        setViewport(view);
        const content = await page.getTextContent();
        if (!cancelled) setTextLines(buildLines(content.items, view));
      } catch (error) {
        if (!cancelled) setStatus(`Preview error: ${message(error)}`);
      }
    }
    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber]);

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
      if (typing) return;
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
    setHistoryLength(history.current[pageNumber].length);
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

  function undo() {
    const stack = history.current[pageNumber] ?? [];
    const previous = stack.pop();
    if (!previous) return;
    setHistoryLength(stack.length);
    setEditingId(null);
    setSelectedId(null);
    setAnnotations((current) => ({ ...current, [pageNumber]: previous }));
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
      setFilename(file.name);
      setPageNumber(1);
      setAnnotations({});
      history.current = {};
      setHistoryLength(0);
      setStatus("PDF ready. Pick a tool, or click an item to move or resize it.");
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
    if (tool === "text") {
      const width = Math.max(120, Math.min(260, viewport.width - p.x - 8));
      const item: TextItem = {
        kind: "text",
        id: uid(),
        x: p.x,
        y: p.y,
        width,
        text: "",
        color,
        size,
        font,
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
        setStatus("Choose an image first.");
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
    if (tool === "sign") {
      setStatus("Type your name in the signature panel, or use Draw to sign by hand.");
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

  function addSignature() {
    if (!viewport || !sigText.trim()) return;
    const item: TextItem = {
      kind: "text",
      id: uid(),
      x: 0,
      y: 0,
      width: 0,
      text: sigText.trim(),
      color,
      size: 44,
      font: sigFont,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
    };
    measureCtx.font = fontString(item);
    item.width = Math.ceil(measureCtx.measureText(item.text).width) + 8;
    item.x = Math.max(0, (viewport.width - item.width) / 2);
    item.y = viewport.height * 0.6;
    addItem(item);
    setSelectedId(item.id);
    setTool("select");
    setStatus("Signature added. Drag it into place; drag a corner to resize.");
  }

  function pickTool(next: Tool) {
    finishEditing();
    setTool(next);
    if (next !== "select") setSelectedId(null);
    if (next === "sign") {
      setStatus("Type your name and choose a style, or pick Draw to sign by hand.");
    }
  }

  async function savePdf() {
    if (!source || !pdf) return;
    finishEditing();
    setBusy(true);
    setStatus("Preparing your PDF…");
    try {
      const outputName = filename.replace(/\.pdf$/i, "") + "-edited.pdf";
      const picker = (window as Window & { showSaveFilePicker?: SavePicker })
        .showSaveFilePicker;
      // Open the picker immediately while the click's user activation exists.
      const handle = picker
        ? await picker.call(window, {
            suggestedName: outputName,
            types: [
              {
                description: "PDF document",
                accept: { "application/pdf": [".pdf"] },
              },
            ],
          })
        : null;
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
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setStatus("PDF saved to your selected location.");
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = outputName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setStatus("Download started. Your browser controls the save location.");
      }
    } catch (error) {
      setStatus(
        error instanceof DOMException && error.name === "AbortError"
          ? "Save cancelled."
          : `Save failed: ${message(error)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const selectedRect = selected && viewport ? itemRect(selected) : null;
  const editingLayout = editing ? layoutText(editing) : null;

  const toolLabels: Record<Tool, string> = {
    select: "Select",
    text: "Text",
    draw: "Draw",
    highlight: "Highlight",
    sign: "Signature",
    image: "Image",
  };

  return (
    <main>
      <header>
        <div>
          <h1>PDF Studio</h1>
          <p>Edit privately in your browser. Your files never leave this device.</p>
        </div>
        <button
          className="primary"
          disabled={!pdf || busy}
          onClick={() => void savePdf()}
        >
          {busy ? "Please wait…" : "Save PDF"}
        </button>
      </header>

      <section className="toolbar" aria-label="PDF editing tools">
        <label className="file-button">
          Open PDF
          <input
            type="file"
            accept=".pdf,application/pdf"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openPdf(file);
              event.target.value = "";
            }}
          />
        </label>
        <div className="tools">
          {(Object.keys(toolLabels) as Tool[]).map((value) => (
            <button
              key={value}
              aria-pressed={tool === value}
              className={tool === value ? "selected" : ""}
              onClick={() => pickTool(value)}
              disabled={busy}
            >
              {toolLabels[value]}
            </button>
          ))}
        </div>
        {tool === "highlight" ? (
          <label className="control">
            Highlight
            <input
              aria-label="Highlight color"
              type="color"
              value={highlightColor}
              onChange={(event) => setHighlightColor(event.target.value)}
            />
          </label>
        ) : (
          <label className="control">
            Color
            <input
              aria-label="Annotation color"
              type="color"
              value={color}
              onChange={(event) => {
                setColor(event.target.value);
                if (selected?.kind === "text") {
                  updateItem(selected.id, { color: event.target.value });
                }
              }}
            />
          </label>
        )}
        <label className="control">
          {tool === "text" ? "Font size" : "Size"}
          <input
            aria-label="Annotation size"
            type="range"
            min="6"
            max="72"
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
          />
          <span>{size}</span>
        </label>
        <label className="file-button">
          Choose image
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void openImage(file);
              event.target.value = "";
            }}
          />
        </label>
        <button onClick={undo} disabled={busy || !historyLength}>
          Undo
        </button>
      </section>

      {tool === "sign" && pdf && (
        <section className="panel" aria-label="Signature">
          <input
            className="sig-input"
            placeholder="Type your name"
            value={sigText}
            onChange={(event) => setSigText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addSignature();
            }}
          />
          <div className="sig-styles" role="radiogroup" aria-label="Signature style">
            {SIGNATURE_FONTS.map((f) => (
              <button
                key={f}
                role="radio"
                aria-checked={sigFont === f}
                className={`sig-style ${sigFont === f ? "selected" : ""}`}
                style={{ fontFamily: `"${f}", cursive`, color }}
                onClick={() => setSigFont(f)}
              >
                {sigText.trim() || "Your Name"}
              </button>
            ))}
          </div>
          <button
            className="primary"
            disabled={!sigText.trim() || !viewport}
            onClick={addSignature}
          >
            Add signature
          </button>
          <span className="hint">Prefer handwriting? Use Draw to sign with your mouse or finger.</span>
        </section>
      )}

      {selected?.kind === "text" && (
        <section className="panel props" aria-label="Text formatting">
          <select
            aria-label="Font"
            value={selected.font}
            style={{ fontFamily: `"${selected.font}"` }}
            onChange={(event) => {
              setFont(event.target.value);
              updateItem(selected.id, { font: event.target.value });
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
          <input
            aria-label="Text color"
            type="color"
            value={selected.color}
            onChange={(event) => updateItem(selected.id, { color: event.target.value })}
          />
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
              onClick={() => updateItem(selected.id, { [key]: !selected[key] })}
            >
              {label}
            </button>
          ))}
          <button onClick={() => setEditingId(selected.id)}>Edit text</button>
          <button className="danger" onClick={() => removeItem(selected.id)}>
            Delete
          </button>
        </section>
      )}
      {selected?.kind === "image" && (
        <section className="panel props" aria-label="Image options">
          <span className="hint">Drag the image to move it. Drag a corner to resize.</span>
          <button className="danger" onClick={() => removeItem(selected.id)}>
            Delete
          </button>
        </section>
      )}

      <p className="status" role="status">
        {status}
      </p>

      {pdf ? (
        <>
          <nav className="pagination" aria-label="PDF pages">
            <button
              disabled={busy || pageNumber <= 1}
              onClick={() => setPageNumber((n) => n - 1)}
            >
              Previous
            </button>
            <span>
              Page {pageNumber} of {pdf.numPages}
            </span>
            <button
              disabled={busy || pageNumber >= pdf.numPages}
              onClick={() => setPageNumber((n) => n + 1)}
            >
              Next
            </button>
          </nav>
          <section className="workspace">
            <div
              ref={pageBox}
              className={`page tool-${tool}`}
              style={{ width: viewport?.width || 800 }}
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
                  onFocus={() => pushHistory(itemsRef.current[pageNumber] ?? [])}
                  onBlur={finishEditing}
                />
              )}
            </div>
          </section>
        </>
      ) : (
        <section className="empty">
          <h2>Your PDF, your workspace</h2>
          <p>Open a PDF, annotate it, then save a copy locally.</p>
          <p>No account, no upload, no server. Everything runs in this browser tab.</p>
        </section>
      )}

      <footer>
        <p className="privacy">
          <strong>Privacy notice.</strong> This tool is built for confidential
          documents. Your PDF, images, and signatures are processed entirely on
          your own computer, inside this browser tab. Nothing is uploaded,
          transmitted, or stored on any server, and the page makes no network
          requests after it loads. You can disconnect from the internet and
          keep working. Edits are kept in memory only until you save a copy.
        </p>
        <p>
          Text: click to place a box and type; drag it to move, drag a corner to
          scale, drag a side to reflow. Double-click a box to edit it. Images:
          drag to move, drag a corner to resize. Highlight: drag across text and
          it snaps to the lines. Delete or Backspace removes the selection.
        </p>
      </footer>
    </main>
  );
}
