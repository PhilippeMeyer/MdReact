import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import PDFDocument from 'pdfkit';

import {
  renderMarkdownStyled,
  renderMarkdownWithTOC,
  stampPages,
  loadImages,
  parseFrontMatter,
  frontMatterToOptions,
  frontMatterToPageOptions,
  frontMatterToFilename,
  applyDocumentInfo
} from './md2pdf.js';

const app = express();

// Rendering is CPU-bound and can fetch remote images, so the endpoint is the
// expensive part of this server: cap how hard a single client can lean on it.
const MAX_BODY = process.env.PDF_MAX_BODY || '2mb';
const RENDER_TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS || 20000);

const limiter = rateLimit({
  windowMs: Number(process.env.PDF_RATE_WINDOW_MS || 60_000),
  limit: Number(process.env.PDF_RATE_MAX || 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests - please slow down' }
});

app.use(cors({ origin: true, exposedHeaders: ['Content-Disposition', 'X-Pdf-Warnings'] }));
app.use(express.json({ limit: MAX_BODY }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/generatePDF', limiter, async (req, res) => {
  // Never let one document tie the connection up forever: a slow image host or
  // a pathological table should fail cleanly rather than hang.
  const timer = setTimeout(() => {
    if (!res.headersSent) res.status(504).json({ error: 'Rendering timed out' });
  }, RENDER_TIMEOUT_MS);

  try {
    const {
      md,
      filename = 'document.pdf',
      // Request-body settings are only defaults now: YAML front matter in the
      // document itself takes precedence, so a .md file carries its own layout.
      toc = false,
      pageNumbers = true,
      header = null
    } = req.body || {};
    if (typeof md !== 'string' || !md.trim()) {
      return res.status(400).json({ error: 'Body must include { md: string }' });
    }

    const { data: frontMatter } = parseFrontMatter(md);
    const settings = frontMatterToOptions(frontMatter, { toc, pageNumbers, header });
    const { options: pageOptions, warnings: pageWarnings } = frontMatterToPageOptions(frontMatter);

    // The document names itself; the request body is only a fallback.
    const outName = frontMatterToFilename(frontMatter, filename);

    // Images must be fetched before rendering, since the renderer is synchronous.
    const images = await loadImages(md);

    // bufferPages lets stampPages go back and number every page once the total is known.
    const doc = new PDFDocument({ ...pageOptions, bufferPages: true });

    // Collect into memory rather than piping straight to the response: the
    // warning header is only known once rendering is done, and a mid-render
    // failure can still be answered with JSON instead of a truncated PDF.
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const finished = new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
    });

    applyDocumentInfo(doc, settings);

    const renderOpts = { images, ...settings.styles };
    const { warnings } = settings.toc
      ? renderMarkdownWithTOC(doc, md, {
          ...renderOpts,
          toc: typeof settings.toc === 'object' ? settings.toc : {}
        })
      : renderMarkdownStyled(doc, md, renderOpts);

    if (settings.header || settings.footer) {
      stampPages(doc, {
        header: settings.header,
        footer: settings.footer,
        skipFirst: Boolean(settings.toc)
      });
    }

    doc.end();
    await finished;
    const pdf = Buffer.concat(chunks);

    const allWarnings = [...pageWarnings, ...warnings];
    if (allWarnings.length) {
      console.warn('md2pdf:', allWarnings.join('; '));
      // surfaced to the UI so a bad image or page size is visible, not silent
      res.setHeader('X-Pdf-Warnings', Buffer.from(JSON.stringify(allWarnings), 'utf8').toString('base64'));
    }

    if (res.headersSent) return;          // the timeout already answered

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);

  } catch (err) {
    console.error(err);
    // The PDF is buffered, so a failure can still be reported as JSON.
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
    else res.end();
  } finally {
    clearTimeout(timer);
  }
});

// In a container the built editor sits next to this file and is served from the
// same origin, so the browser calls /api/generatePDF with no CORS involved.
// In development Vite serves the app instead and proxies /api here.
const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  console.log(`serving the editor from ${staticDir}`);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`PDF server listening on http://localhost:${PORT}`));