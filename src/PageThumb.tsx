import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

type Props = {
  pdf: PDFDocumentProxy;
  /** 1-based page number. */
  index: number;
  /** Render width in CSS pixels (also the raster resolution). */
  width: number;
  /** Stretch to the parent box instead of the fixed width (used by the page stack). */
  fill?: boolean;
};

/** Small raster preview of one page, used by the Organize grid. */
export function PageThumb({ pdf, index, width, fill = false }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState(1.3);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<PDFPageProxy["render"]> | undefined;
    (async () => {
      const page = await pdf.getPage(index);
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const view = page.getViewport({ scale: width / base.width });
      const density = Math.min(2, window.devicePixelRatio || 1);
      const el = canvas.current;
      el.width = Math.ceil(view.width * density);
      el.height = Math.ceil(view.height * density);
      setRatio(view.height / view.width);
      const ctx = el.getContext("2d");
      if (!ctx) return;
      task = page.render({
        canvas: el,
        canvasContext: ctx,
        viewport: view,
        transform: [density, 0, 0, density, 0, 0],
      });
      await task.promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, index, width]);

  return (
    <canvas
      ref={canvas}
      className="thumb"
      style={fill ? undefined : { width, height: Math.round(width * ratio) }}
      aria-label={`Page ${index}`}
    />
  );
}
