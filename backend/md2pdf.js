// npm i pdfkit marked
import PDFDocument from 'pdfkit';
import { marked } from 'marked';
import fs from 'fs';
marked.setOptions({ gfm: true, breaks: false });
/* ---------------- inline renderer (keeps styling) ---------------- */

function drawInlineTokens(doc, tokens, x, y, width, {
  font = 'Helvetica',
  fontBold = 'Helvetica-Bold',
  fontItalic = 'Helvetica-Oblique',
  fontBoldItalic = 'Helvetica-BoldOblique',
  codeFont = 'Courier',
  fontSize = 11,
  textColor = 'black',
  linkColor = '#1155cc',
  underlineLinks = true,
  align = 'left'
} = {}) {
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const wrapWidth = Number.isFinite(width) && width > 0 ? width : pageWidth;

  // 1) Flatten tokens to styled chunks
  const chunks = [];
  const push = (text, style = 'normal', extras = {}) => {
    if (!text) return;
    chunks.push({ text, style, extras });
  };
  const walk = (toks, style = 'normal') => {
    for (const t of toks || []) {
      if (t.type === 'text') {
        push(t.text, style);
        if (t.tokens) walk(t.tokens, style);
      } else if (t.type === 'strong') {
        const st = style === 'italic' ? 'bolditalic' : 'bold';
        t.tokens ? walk(t.tokens, st) : push(t.text || t.raw, st);
      } else if (t.type === 'em') {
        const st = style === 'bold' ? 'bolditalic' : 'italic';
        t.tokens ? walk(t.tokens, st) : push(t.text || t.raw, st);
      } else if (t.type === 'codespan') {
        push(t.text || t.raw, 'code');
      } else if (t.type === 'link') {
        const label = (t.tokens?.map(s => s.text).join('')) || t.text || t.href || '';
        push(label, style, { link: t.href, underline: underlineLinks, color: linkColor });
      } else if (t.type === 'br' || t.type === 'space') {
        push('\n', style);
      } else if (t.tokens) {
        walk(t.tokens, style);
      } else if (t.raw) {
        push(t.raw, style);
      }
    }
  };
  walk(tokens);

  // 2) Render chunks with proper wrapping
  const base = { width: wrapWidth, align, lineBreak: true };
  chunks.forEach((c, i) => {
    if (c.style === 'bold') doc.font(fontBold);
    else if (c.style === 'italic') doc.font(fontItalic);
    else if (c.style === 'bolditalic') doc.font(fontBoldItalic);
    else if (c.style === 'code') doc.font(codeFont);
    else doc.font(font);

    const color = c.extras?.color || textColor;
    doc.fillColor(color).fontSize(fontSize);

    const opts = { ...base, continued: i < chunks.length - 1, ...(c.extras || {}) };

    if (i === 0) doc.text(c.text, x, y, opts);
    else doc.text(c.text, opts);
  });

  // 3) After the last chunk, pdfkit already set continued=false → next block starts on a new line
  return { x: doc.x, y: doc.y };
}

/* ---------------- helpers for measuring & layout ---------------- */

function tokensToPlain(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'text' || t.type === 'codespan') out += t.text || t.raw || '';
    else if (t.type === 'link') out += (t.text || t.href || '');
    if (t.tokens) out += tokensToPlain(t.tokens);
  }
  return out;
}

function heightOfTokens(doc, tokens, width, fontName, fontSize) {
  const prevFont = doc._font && doc._font.name;
  const prevSize = doc._fontSize;
  if (fontName) doc.font(fontName);
  if (fontSize) doc.fontSize(fontSize);
  const h = doc.heightOfString(tokensToPlain(tokens), { width: Math.max(0, width) });
  if (prevFont) doc.font(prevFont);
  if (prevSize) doc.fontSize(prevSize);
  return Math.max(h, doc.currentLineHeight());
}

function ensureSpace(doc, y, heightNeeded) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (y + heightNeeded > bottom) {
    doc.addPage();
    return doc.y || doc.page.margins.top;
  }
  return y;
}

/* ---------------- table renderer (styled) ---------------- */

function cellToInlineTokens(cell) {
  if (cell == null) return [];
  if (Array.isArray(cell)) return cell;
  if (typeof cell === 'object') {
    if (Array.isArray(cell.tokens)) return cell.tokens;
    return [{ type: 'text', text: String(cell.text ?? cell.raw ?? '') }];
  }
  // String cell: parse inline using marked
  return marked.lexer(String(cell)).filter(t => t.type === 'paragraph')[0]?.tokens
    || [{ type: 'text', text: String(cell) }];
}

function styledCellHeight(doc, tokens, width, fontName, fontSize, paddingV) {
  const h = heightOfTokens(doc, tokens, width, fontName, fontSize);
  return Math.max(h, doc.currentLineHeight()) + 2 * paddingV;
}

function renderMarkedTableStyled(doc, tableToken, userOpts = {}) {
  const opts = {
    x: doc.x || doc.page.margins.left,
    y: doc.y || doc.page.margins.top,
    maxWidth: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    paddingH: 6,
    paddingV: 6,
    headerFont: 'Helvetica-Bold',
    bodyFont: 'Helvetica',
    boldFont: 'Helvetica-Bold',
    italicFont: 'Helvetica-Oblique',
    boldItalicFont: 'Helvetica-BoldOblique',
    codeFont: 'Courier',
    fontSize: 10,
    headerFill: '#eeeeee',
    zebraFill: null,
    borderColor: '#aaaaaa',
    borderWidth: 0.5,
    headerTextColor: 'black',
    bodyTextColor: 'black',
    headerAlignDefault: 'left',
    cellMinWidth: 30,
    cellMaxWidth: 260,
    rowGap: 0,
    linkColor: '#1155cc',
    underlineLinks: true,
    ...userOpts
  };

  const aligns = tableToken.align || [];
  const headersToks = (tableToken.header || []).map(cellToInlineTokens);
  const rowsToks = (tableToken.rows || []).map(r => r.map(cellToInlineTokens));
  const colCount = headersToks.length;
  if (!colCount) return { width: 0, height: 0, x: opts.x, y: opts.y };

  // estimate column widths from plain text
  const widthOfPlain = (tokens, fontName) => {
    const prevFont = doc._font && doc._font.name;
    const prevSize = doc._fontSize;
    doc.font(fontName).fontSize(opts.fontSize);
    const w = doc.widthOfString(tokensToPlain(tokens));
    if (prevFont) doc.font(prevFont);
    if (prevSize) doc.fontSize(prevSize);
    return w;
  };

  const colWidths = new Array(colCount).fill(opts.cellMinWidth);

  for (let c = 0; c < colCount; c++) {
    const w = widthOfPlain(headersToks[c], opts.headerFont) + 2 * opts.paddingH;
    colWidths[c] = Math.max(colWidths[c], Math.min(opts.cellMaxWidth, w));
  }
  for (const row of rowsToks) {
    for (let c = 0; c < colCount; c++) {
      const w = widthOfPlain(row[c] || [], opts.bodyFont) + 2 * opts.paddingH;
      colWidths[c] = Math.max(colWidths[c], Math.min(opts.cellMaxWidth, w));
    }
  }
  for (let c = 0; c < colCount; c++) {
    colWidths[c] = Math.max(opts.cellMinWidth, Math.min(opts.cellMaxWidth, colWidths[c]));
  }

  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  if (totalWidth > opts.maxWidth) {
    const scale = opts.maxWidth / totalWidth;
    for (let i = 0; i < colCount; i++) {
      colWidths[i] = Math.max(opts.cellMinWidth, Math.floor(colWidths[i] * scale));
    }
  }
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);

  let y = opts.y;

  const drawRow = (cellsTokens, isHeader = false, rowIndex = 0) => {
    const heights = cellsTokens.map((toks, i) =>
      styledCellHeight(
        doc,
        toks || [],
        Math.max(0, colWidths[i] - 2 * opts.paddingH),
        isHeader ? opts.headerFont : opts.bodyFont,
        opts.fontSize,
        opts.paddingV
      )
    );
    const rowHeight = Math.ceil(Math.max(...heights));
    y = ensureSpace(doc, y, rowHeight);

    // background
    if (isHeader) {
      doc.save().rect(opts.x, y, tableWidth, rowHeight).fill(opts.headerFill).restore();
    } else if (opts.zebraFill && rowIndex % 2 === 1) {
      doc.save().rect(opts.x, y, tableWidth, rowHeight).fill(opts.zebraFill).restore();
    }

    // borders
    if (opts.borderWidth > 0) {
      doc.save().lineWidth(opts.borderWidth).strokeColor(opts.borderColor);
      doc.rect(opts.x, y, tableWidth, rowHeight).stroke();
      let cx = opts.x;
      for (let i = 0; i < colCount - 1; i++) {
        cx += colWidths[i];
        doc.moveTo(cx, y).lineTo(cx, y + rowHeight).stroke();
      }
      doc.restore();
    }

    // text
    let cx = opts.x;
    for (let i = 0; i < colCount; i++) {
      const innerX = cx + opts.paddingH;
      const innerY = y + opts.paddingV;
      const innerW = Math.max(0, colWidths[i] - 2 * opts.paddingH);
      const mdAlign = aligns[i];
      const pdfAlign = (mdAlign === 'center' || mdAlign === 'right' || mdAlign === 'left')
        ? mdAlign
        : (isHeader ? opts.headerAlignDefault : 'left');

      drawInlineTokens(doc, cellsTokens[i] || [], innerX, innerY, innerW, {
        font: isHeader ? opts.headerFont : opts.bodyFont,
        fontBold: opts.boldFont,
        fontItalic: opts.italicFont,
        fontBoldItalic: opts.boldItalicFont,
        codeFont: opts.codeFont,
        fontSize: opts.fontSize,
        textColor: isHeader ? opts.headerTextColor : opts.bodyTextColor,
        linkColor: opts.linkColor,
        underlineLinks: opts.underlineLinks,
        align: pdfAlign
      });

      cx += colWidths[i];
    }

    y += rowHeight + (userOpts.rowGap || 0);
  };

  // header + body
  drawRow(headersToks, true);
  rowsToks.forEach((r, idx) => drawRow(r, false, idx));

  return { x: opts.x, y, width: tableWidth, height: y - opts.y };
}

/* ---------------- block renderers (headings, paragraphs, code) ---------------- */

function renderHeading(doc, token, cursor, opts) {
  const {
    maxWidth, color = 'black',
    hFonts = ['Helvetica-Bold', 'Helvetica-Bold', 'Helvetica-Bold', 'Helvetica-Bold', 'Helvetica-Bold', 'Helvetica-Bold'],
    hSizes = [22, 18, 16, 14, 13, 12],
    spacingTop = [8, 8, 6, 6, 4, 4],
    spacingBottom = [6, 6, 4, 4, 3, 3]
  } = opts;

  const level = Math.min(Math.max(token.depth || token.level || 1, 1), 6);
  const textTokens = token.tokens || [{ type: 'text', text: token.text || '' }];

  const fontName = hFonts[level - 1];
  const fontSize = hSizes[level - 1];
  const top = spacingTop[level - 1];
  const bottom = spacingBottom[level - 1];

  // measure
  const h = heightOfTokens(doc, textTokens, maxWidth, fontName, fontSize);

  cursor.y += top;
  cursor.y = ensureSpace(doc, cursor.y, h);
  drawInlineTokens(doc, textTokens, cursor.x, cursor.y, maxWidth, {
    font: fontName, fontBold: fontName, fontItalic: 'Helvetica-Oblique',
    fontBoldItalic: 'Helvetica-BoldOblique',
    codeFont: 'Courier', fontSize, textColor: color, align: 'left'
  });
  cursor.y = doc.y + bottom;
}

function renderParagraph(doc, token, cursor, opts) {
  const { maxWidth, font = 'Helvetica', fontSize = 11, color = 'black', gap = 6 } = opts;
  const tokens = token.tokens || [{ type: 'text', text: token.text || '' }];
  const h = heightOfTokens(doc, tokens, maxWidth, font, fontSize);
  cursor.y = ensureSpace(doc, cursor.y, h);
  drawInlineTokens(doc, tokens, cursor.x, cursor.y, maxWidth, {
    font, fontBold: 'Helvetica-Bold', fontItalic: 'Helvetica-Oblique',
    fontBoldItalic: 'Helvetica-BoldOblique',
    codeFont: 'Courier', fontSize, textColor: color, align: 'left'
  });
  cursor.y = doc.y + gap;
}

function renderCodeBlock(doc, token, cursor, opts) {
  const {
    maxWidth, codeFont = 'Courier', fontSize = 10,
    bg = '#f4f4f4', border = '#dddddd', padding = 8, round = 4, gap = 8
  } = opts;

  const codeText = token.text || '';
  // pre-measure
  const prevFont = doc._font && doc._font.name;
  const prevSize = doc._fontSize;
  doc.font(codeFont).fontSize(fontSize);
  const textH = doc.heightOfString(codeText, { width: maxWidth - 2 * padding });
  if (prevFont) doc.font(prevFont);
  if (prevSize) doc.fontSize(prevSize);

  const boxH = Math.max(textH, doc.currentLineHeight()) + 2 * padding;
  cursor.y = ensureSpace(doc, cursor.y, boxH);

  // background + border
  doc.save().roundedRect(cursor.x, cursor.y, maxWidth, boxH, round).fill(bg).restore();
  doc.save().roundedRect(cursor.x, cursor.y, maxWidth, boxH, round).lineWidth(0.5).stroke(border).restore();

  // text
  doc.font(codeFont).fontSize(fontSize).fillColor('black')
     .text(codeText, cursor.x + padding, cursor.y + padding, { width: maxWidth - 2 * padding });

  cursor.y += boxH + gap;
}

/* ---------------- master renderer ---------------- */

export function renderMarkdownStyled(doc, markdownString, userOpts = {}) {
  const maxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cursor = { x: doc.page.margins.left, y: doc.page.margins.top };
  const tokens = marked.lexer(markdownString);

  const ensureSpace = (h) => {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (cursor.y + h > bottom) { doc.addPage(); cursor.y = doc.page.margins.top; }
  };

  const heightOfTokens = (toks, fontName, fontSize) => {
    const prevFont = doc._font && doc._font.name, prevSize = doc._fontSize;
    if (fontName) doc.font(fontName); if (fontSize) doc.fontSize(fontSize);
    const text = (toks || []).map(t => t.text || '').join('');
    const h = doc.heightOfString(text, { width: maxWidth });
    if (prevFont) doc.font(prevFont); if (prevSize) doc.fontSize(prevSize);
    return Math.max(h, doc.currentLineHeight());
  };

  for (const t of tokens) {
    if (t.type === 'heading') {
      const font = 'Helvetica-Bold', size = [22,18,16,14,13,12][Math.max(1, Math.min(6, t.depth)) - 1];
      const h = heightOfTokens(t.tokens || [{text:t.text}], font, size) + 6;
      ensureSpace(h);
      drawInlineTokens(doc, t.tokens || [{type:'text', text:t.text}], cursor.x, cursor.y, maxWidth,
        { font: font, fontBold: font, fontItalic: 'Helvetica-Oblique', fontBoldItalic: 'Helvetica-BoldOblique', fontSize: size });
      cursor.y = doc.y + 6;
      continue;
    }

    if (t.type === 'paragraph') {
      const h = heightOfTokens(t.tokens || [{text:t.text}], 'Helvetica', 11) + 6;
      ensureSpace(h);
      drawInlineTokens(doc, t.tokens || [{type:'text', text:t.text}], cursor.x, cursor.y, maxWidth,
        { font: 'Helvetica', fontBold: 'Helvetica-Bold', fontItalic: 'Helvetica-Oblique', fontBoldItalic: 'Helvetica-BoldOblique', codeFont: 'Courier', fontSize: 11 });
      cursor.y = doc.y + 6;
      continue;
    }

    if (t.type === 'code') {
      const pad = 8, size = 10, codeFont = 'Courier';
      const prevFont = doc._font && doc._font.name, prevSize = doc._fontSize;
      doc.font(codeFont).fontSize(size);
      const textH = doc.heightOfString(t.text || '', { width: maxWidth - 2 * pad });
      if (prevFont) doc.font(prevFont); if (prevSize) doc.fontSize(prevSize);
      const boxH = Math.max(textH, doc.currentLineHeight()) + 2 * pad;
      ensureSpace(boxH);
      doc.save().roundedRect(cursor.x, cursor.y, maxWidth, boxH, 4).fill('#f6f8fa').restore();
      doc.save().roundedRect(cursor.x, cursor.y, maxWidth, boxH, 4).lineWidth(0.5).stroke('#e1e4e8').restore();
      doc.font(codeFont).fontSize(size).fillColor('black')
         .text(t.text || '', cursor.x + pad, cursor.y + pad, { width: maxWidth - 2 * pad });
      cursor.y += boxH + 8;
      continue;
    }

    if (t.type === 'table') {
      const { y } = renderMarkedTableStyled(doc, t, {
        x: cursor.x, y: cursor.y, maxWidth,
        zebraFill: '#fbfbfb',
        fontSize: 10
      });
      cursor.y = y + 8;
      continue;
    }
  }

  return cursor;
}


/* ---------------- DEMO ---------------- */

const demoMD = `
# Title H1

A paragraph with **bold**, *italic*, ***both***, \`inline code\`, and a [link](https://example.com).

## Subheading H2

\`\`\`js
function hello(name) {



  console.log('Hello, ' + name);


}


hello('world');
\`\`\`

# Another H1 title

## Another subheading h2

| Product | Details             | Price |
|:-------:|:--------------------|------:|
| **Apple** | Crisp *green* \`one\` |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
`;

const doc = new PDFDocument({ margin: 50 });
doc.pipe(fs.createWriteStream('markdown-styled.pdf'));

renderMarkdownStyled(doc, demoMD, {
  paragraph: { font: 'Helvetica', fontSize: 11, color: '#111', gap: 10 },
  heading:   { color: '#111' },
  codeblock: { codeFont: 'Courier', fontSize: 10, bg: '#f6f8fa', border: '#e1e4e8', padding: 10, round: 4, gap: 10 },
  table:     { zebraFill: '#fbfbfb', fontSize: 10 }
});

doc.end();
