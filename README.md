# PDF Studio

Browser-based PDF editor for confidential documents. **Your PDF never leaves your computer.**

## Privacy

All processing happens inside the browser tab: PDF rendering (pdf.js), editing, and export (pdf-lib) run locally. There is no backend, no upload, no analytics, and no third-party font or script loading. Signature fonts are bundled with the app.

The production deployment enforces this with a `Content-Security-Policy` header (`connect-src 'none'`), so the page cannot make network requests after it loads. You can go offline and keep working.

## Features

- **Text boxes**: click to place, type inline. Move by dragging, scale from a corner, reflow from a side. Font family, size, color, bold, italic, underline, strikethrough.
- **Images**: place, move, and resize from the corners (aspect ratio kept).
- **Signatures**: type your name and pick a script style, or draw by hand. Signatures are movable and resizable.
- **Highlights**: drag across text and the highlight snaps to the text lines.
- **Freehand drawing**, multi-page navigation, undo, and local save (File System Access API with a download fallback).

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Output is in `dist/`. Deploys as a static Vite site (framework: Vite, build `npm run build`, output `dist`).
