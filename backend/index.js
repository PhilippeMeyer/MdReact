import express from 'express';
import cors from 'cors';
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
app.use(cors({ origin: true, exposedHeaders: ['Content-Disposition', 'X-Pdf-Warnings'] }));                     
app.use(express.json({ limit: '2mb' })); 

app.post('/api/generatePDF', async (req, res) => {
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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);

  } catch (err) {
    console.error(err);
    // If headers already sent, cannot send JSON—just end.
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
    else res.end();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`PDF server listening on http://localhost:${PORT}`));