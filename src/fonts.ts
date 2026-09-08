/**
 * Real fonts for exported text. Standard families map onto the PDF base-14
 * fonts (no embedding needed); the script faces are embedded from the same
 * WOFF files the preview uses, so the export matches what was on screen.
 */
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import dancing400 from "@fontsource/dancing-script/files/dancing-script-latin-400-normal.woff?url";
import dancing700 from "@fontsource/dancing-script/files/dancing-script-latin-700-normal.woff?url";
import greatVibes from "@fontsource/great-vibes/files/great-vibes-latin-400-normal.woff?url";
import pacifico from "@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url";
import caveat400 from "@fontsource/caveat/files/caveat-latin-400-normal.woff?url";
import caveat700 from "@fontsource/caveat/files/caveat-latin-700-normal.woff?url";

type Face = { family: string; bold: boolean; italic: boolean };

const EMBEDDED: Record<string, { regular: string; bold?: string }> = {
  "Dancing Script": { regular: dancing400, bold: dancing700 },
  "Great Vibes": { regular: greatVibes },
  Pacifico: { regular: pacifico },
  Caveat: { regular: caveat400, bold: caveat700 },
};

/** Distance from the top of the em box to the baseline, as a fraction of the
 * font size. Matches the browser's `textBaseline: "top"` placement used by
 * the preview, so exported text lands where it was drawn. */
const ASCENT: Record<string, number> = {
  Helvetica: 0.905,
  Times: 0.891,
  Courier: 0.833,
  "Dancing Script": 1.16,
  "Great Vibes": 0.94,
  Pacifico: 1.15,
  Caveat: 0.92,
};

function standardFor({ family, bold, italic }: Face): { name: StandardFonts; group: string } {
  const f = family.toLowerCase();
  if (f.includes("courier") || f.includes("mono")) {
    const name = bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
    return { name, group: "Courier" };
  }
  if (f.includes("times") || f.includes("georgia") || f.includes("serif")) {
    const name = bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
    return { name, group: "Times" };
  }
  const name = bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
  return { name, group: "Helvetica" };
}

export type ResolvedFont = { font: PDFFont; ascent: number; embedded: boolean };

/** Fonts are embedded once per export; the cache lives for one document. */
export class FontBook {
  private cache = new Map<string, Promise<ResolvedFont>>();
  private doc: PDFDocument;
  constructor(doc: PDFDocument) {
    this.doc = doc;
  }

  get(face: Face): Promise<ResolvedFont> {
    const embedded = EMBEDDED[face.family];
    const key = embedded ? `${face.family}:${face.bold && embedded.bold ? "700" : "400"}` : standardFor(face).name;
    let entry = this.cache.get(key);
    if (!entry) {
      entry = embedded ? this.embed(face, embedded) : this.standard(face);
      this.cache.set(key, entry);
    }
    return entry;
  }

  private async standard(face: Face): Promise<ResolvedFont> {
    const { name, group } = standardFor(face);
    return { font: await this.doc.embedFont(name), ascent: ASCENT[group], embedded: false };
  }

  private async embed(face: Face, files: { regular: string; bold?: string }): Promise<ResolvedFont> {
    const url = face.bold && files.bold ? files.bold : files.regular;
    const bytes = await (await fetch(url)).arrayBuffer();
    const font = await this.doc.embedFont(bytes, { subset: true });
    // Prefer the face's own hhea metrics, which is what the browser used on screen.
    const fk = (font as unknown as { embedder?: { font?: { ascent?: number; unitsPerEm?: number } } }).embedder?.font;
    const ascent = fk?.ascent && fk.unitsPerEm ? fk.ascent / fk.unitsPerEm : (ASCENT[face.family] ?? 0.95);
    return { font, ascent, embedded: true };
  }
}
