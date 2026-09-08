# PDF Studio

A PDF editor that runs entirely in your browser. Open, annotate, sign, edit, reorganise and export PDFs. Nothing you open is uploaded anywhere.

Live: https://pdf-editor-three-nu.vercel.app

## What it does

- Text boxes, signatures, freehand drawing, highlights and images
- Edit existing page content: lift text or images, retype, move, or remove them
- OCR for scanned pages, running on your device
- Rotate, crop, reorder, remove, extract and combine pages
- Watermarks
- Export as a real PDF with selectable text

## Privacy, and how to check it yourself

The app is a static site. There is no server-side code and no account. Your files stay in the browser tab.

You can verify this in a few minutes:

1. **Watch the network.** Open the site, open your browser's developer tools and switch to the Network tab. Load a PDF, annotate it and export it. You will see no requests while you work. The only later requests are the app fetching its own font or OCR engine files from the same origin, never sending anything out.
2. **Go offline.** Load the page once, then turn off your connection. Everything keeps working, including export.
3. **Read the source.** This repository is the complete source of the deployed site. Search it for `fetch(` and you will find only same-origin loads of font and OCR files. There are no analytics, trackers or third-party scripts.
4. **Build it yourself.** The deployed site is built from this repository on every push to `main`. You can build the same thing locally:

   ```bash
   npm install
   npm run build
   npm run preview
   ```

   `npm install` also copies the OCR engine into `public/ocr` from the `tesseract.js` packages, so the app never loads it from a third-party CDN.

## Develop

```bash
npm install
npm run dev
```

Built with React, Vite, [pdf.js](https://mozilla.github.io/pdf.js/), [pdf-lib](https://pdf-lib.js.org/) and [tesseract.js](https://tesseract.projectnaptha.com/).

## License

MIT
