/**
 * Real removal of original page content.
 *
 * pdf.js tells us where text lines and images sit on the rendered page; this
 * module finds the operators in the page's content stream that draw them and
 * deletes those operators, so an export no longer contains the original text
 * or image at all (instead of hiding it under a patch).
 *
 * The walk is deliberately conservative: it tracks q/Q, cm, BT/ET, Td/TD/Tm/T*
 * and the text-showing operators, and it never descends into Form XObjects.
 * Anything it cannot place with confidence is left alone, and the caller falls
 * back to painting a cover.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from "pdf-lib";
import type { PageViewport } from "pdfjs-dist";

export type Rect = { x: number; y: number; w: number; h: number };
export type Removal = { kind: "text" | "image"; rect: Rect };

type Operand = number | string | Uint8Array | Operand[] | { name: string };
type Op = { op: string; operands: Operand[]; start: number; end: number };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

const isWs = (b: number) => WHITESPACE.has(b);
const isDelim = (b: number) => DELIMITERS.has(b);
const isRegular = (b: number) => !isWs(b) && !isDelim(b);

/** Tokenise a content stream into operators with their byte spans. */
export function tokenizeContent(bytes: Uint8Array): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let operands: Operand[] = [];
  let spanStart = -1;
  const n = bytes.length;

  const readNumber = (): number => {
    const s = i;
    while (i < n && isRegular(bytes[i])) i++;
    return Number(String.fromCharCode(...bytes.subarray(s, i)));
  };
  const readName = (): { name: string } => {
    i++; // '/'
    const s = i;
    while (i < n && isRegular(bytes[i])) i++;
    return { name: String.fromCharCode(...bytes.subarray(s, i)) };
  };
  const readLiteralString = (): Uint8Array => {
    i++; // '('
    let depth = 1;
    const out: number[] = [];
    while (i < n && depth > 0) {
      const b = bytes[i++];
      if (b === 0x5c) {
        // backslash escape
        const c = bytes[i++];
        if (c === 0x6e) out.push(0x0a);
        else if (c === 0x72) out.push(0x0d);
        else if (c === 0x74) out.push(0x09);
        else if (c === 0x62) out.push(0x08);
        else if (c === 0x66) out.push(0x0c);
        else if (c >= 0x30 && c <= 0x37) {
          let v = c - 0x30;
          for (let k = 0; k < 2 && bytes[i] >= 0x30 && bytes[i] <= 0x37; k++) v = v * 8 + (bytes[i++] - 0x30);
          out.push(v & 0xff);
        } else if (c === 0x0d) {
          if (bytes[i] === 0x0a) i++;
        } else if (c !== 0x0a) out.push(c);
      } else if (b === 0x28) {
        depth++;
        out.push(b);
      } else if (b === 0x29) {
        depth--;
        if (depth > 0) out.push(b);
      } else out.push(b);
    }
    return Uint8Array.from(out);
  };
  const readHexString = (): Uint8Array => {
    i++; // '<'
    const out: number[] = [];
    let digits = "";
    while (i < n && bytes[i] !== 0x3e) {
      const ch = String.fromCharCode(bytes[i++]);
      if (/[0-9a-fA-F]/.test(ch)) digits += ch;
    }
    i++; // '>'
    if (digits.length % 2) digits += "0";
    for (let k = 0; k < digits.length; k += 2) out.push(parseInt(digits.slice(k, k + 2), 16));
    return Uint8Array.from(out);
  };
  const readArray = (): Operand[] => {
    i++; // '['
    const arr: Operand[] = [];
    while (i < n) {
      skipWs();
      if (i >= n) break;
      const b = bytes[i];
      if (b === 0x5d) {
        i++;
        break;
      }
      const v = readOperand();
      if (v !== undefined) arr.push(v);
      else i++;
    }
    return arr;
  };
  const skipWs = () => {
    while (i < n) {
      if (isWs(bytes[i])) i++;
      else if (bytes[i] === 0x25) {
        while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      } else break;
    }
  };
  const readOperand = (): Operand | undefined => {
    const b = bytes[i];
    if (b === 0x2f) return readName();
    if (b === 0x28) return readLiteralString();
    if (b === 0x5b) return readArray();
    if (b === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        // dictionary: consume balanced << >> and keep as opaque string
        const s = i;
        let depth = 0;
        while (i < n) {
          if (bytes[i] === 0x3c && bytes[i + 1] === 0x3c) {
            depth++;
            i += 2;
          } else if (bytes[i] === 0x3e && bytes[i + 1] === 0x3e) {
            depth--;
            i += 2;
            if (depth === 0) break;
          } else if (bytes[i] === 0x28) readLiteralString();
          else i++;
        }
        return String.fromCharCode(...bytes.subarray(s, Math.min(i, s + 64)));
      }
      return readHexString();
    }
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) return readNumber();
    return undefined;
  };

  while (i < n) {
    skipWs();
    if (i >= n) break;
    if (spanStart < 0) spanStart = i;
    const b = bytes[i];
    const operand = readOperand();
    if (operand !== undefined) {
      operands.push(operand);
      continue;
    }
    if (isDelim(b)) {
      // stray delimiter (e.g. ] or }); skip it
      i++;
      continue;
    }
    // operator
    const s = i;
    while (i < n && isRegular(bytes[i])) i++;
    const op = String.fromCharCode(...bytes.subarray(s, i));
    if (op === "BI") {
      // Inline image: skip to ID, then binary data up to a whitespace-delimited EI.
      let j = i;
      while (j < n && !(bytes[j] === 0x49 && bytes[j + 1] === 0x44 && isWs(bytes[j + 2] ?? 0x20) && !isRegular(bytes[j - 1]))) j++;
      j += 3;
      while (j < n) {
        if (bytes[j] === 0x45 && bytes[j + 1] === 0x49 && isWs(bytes[j - 1]) && (j + 2 >= n || isWs(bytes[j + 2]) || isDelim(bytes[j + 2]))) break;
        j++;
      }
      i = Math.min(n, j + 2);
      ops.push({ op: "INLINE_IMAGE", operands: [], start: spanStart, end: i });
    } else {
      ops.push({ op, operands, start: spanStart, end: i });
    }
    operands = [];
    spanStart = -1;
  }
  return ops;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, c: Matrix): Matrix => [
  m[0] * c[0] + m[1] * c[2],
  m[0] * c[1] + m[1] * c[3],
  m[2] * c[0] + m[3] * c[2],
  m[2] * c[1] + m[3] * c[3],
  m[4] * c[0] + m[5] * c[2] + c[4],
  m[4] * c[1] + m[5] * c[3] + c[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const nums = (ops: Operand[], count: number): number[] | null => {
  const tail = ops.slice(-count);
  return tail.length === count && tail.every((v) => typeof v === "number") ? (tail as number[]) : null;
};

/** Where each drawing operator lands on the rendered page (viewport space). */
type Placement = { index: number; kind: "text"; point: [number, number] } | { index: number; kind: "image"; rect: Rect };

function placeOps(ops: Op[], view: PageViewport, imageNames: Set<string>): Placement[] {
  const out: Placement[] = [];
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  const toView = (x: number, y: number): [number, number] => {
    const p = view.convertToViewportPoint(x, y);
    return [p[0], p[1]];
  };
  const textPoint = (index: number) => {
    const [ux, uy] = apply(mul(tm, ctm), 0, 0);
    out.push({ index, kind: "text", point: toView(ux, uy) });
  };
  const nextLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  ops.forEach((o, index) => {
    switch (o.op) {
      case "q":
        stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? ctm;
        break;
      case "cm": {
        const m = nums(o.operands, 6);
        if (m) ctm = mul(m as Matrix, ctm);
        break;
      }
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "TL": {
        const v = nums(o.operands, 1);
        if (v) leading = v[0];
        break;
      }
      case "Td": {
        const v = nums(o.operands, 2);
        if (v) nextLine(v[0], v[1]);
        break;
      }
      case "TD": {
        const v = nums(o.operands, 2);
        if (v) {
          leading = -v[1];
          nextLine(v[0], v[1]);
        }
        break;
      }
      case "Tm": {
        const m = nums(o.operands, 6);
        if (m) {
          tm = m as Matrix;
          tlm = tm;
        }
        break;
      }
      case "T*":
        nextLine(0, -leading);
        break;
      case "Tj":
      case "TJ":
        textPoint(index);
        break;
      case "'":
        nextLine(0, -leading);
        textPoint(index);
        break;
      case '"': {
        nextLine(0, -leading);
        textPoint(index);
        break;
      }
      case "Do": {
        const name = o.operands[o.operands.length - 1];
        if (name && typeof name === "object" && "name" in name && imageNames.has(name.name)) {
          out.push({ index, kind: "image", rect: unitSquare(ctm, toView) });
        }
        break;
      }
      case "INLINE_IMAGE":
        out.push({ index, kind: "image", rect: unitSquare(ctm, toView) });
        break;
    }
  });
  return out;
}

function unitSquare(ctm: Matrix, toView: (x: number, y: number) => [number, number]): Rect {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => {
    const [ux, uy] = apply(ctm, x, y);
    return toView(ux, uy);
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function overlap(a: Rect, b: Rect) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Concatenated, decoded content of a page (its streams joined with newlines). */
function readContent(doc: PDFDocument, pageIndex: number): Uint8Array | null {
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  if (!contents) return null;
  const streams: PDFStream[] = [];
  const resolve = (v: unknown) => (v instanceof PDFRef ? doc.context.lookup(v) : v);
  if (contents instanceof PDFArray) {
    for (const el of contents.asArray()) {
      const s = resolve(el);
      if (s instanceof PDFStream) streams.push(s);
    }
  } else if (contents instanceof PDFStream) streams.push(contents);
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s as PDFStream & { getContents?: () => Uint8Array }).getContents?.();
    if (!bytes) return null;
    parts.push(bytes, Uint8Array.of(0x0a));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Names of image XObjects in the page's resources. */
function imageXObjectNames(doc: PDFDocument, pageIndex: number): Set<string> {
  const names = new Set<string>();
  const page = doc.getPage(pageIndex);
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return names;
  for (const [key, value] of xobjects.entries()) {
    const stream = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (stream instanceof PDFStream) {
      const subtype = stream.dict.lookup(PDFName.of("Subtype"));
      if (subtype instanceof PDFName && subtype.decodeText() === "Image") names.add(key.decodeText());
    }
  }
  return names;
}

/**
 * Delete the operators that draw the given regions from a page. Returns, per
 * removal, whether anything was deleted; callers keep a cover for the rest.
 */
export function stripFromPage(doc: PDFDocument, pageIndex: number, view: PageViewport, removals: Removal[]): boolean[] {
  const results = removals.map(() => false);
  if (!removals.length) return results;
  let bytes: Uint8Array | null;
  try {
    bytes = readContent(doc, pageIndex);
  } catch {
    return results;
  }
  if (!bytes) return results;
  const ops = tokenizeContent(bytes);
  const placements = placeOps(ops, view, imageXObjectNames(doc, pageIndex));
  const doomed = new Set<number>();
  removals.forEach((rm, k) => {
    for (const pl of placements) {
      if (rm.kind === "text" && pl.kind === "text") {
        const [px, py] = pl.point;
        const r = rm.rect;
        // Baseline origin inside the line's box (a little slack to the left for runs
        // that start before the first glyph's ink).
        if (py >= r.y - 1 && py <= r.y + r.h + 1 && px >= r.x - r.h && px <= r.x + r.w + 1) {
          doomed.add(pl.index);
          results[k] = true;
        }
      } else if (rm.kind === "image" && pl.kind === "image") {
        if (overlap(rm.rect, pl.rect) > 0.7) {
          doomed.add(pl.index);
          results[k] = true;
        }
      }
    }
  });
  if (!doomed.size) return results;
  // Rebuild the stream without the doomed spans.
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const idx of [...doomed].sort((a, b) => a - b)) {
    const o = ops[idx];
    parts.push(bytes.subarray(cursor, o.start), Uint8Array.of(0x0a));
    cursor = o.end;
  }
  parts.push(bytes.subarray(cursor));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const rebuilt = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    rebuilt.set(p, offset);
    offset += p.length;
  }
  const page = doc.getPage(pageIndex);
  const stream = doc.context.flateStream(rebuilt);
  page.node.set(PDFName.of("Contents"), doc.context.register(stream));
  return results;
}
