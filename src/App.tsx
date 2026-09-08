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
import "./App.css";

GlobalWorkerOptions.workerSrc = workerUrl;

type Point = { x: number; y: number };
type Tool = "text" | "draw" | "highlight" | "image" | "sign";
type Stroke = {
  kind: "stroke";
  points: Point[];
  color: string;
  width: number;
  alpha: number;
};
type Item =
  | Stroke
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      color: string;
      size: number;
    }
  | {
      kind: "image";
      x: number;
      y: number;
      width: number;
      height: number;
      image: HTMLImageElement;
    };
type SaveHandle = {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
};
type SavePicker = (options: {
  suggestedName: string;
  types: {
    description: string;
    accept: Record<string, string[]>;
  }[];
}) => Promise<SaveHandle>;

function paint(
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
  items: Item[],
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
    ctx.save();
    if (item.kind === "text") {
      ctx.fillStyle = item.color;
      ctx.font = `${item.size}px Arial, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(item.text, item.x, item.y);
    } else if (item.kind === "image") {
      ctx.drawImage(item.image, item.x, item.y, item.width, item.height);
    } else {
      ctx.globalAlpha = item.alpha;
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

export default function App() {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [source, setSource] = useState<Uint8Array | null>(null);
  const [filename, setFilename] = useState("document.pdf");
  const [pageNumber, setPageNumber] = useState(1);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [annotations, setAnnotations] = useState<Record<number, Item[]>>({});
  const [tool, setTool] = useState<Tool>("text");
  const [color, setColor] = useState("#2563eb");
  const [size, setSize] = useState(24);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Open a PDF to get started.");
  const pageCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const activeStroke = useRef<Stroke | null>(null);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask:
      | ReturnType<
          Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]
        >
      | undefined;
    setViewport(null);
    activeStroke.current = null;
    setDraft(null);
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
        if (!cancelled) setViewport(view);
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

  useEffect(() => {
    if (!viewport || !overlayCanvas.current) return;
    const items = annotations[pageNumber] || [];
    paint(overlayCanvas.current, viewport, draft ? [...items, draft] : items);
  }, [viewport, annotations, pageNumber, draft]);

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
      setStatus("PDF ready. Select a tool and edit the page.");
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
      setStatus("Click the PDF to place the image. Size controls its width.");
    } catch {
      setStatus("Could not read that image. Try PNG or JPEG.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function addItem(item: Item) {
    setAnnotations((current) => ({
      ...current,
      [pageNumber]: [...(current[pageNumber] || []), item],
    }));
  }

  function point(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * viewport!.width) / rect.width,
      y: ((event.clientY - rect.top) * viewport!.height) / rect.height,
    };
  }

  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!viewport || busy || event.button !== 0 || !event.isPrimary) return;
    const p = point(event);
    if (tool === "text") {
      const text = window.prompt("Enter text:");
      if (text?.trim()) {
        addItem({ kind: "text", ...p, text, color, size });
      }
      return;
    }
    if (tool === "image") {
      if (!image) {
        setStatus("Choose an image first.");
        return;
      }
      const width = size * 8;
      addItem({
        kind: "image",
        ...p,
        image,
        width,
        height: (width * image.naturalHeight) / image.naturalWidth,
      });
      return;
    }
    const stroke: Stroke = {
      kind: "stroke",
      points: [p],
      color: tool === "highlight" ? "#ffe100" : color,
      width: tool === "highlight" ? size : Math.max(1, size / 8),
      alpha: tool === "highlight" ? 0.3 : 1,
    };
    activeStroke.current = stroke;
    setDraft(stroke);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!activeStroke.current || !viewport || !event.isPrimary) return;
    const next = {
      ...activeStroke.current,
      points: [...activeStroke.current.points, point(event)],
    };
    activeStroke.current = next;
    setDraft(next);
  }

  function finishStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!event.isPrimary) return;
    if (activeStroke.current) addItem(activeStroke.current);
    activeStroke.current = null;
    setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function undo() {
    setAnnotations((current) => ({
      ...current,
      [pageNumber]: (current[pageNumber] || []).slice(0, -1),
    }));
  }

  async function savePdf() {
    if (!source || !pdf) return;
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
      const output = await PDFDocument.load(source.slice());
      for (const [pageKey, items] of Object.entries(annotations)) {
        if (!items.length) continue;
        const index = Number(pageKey);
        const originalPage = await pdf.getPage(index);
        const view = originalPage.getViewport({ scale: 1.25 });
        const canvas = document.createElement("canvas");
        paint(canvas, view, items);
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

  return (
    <main>
      <header>
        <div>
          <h1>PDF Studio</h1>
          <p>Edit privately in your browser.</p>
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
          {(["text", "draw", "highlight", "sign", "image"] as Tool[]).map(
            (value) => (
              <button
                key={value}
                aria-pressed={tool === value}
                className={tool === value ? "selected" : ""}
                onClick={() => setTool(value)}
                disabled={busy}
              >
                {value === "sign" ? "Signature" : value}
              </button>
            ),
          )}
        </div>
        <label className="control">
          Color
          <input
            aria-label="Annotation color"
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          />
        </label>
        <label className="control">
          Size
          <input
            aria-label="Annotation size"
            type="range"
            min="8"
            max="64"
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
        <button
          onClick={undo}
          disabled={busy || !annotations[pageNumber]?.length}
        >
          Undo
        </button>
      </section>
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
            <div className="page" style={{ width: viewport?.width || 800 }}>
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
                onPointerUp={finishStroke}
                onPointerCancel={() => {
                  activeStroke.current = null;
                  setDraft(null);
                }}
              />
            </div>
          </section>
        </>
      ) : (
        <section className="empty">
          <h2>Your PDF, your workspace</h2>
          <p>Open a PDF, annotate it, then save a copy locally.</p>
          <p>No account or document upload required.</p>
        </section>
      )}
      <footer>
        Text and images: click to place. Draw, highlight, and signature: drag
        on the page. Use Undo to remove the last addition. Edits are not saved
        automatically.
      </footer>
    </main>
  );
}
