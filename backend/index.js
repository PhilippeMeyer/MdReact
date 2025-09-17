import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';

import { renderMarkdownStyled } from './md2pdf.js';

const app = express();
app.use(cors({ origin: true }));                     
app.use(express.json({ limit: '2mb' })); 

app.post('/api/generatePDF', async (req, res) => {
  try {
    const { md, filename = 'document.pdf' } = req.body || {};
    if (typeof md !== 'string' || !md.trim()) {
      return res.status(400).json({ error: 'Body must include { md: string }' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);

    const doc = new PDFDocument({ margin: 50 });
    doc.pipe(res);

    renderMarkdownStyled(doc, md);
    doc.end(); // stream closes the response

  } catch (err) {
    console.error(err);
    // If headers already sent, cannot send JSON—just end.
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
    else res.end();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`PDF server listening on http://localhost:${PORT}`));