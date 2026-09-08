// Copy the on-device OCR engine (tesseract.js worker + WebAssembly cores) into
// public/ocr so the app never loads them from a third-party CDN. The English
// language model lives in public/ocr/lang and is committed.
import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";

const core = "node_modules/tesseract.js-core";
const worker = "node_modules/tesseract.js/dist/worker.min.js";
if (!existsSync(core) || !existsSync(worker)) {
  console.warn("copy-ocr: tesseract.js not installed yet, skipping");
  process.exit(0);
}
mkdirSync("public/ocr/core", { recursive: true });
copyFileSync(worker, "public/ocr/worker.min.js");
for (const file of readdirSync(core)) {
  if (file.endsWith(".wasm.js")) copyFileSync(`${core}/${file}`, `public/ocr/core/${file}`);
}
console.log("copy-ocr: assets ready in public/ocr");
