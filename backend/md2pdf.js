// npm i pdfkit marked
import PDFDocument from 'pdfkit';
import { marked } from 'marked';
import fs from 'fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { parse as parseYAML } from 'yaml';
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
        if (t.tokens && t.tokens.length) walk(t.tokens, style);
        else push(t.text, style);
      } else if (t.type === 'image') {
        push(t.text ? `[${t.text}]` : '', style);
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
    repeatHeader: true,
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

  function drawRow(cellsTokens, isHeader = false, rowIndex = 0) {
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

    const afterBreak = ensureSpace(doc, y, rowHeight);
    const brokePage = afterBreak !== y;
    y = afterBreak;
    // A table continuing on a new page repeats its header, so the columns stay readable.
    if (brokePage && !isHeader && opts.repeatHeader) drawRow(headersToks, true, -1);

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
  }

  // header + body
  drawRow(headersToks, true);
  rowsToks.forEach((r, idx) => drawRow(r, false, idx));

  return { x: opts.x, y, width: tableWidth, height: y - opts.y };
}

/* ---------------- block renderers (headings, paragraphs, code) ---------------- */

/* The 14 standard PDF fonts come in families; pick the matching faces so that
   **bold** inside a Times paragraph is Times-Bold, not Helvetica-Bold. */
const FONT_FAMILIES = {
  'Helvetica':   { bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique' },
  'Times-Roman': { bold: 'Times-Bold',     italic: 'Times-Italic',      boldItalic: 'Times-BoldItalic' },
  'Courier':     { bold: 'Courier-Bold',   italic: 'Courier-Oblique',   boldItalic: 'Courier-BoldOblique' }
};

function familyOf(font) {
  if (FONT_FAMILIES[font]) return FONT_FAMILIES[font];
  const base = String(font || '').split('-')[0];
  if (base === 'Times') return FONT_FAMILIES['Times-Roman'];
  return FONT_FAMILIES[base] || FONT_FAMILIES['Helvetica'];
}

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
  const family = familyOf(fontName);
  drawInlineTokens(doc, textTokens, cursor.x, cursor.y, maxWidth, {
    font: fontName, fontBold: fontName,
    fontItalic: family.italic, fontBoldItalic: family.boldItalic,
    codeFont: opts.codeFont || 'Courier', fontSize, textColor: color, align: 'left'
  });
  cursor.y = doc.y + bottom;
}

function renderParagraph(doc, token, cursor, opts) {
  const { maxWidth, font = 'Helvetica', fontSize = 11, color = 'black', gap = 6, codeFont = 'Courier' } = opts;
  const family = familyOf(font);
  const tokens = token.tokens || [{ type: 'text', text: token.text || '' }];
  const h = heightOfTokens(doc, tokens, maxWidth, font, fontSize);
  cursor.y = ensureSpace(doc, cursor.y, h);
  drawInlineTokens(doc, tokens, cursor.x, cursor.y, maxWidth, {
    font,
    fontBold: opts.fontBold || family.bold,
    fontItalic: opts.fontItalic || family.italic,
    fontBoldItalic: opts.fontBoldItalic || family.boldItalic,
    codeFont, fontSize, textColor: color, align: 'left'
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

/* ---------------- horizontal rule ---------------- */

function renderHr(doc, cursor, opts) {
  const {
    maxWidth, color = '#d0d7de', thickness = 1, gapTop = 6, gapBottom = 10
  } = opts;
  cursor.y = ensureSpace(doc, cursor.y + gapTop, thickness + gapBottom);
  doc.save().lineWidth(thickness).strokeColor(color)
     .moveTo(cursor.x, cursor.y).lineTo(cursor.x + maxWidth, cursor.y)
     .stroke().restore();
  cursor.y += gapBottom;
}

/* ---------------- images ---------------- */

function drawImagePlaceholder(doc, token, cursor, opts, reason) {
  const {
    maxWidth, bg = '#f6f8fa', border = '#d0d7de',
    color = '#57606a', fontSize = 9, gap = 10
  } = opts;
  const alt = token.text || token.href || 'missing';
  const label = reason ? `[image: ${alt} \u2014 ${reason}]` : `[image: ${alt}]`;
  const boxW = Math.min(maxWidth, reason ? 420 : 260);
  const boxH = 34;
  cursor.y = ensureSpace(doc, cursor.y, boxH);
  doc.save().roundedRect(cursor.x, cursor.y, boxW, boxH, 4).fill(bg).restore();
  doc.save().roundedRect(cursor.x, cursor.y, boxW, boxH, 4)
     .lineWidth(0.5).dash(2, { space: 2 }).stroke(border).restore();
  doc.save().font('Helvetica-Oblique').fontSize(fontSize).fillColor(color)
     .text(label, cursor.x + 8, cursor.y + boxH / 2 - fontSize,
           { width: boxW - 16, height: boxH, ellipsis: true, lineBreak: false })
     .restore();
  cursor.y += boxH + gap;
}

function renderImage(doc, token, cursor, ctx) {
  const opts = { ...(ctx.styles.image || {}), maxWidth: ctx.width };
  const { maxWidth, gap = 10, maxHeightRatio = 0.85, align = 'left' } = opts;
  const entry = ctx.images && ctx.images.get(token.href);

  // loadImages stores a Buffer on success, or { error } explaining the failure.
  const giveUp = (reason) => {
    ctx.warnings.push(`image skipped (${reason}): ${token.href}`);
    drawImagePlaceholder(doc, token, cursor, opts, reason);
  };

  if (!Buffer.isBuffer(entry)) {
    giveUp(entry && entry.error ? entry.error : 'not loaded');
    return;
  }

  let img;
  try {
    img = doc.openImage(entry);
  } catch {
    giveUp('not a PNG or JPEG');
    return;
  }

  // Scale to fit the column, and never taller than most of a page.
  const pageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
  const scale = Math.min(1, maxWidth / img.width, (pageH * maxHeightRatio) / img.height);
  const w = img.width * scale;
  const h = img.height * scale;

  cursor.y = ensureSpace(doc, cursor.y, h);
  const x = align === 'center' ? cursor.x + (maxWidth - w) / 2 : cursor.x;
  doc.image(entry, x, cursor.y, { width: w, height: h });
  cursor.y += h + gap;
}

/* ---------------- prose (paragraphs, with images pulled out) ---------------- */

function renderProse(doc, token, cursor, ctx) {
  const toks = token.tokens || [{ type: 'text', text: token.text || '' }];

  // Images are block-level in a PDF, so split the run at every image.
  const segments = [];
  let buf = [];
  for (const t of toks) {
    if (t.type === 'image') {
      if (buf.length) { segments.push({ kind: 'text', toks: buf }); buf = []; }
      segments.push({ kind: 'image', token: t });
    } else {
      buf.push(t);
    }
  }
  if (buf.length) segments.push({ kind: 'text', toks: buf });

  for (const seg of segments) {
    if (seg.kind === 'image') {
      renderImage(doc, seg.token, cursor, ctx);
    } else if (tokensToPlain(seg.toks).trim()) {
      renderParagraph(doc, { tokens: seg.toks }, cursor,
        { ...(ctx.styles.paragraph || {}), maxWidth: ctx.width });
    }
  }
}

/* ---------------- lists ---------------- */

function drawCheckbox(doc, x, y, lineHeight, size, checked, opts) {
  const top = y + Math.max(0, (lineHeight - size) / 2);
  doc.save()
     .lineWidth(0.8).strokeColor(opts.checkboxColor || '#8c959f')
     .roundedRect(x, top, size, size, 2).stroke();
  if (checked) {
    doc.lineWidth(1.4).strokeColor(opts.checkColor || '#1a7f37')
       .moveTo(x + size * 0.22, top + size * 0.52)
       .lineTo(x + size * 0.42, top + size * 0.74)
       .lineTo(x + size * 0.80, top + size * 0.26)
       .stroke();
  }
  doc.restore();
}

function renderList(doc, token, cursor, ctx) {
  const S = ctx.styles.list || {};
  const P = ctx.styles.paragraph || {};
  const depth = ctx.listDepth || 0;
  const bullets = S.bullets || ['•', '·', '–'];
  const font = S.font || P.font || 'Helvetica';
  const fontSize = S.fontSize ?? P.fontSize ?? 11;
  const minIndent = S.indent ?? 18;
  const markerGap = S.markerGap ?? 6;
  const itemGap = S.itemGap ?? 2;
  const gapAfter = S.gap ?? 8;
  const markerColor = S.markerColor || P.color || 'black';

  const ordered = !!token.ordered;
  let n = ordered ? (parseInt(token.start, 10) || 1) : 0;

  // Tight lists get minimal spacing between item paragraphs; loose keep the normal gap.
  const childStyles = {
    ...ctx.styles,
    paragraph: { ...P, gap: token.loose ? (P.gap ?? 6) : 1 }
  };

  for (const item of token.items || []) {
    const isTask = !!item.task;
    const markerText = isTask ? null : (ordered ? `${n++}.` : bullets[Math.min(depth, bullets.length - 1)]);

    const prevFont = doc._font && doc._font.name;
    const prevSize = doc._fontSize;
    doc.font(font).fontSize(fontSize);
    const lineH = doc.currentLineHeight();
    const boxSize = Math.round(fontSize * 0.85);
    const markerW = Math.max(
      minIndent,
      (markerText ? doc.widthOfString(markerText) : boxSize) + markerGap
    );
    if (prevFont) doc.font(prevFont);
    if (prevSize) doc.fontSize(prevSize);

    cursor.y = ensureSpace(doc, cursor.y, lineH);
    const markerY = cursor.y;

    if (isTask) {
      drawCheckbox(doc, cursor.x, markerY, lineH, boxSize, item.checked, S);
    } else {
      doc.save().font(font).fontSize(fontSize).fillColor(markerColor)
         .text(markerText, cursor.x, markerY, { width: markerW, lineBreak: false })
         .restore();
    }

    const inner = { x: cursor.x + markerW, y: markerY };
    renderBlocks(doc, item.tokens || [], inner, {
      ...ctx,
      width: Math.max(0, ctx.width - markerW),
      styles: childStyles,
      listDepth: depth + 1
    });

    cursor.y = Math.max(inner.y, markerY + lineH) + itemGap;
  }

  if (depth === 0) cursor.y += gapAfter;
}

/* ---------------- blockquotes ---------------- */

function renderBlockquote(doc, token, cursor, ctx) {
  const S = ctx.styles.blockquote || {};
  const P = ctx.styles.paragraph || {};
  const barWidth = S.barWidth ?? 3;
  const pad = S.indent ?? 12;
  const gapAfter = S.gap ?? 8;
  const barColor = S.barColor || '#d0d7de';

  const innerX = cursor.x + barWidth + pad;
  const innerW = Math.max(0, ctx.width - barWidth - pad);
  const barX = cursor.x + barWidth / 2;

  const childStyles = {
    ...ctx.styles,
    paragraph: { ...P, color: S.color || '#57606a' }
  };

  const inner = { x: innerX, y: cursor.y };
  // The bar is drawn as one continuous stroke once the content height is known.
  // If the quote spills onto a new page, restart it at that page's top margin
  // (the part left behind on the previous page cannot be drawn after the fact
  // without PDFDocument({ bufferPages: true })).
  let barStart = inner.y;
  const onPageAdded = () => { barStart = doc.page.margins.top; };
  doc.on('pageAdded', onPageAdded);

  try {
    renderBlocks(doc, token.tokens || [], inner, {
      ...ctx, width: innerW, styles: childStyles, listDepth: 0
    });
  } finally {
    doc.removeListener('pageAdded', onPageAdded);
  }

  if (inner.y > barStart) {
    doc.save().lineWidth(barWidth).strokeColor(barColor)
       .moveTo(barX, barStart).lineTo(barX, inner.y).stroke().restore();
  }

  cursor.y = inner.y + gapAfter;
}

/* ---------------- headings: orphan control (#9) and bookmarks (#8) ---------------- */

const H_SIZES   = [22, 18, 16, 14, 13, 12];
const H_TOP     = [8, 8, 6, 6, 4, 4];

function headingLevel(token) {
  return Math.min(Math.max(token.depth || token.level || 1, 1), 6);
}

// Never leave a heading stranded at the foot of a page: if the heading plus the
// first couple of lines of whatever follows will not fit, start a page first.
function keepHeadingWithNext(doc, cursor, ctx, token, nextToken) {
  const S = ctx.styles.heading || {};
  const P = ctx.styles.paragraph || {};
  const level = headingLevel(token);
  const sizes = S.hSizes || H_SIZES;
  const tops = S.spacingTop || H_TOP;
  const fonts = S.hFonts;
  const font = (fonts && fonts[level - 1]) || 'Helvetica-Bold';

  const textTokens = token.tokens || [{ type: 'text', text: token.text || '' }];
  const headingH = heightOfTokens(doc, textTokens, ctx.width, font, sizes[level - 1]);

  let lead = 0;
  if (nextToken) {
    const prevFont = doc._font && doc._font.name;
    const prevSize = doc._fontSize;
    doc.font(P.font || 'Helvetica').fontSize(P.fontSize ?? 11);
    lead = doc.currentLineHeight() * 2;
    if (prevFont) doc.font(prevFont);
    if (prevSize) doc.fontSize(prevSize);
  }

  const needed = tops[level - 1] + headingH + lead;
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (cursor.y + needed > bottom) {
    doc.addPage();
    // renderHeading adds spacingTop itself, so land exactly on the top margin
    cursor.y = doc.page.margins.top - tops[level - 1];
  }
}

// PDF bookmarks, nested by heading level, pointing at the page the heading is on.
function addOutlineItem(ctx, token) {
  if (!ctx.outline) return;
  const level = headingLevel(token);
  const title = tokensToPlain(token.tokens || [{ type: 'text', text: token.text || '' }]).trim();
  if (!title) return;
  const stack = ctx.outline;
  const parent = stack[Math.min(level - 1, stack.length - 1)];
  if (!parent || typeof parent.addItem !== 'function') return;
  try {
    stack[level] = parent.addItem(title);
    stack.length = level + 1;
  } catch {
    // outline is a convenience; never let it break the render
  }
}

/* ---------------- block dispatcher ---------------- */

function renderBlocks(doc, tokens, cursor, ctx) {
  const list = tokens || [];
  const nextRenderable = (from) => {
    for (let j = from; j < list.length; j++) {
      if (list[j].type !== 'space' && list[j].type !== 'def') return list[j];
    }
    return null;
  };

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    switch (t.type) {
      case 'space':
      case 'def':
        break;

      case 'heading':
        if (ctx.styles.heading?.keepWithNext !== false) {
          keepHeadingWithNext(doc, cursor, ctx, t, nextRenderable(i + 1));
        }
        renderHeading(doc, t, cursor, { ...(ctx.styles.heading || {}), maxWidth: ctx.width });
        addOutlineItem(ctx, t);
        ctx.headings.push({
          level: headingLevel(t),
          text: tokensToPlain(t.tokens || [{ type: 'text', text: t.text || '' }]).trim(),
          page: ctx.page.n
        });
        break;

      case 'paragraph':
      case 'text':
        renderProse(doc, t, cursor, ctx);
        break;

      case 'code':
        renderCodeBlock(doc, t, cursor, { ...(ctx.styles.codeblock || {}), maxWidth: ctx.width });
        break;

      case 'table': {
        const { y } = renderMarkedTableStyled(doc, t, {
          zebraFill: '#fbfbfb',
          fontSize: 10,
          ...(ctx.styles.table || {}),
          x: cursor.x, y: cursor.y, maxWidth: ctx.width
        });
        cursor.y = y + (ctx.styles.table?.gap ?? 8);
        break;
      }

      case 'list':
        renderList(doc, t, cursor, ctx);
        break;

      case 'blockquote':
        renderBlockquote(doc, t, cursor, ctx);
        break;

      case 'hr':
        renderHr(doc, cursor, { ...(ctx.styles.hr || {}), maxWidth: ctx.width });
        break;

      case 'image':
        renderImage(doc, t, cursor, ctx);
        break;

      default: {
        // Nothing is dropped silently: fall back to the raw source as plain text.
        const raw = (t.raw || t.text || '').trim();
        ctx.warnings.push(`unsupported token rendered as plain text: ${t.type}`);
        if (raw) {
          renderParagraph(doc, { tokens: [{ type: 'text', text: raw }] }, cursor,
            { ...(ctx.styles.paragraph || {}), maxWidth: ctx.width });
        }
        break;
      }
    }
  }
}

/* ---------------- image prefetch ---------------- */

function collectImageSrcs(tokens, out = new Set()) {
  for (const t of tokens || []) {
    if (t.type === 'image' && t.href) out.add(t.href);
    if (t.tokens) collectImageSrcs(t.tokens, out);
    if (t.items) collectImageSrcs(t.items, out);
    if (Array.isArray(t.rows)) for (const row of t.rows) collectImageSrcs(row, out);
    if (Array.isArray(t.header)) collectImageSrcs(t.header, out);
  }
  return out;
}

// Refuse loopback / link-local / RFC1918 hosts so user markdown cannot make the
// server fetch things only the server can reach.
function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || a === 0 ||
         (a === 192 && b === 168) ||
         (a === 169 && b === 254) ||
         (a === 172 && b >= 16 && b <= 31);
}

/**
 * Resolve every image referenced by `markdownString` to a Buffer, so that
 * renderMarkdownStyled can stay synchronous.
 *
 *   const images = await loadImages(md);
 *   renderMarkdownStyled(doc, md, { images });
 *
 * Anything that fails to load is simply absent from the Map; the renderer then
 * draws a labelled placeholder instead of throwing.
 */
export async function loadImages(markdownString, {
  allowRemote = true,
  allowPrivateHosts = false,
  baseDir = null,          // opt-in: local files are only read when this is set
  maxBytes = 5 * 1024 * 1024,
  timeoutMs = 5000
} = {}) {
  const srcs = collectImageSrcs(marked.lexer(markdownString || ''));
  const images = new Map();
  // A Buffer means the image is usable; { error } records why it is not, so the
  // renderer can say so in the PDF instead of leaving a mute placeholder.
  const fail = (src, reason) => images.set(src, { error: reason });
  const tooBig = `larger than ${Math.round(maxBytes / 1024)} KB`;

  await Promise.all([...srcs].map(async (src) => {
    try {
      if (/^data:/i.test(src)) {
        const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/is);
        if (!m) return fail(src, 'malformed data URI');
        const buf = m[2]
          ? Buffer.from(m[3], 'base64')
          : Buffer.from(decodeURIComponent(m[3]), 'binary');
        return buf.length <= maxBytes ? images.set(src, buf) : fail(src, tooBig);
      }

      if (/^https?:/i.test(src)) {
        if (!allowRemote) return fail(src, 'remote images disabled');
        const url = new URL(src);
        if (!allowPrivateHosts && isPrivateHost(url.hostname)) return fail(src, 'private host blocked');

        const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        if (!resp.ok) return fail(src, `HTTP ${resp.status}`);

        // A link to a web page (a Google Images result, a Wikipedia article) is
        // the common mistake: it answers 200 with HTML, which is not an image.
        const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (ct && !ct.startsWith('image/')) {
          return fail(src, `URL returns ${ct}, not an image \u2014 link directly to the image file`);
        }
        if (ct && !/^image\/(png|jpeg|jpg)$/.test(ct)) {
          return fail(src, `${ct} is not supported \u2014 a PDF can embed PNG or JPEG`);
        }

        const len = Number(resp.headers.get('content-length'));
        if (Number.isFinite(len) && len > maxBytes) return fail(src, tooBig);
        const buf = Buffer.from(await resp.arrayBuffer());
        return buf.length <= maxBytes ? images.set(src, buf) : fail(src, tooBig);
      }

      if (!baseDir) return fail(src, 'local paths need the baseDir option');

      const full = path.resolve(baseDir, src);
      const root = path.resolve(baseDir);
      if (full !== root && !full.startsWith(root + path.sep)) return fail(src, 'path outside baseDir');
      const buf = await fs.promises.readFile(full);
      return buf.length <= maxBytes ? images.set(src, buf) : fail(src, tooBig);
    } catch (err) {
      fail(src, err.name === 'TimeoutError' ? `no response in ${timeoutMs} ms` : (err.message || 'could not be loaded'));
    }
  }));

  return images;
}

/* ---------------- YAML front matter ---------------- */

// A document opens with front matter when its very first line is exactly "---",
// closed by a later line of "---" (or "..."). Anything else is ordinary markdown.
const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Split YAML front matter off a markdown string.
 * Returns { data, body }; `data` is {} when there is no front matter, and the
 * body is always returned unchanged so it can be lexed on its own - leaving the
 * "---" fences in would otherwise be read as a rule and a setext heading.
 */
export function parseFrontMatter(markdownString = '') {
  const m = FRONT_MATTER_RE.exec(markdownString);
  if (!m) return { data: {}, body: markdownString, raw: null };
  let data = {};
  try {
    const parsed = parseYAML(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    // malformed YAML: treat the document as having no front matter
    return { data: {}, body: markdownString, raw: m[1], error: 'front matter is not valid YAML' };
  }
  return { data, body: markdownString.slice(m[0].length), raw: m[1] };
}

const TRUTHY = new Set(['true', 'yes', 'on', '1']);
const FALSY = new Set(['false', 'no', 'off', '0', '']);

function asBool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (TRUTHY.has(t)) return true;
  if (FALSY.has(t)) return false;
  return fallback;
}

// Placeholders usable in header/footer strings.
function expand(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    (key in vars && vars[key] !== undefined && vars[key] !== null) ? String(vars[key]) : whole);
}

// Named style presets, so a document can restyle itself without spelling out
// every option. pdfkit ships Helvetica, Times, and Courier families.
export const THEMES = {
  default: {},
  serif: {
    paragraph: { font: 'Times-Roman', fontSize: 11.5 },
    heading: {
      hFonts: ['Times-Bold', 'Times-Bold', 'Times-Bold', 'Times-Bold', 'Times-Bold', 'Times-Bold']
    },
    table: { headerFont: 'Times-Bold', bodyFont: 'Times-Roman', boldFont: 'Times-Bold', italicFont: 'Times-Italic', boldItalicFont: 'Times-BoldItalic' }
  },
  compact: {
    paragraph: { fontSize: 9.5, gap: 4 },
    heading: { hSizes: [17, 14, 12.5, 11, 10, 9.5], spacingTop: [6, 6, 4, 4, 3, 3], spacingBottom: [4, 4, 3, 3, 2, 2] },
    codeblock: { fontSize: 8.5, padding: 6, gap: 6 },
    table: { fontSize: 8.5, paddingH: 4, paddingV: 4 },
    list: { itemGap: 1, gap: 5 }
  },
  wide: {
    paragraph: { fontSize: 12, gap: 8 },
    heading: { hSizes: [26, 21, 18, 16, 14, 13] },
    list: { indent: 22, itemGap: 3 }
  }
};

function mergeStyles(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [block, values] of Object.entries(layer)) {
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        out[block] = { ...(out[block] || {}), ...values };
      }
    }
  }
  return out;
}

/**
 * Turn front-matter keys into the options the renderer and stampPages expect.
 *
 *   ---
 *   title: Quarterly report
 *   author: A. Person
 *   date: 2026-09-18
 *   toc: true                  # or a map: { title: Sommaire, maxLevel: 2 }
 *   pageNumbers: true
 *   header: "{title}"
 *   footer: "{page} / {total}"
 *   ---
 *
 * `defaults` supplies values for keys the document does not set.
 */
export function frontMatterToOptions(data = {}, defaults = {}) {
  const pick = (...names) => {
    for (const n of names) if (data[n] !== undefined) return data[n];
    return undefined;
  };

  const title = pick('title');
  const author = pick('author');
  const rawDate = pick('date');
  const date = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : rawDate;

  const tocRaw = pick('toc', 'contents', 'table-of-contents');
  let toc = false;
  if (tocRaw && typeof tocRaw === 'object' && !Array.isArray(tocRaw)) toc = tocRaw;
  else toc = asBool(tocRaw, Boolean(defaults.toc));

  const pageNumbers = asBool(pick('pageNumbers', 'page-numbers', 'pagenumbers'),
                             defaults.pageNumbers !== undefined ? defaults.pageNumbers : true);

  const rawTheme = pick('theme', 'style');
  const themeName = rawTheme && THEMES[String(rawTheme).trim().toLowerCase()] ? String(rawTheme).trim().toLowerCase() : 'default';
  const themeStyles = THEMES[themeName];

  const headerRaw = pick('header');
  const footerRaw = pick('footer');
  const vars = { title, author, date };

  const makeText = (raw, fallback) => {
    if (raw === undefined) return fallback;
    if (raw === false || raw === null) return null;
    return (n, total) => expand(raw, { ...vars, page: n, total });
  };

  return {
    title, author, date,
    toc,
    pageNumbers,
    header: makeText(headerRaw, defaults.header ?? null),
    footer: makeText(footerRaw, pageNumbers ? ((n, total) => `${n} / ${total}`) : null),
    theme: themeName,
    // a named theme first, then any per-block overrides from the document
    styles: mergeStyles(themeStyles, {
      ...(typeof pick('paragraph') === 'object' ? { paragraph: pick('paragraph') } : {}),
      ...(typeof pick('heading') === 'object' ? { heading: pick('heading') } : {}),
      ...(typeof pick('codeblock') === 'object' ? { codeblock: pick('codeblock') } : {}),
      ...(typeof pick('table') === 'object' ? { table: pick('table') } : {}),
      ...(typeof pick('list') === 'object' ? { list: pick('list') } : {}),
      ...(typeof pick('blockquote') === 'object' ? { blockquote: pick('blockquote') } : {})
    })
  };
}

// Paper sizes pdfkit knows by name; anything else may be given as [width, height] in points.
const PAGE_SIZES = new Set([
  'A0','A1','A2','A3','A4','A5','A6','A7','A8','A9','A10',
  'B0','B1','B2','B3','B4','B5','B6','B7','B8','B9','B10',
  'C0','C1','C2','C3','C4','C5','C6','C7','C8','C9','C10',
  'RA0','RA1','RA2','RA3','RA4','SRA0','SRA1','SRA2','SRA3','SRA4',
  'EXECUTIVE','FOLIO','LEGAL','LETTER','TABLOID','ID1','ID2','ID3'
]);

/**
 * Page setup from front matter -> the options object PDFDocument expects.
 *
 *   pageSize: A4                 # or paper:/size:; or [595, 842]
 *   orientation: landscape       # or landscape: true
 *   margin: 50                   # or margins: { top: 60, bottom: 60, left: 50, right: 50 }
 */
export function frontMatterToPageOptions(data = {}, defaults = { margin: 50 }) {
  const pick = (...names) => {
    for (const n of names) if (data[n] !== undefined) return data[n];
    return undefined;
  };
  const options = { ...defaults };
  const warnings = [];

  const rawSize = pick('pageSize', 'page-size', 'paper', 'size');
  if (rawSize !== undefined) {
    if (Array.isArray(rawSize) && rawSize.length === 2 && rawSize.every(n => Number.isFinite(Number(n)))) {
      options.size = [Number(rawSize[0]), Number(rawSize[1])];
    } else {
      const name = String(rawSize).trim().toUpperCase();
      if (PAGE_SIZES.has(name)) options.size = name;
      else warnings.push(`unknown pageSize "${rawSize}" - keeping the default`);
    }
  }

  const rawOrientation = pick('orientation', 'layout');
  const landscapeFlag = pick('landscape');
  let layout;
  if (rawOrientation !== undefined) {
    const o = String(rawOrientation).trim().toLowerCase();
    if (o === 'landscape' || o === 'portrait') layout = o;
    else warnings.push(`unknown orientation "${rawOrientation}" - keeping portrait`);
  }
  if (layout === undefined && landscapeFlag !== undefined) {
    layout = asBool(landscapeFlag, false) ? 'landscape' : 'portrait';
  }
  if (layout) options.layout = layout;

  const rawMargins = pick('margins');
  const rawMargin = pick('margin');
  if (rawMargins && typeof rawMargins === 'object' && !Array.isArray(rawMargins)) {
    const base = Number.isFinite(Number(rawMargin)) ? Number(rawMargin) : (defaults.margin ?? 50);
    const side = (k) => Number.isFinite(Number(rawMargins[k])) ? Number(rawMargins[k]) : base;
    options.margins = { top: side('top'), bottom: side('bottom'), left: side('left'), right: side('right') };
    delete options.margin;
  } else if (rawMargin !== undefined) {
    if (Number.isFinite(Number(rawMargin))) options.margin = Number(rawMargin);
    else warnings.push(`margin "${rawMargin}" is not a number - keeping the default`);
  }

  return { options, warnings };
}

/**
 * Resolve the download filename: the front-matter `filename`, else a slug of the
 * title, else the supplied fallback. Always ends in .pdf and is safe to put in a
 * Content-Disposition header.
 */
export function frontMatterToFilename(data = {}, fallback = 'document.pdf') {
  const raw = data.filename ?? data.file ?? data.output;
  let name = raw !== undefined && raw !== null ? String(raw) : null;

  if (!name && data.title) {
    name = String(data.title).trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  if (!name) name = fallback;

  name = name.split(/[\\/]/).pop().trim();             // no directory components
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  name = name.replace(/^\.+/, '');                      // no leading dots
  if (!name) name = fallback;
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}

/**
 * Copy front-matter metadata into the PDF's document properties.
 */
export function applyDocumentInfo(doc, { title, author, date } = {}) {
  if (!doc || !doc.info) return;
  if (title) doc.info.Title = String(title);
  if (author) doc.info.Author = String(author);
  if (date) {
    const d = date instanceof Date ? date : new Date(date);
    if (!Number.isNaN(d.getTime())) doc.info.CreationDate = d;
  }
}

/* ---------------- table of contents (#8) ---------------- */

function tocEntryHeight(doc, opts) {
  const prevFont = doc._font && doc._font.name;
  const prevSize = doc._fontSize;
  doc.font(opts.font).fontSize(opts.fontSize);
  const h = doc.currentLineHeight() + opts.entryGap;
  if (prevFont) doc.font(prevFont);
  if (prevSize) doc.fontSize(prevSize);
  return h;
}

/**
 * Draw a table of contents from the headings collected by renderMarkdownStyled.
 * Entries are indented by level, with a dotted leader and the page number.
 * Returns the cursor after the last entry.
 */
export function renderTableOfContents(doc, headings, userOpts = {}) {
  const opts = {
    title: 'Contents',
    titleFont: 'Helvetica-Bold',
    titleSize: 18,
    font: 'Helvetica',
    fontSize: 11,
    color: '#111',
    pageNumberColor: '#57606a',
    leader: '.',
    leaderColor: '#d0d7de',
    indent: 16,
    entryGap: 6,
    gapAfterTitle: 14,
    maxLevel: 3,
    pageOffset: 0,      // added to each recorded page number
    ...userOpts
  };

  const maxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cursor = { x: doc.page.margins.left, y: doc.page.margins.top };

  if (opts.title) {
    doc.save().font(opts.titleFont).fontSize(opts.titleSize).fillColor(opts.color)
       .text(opts.title, cursor.x, cursor.y, { width: maxWidth }).restore();
    cursor.y = doc.y + opts.gapAfterTitle;
  }

  const rowH = tocEntryHeight(doc, opts);

  for (const h of headings || []) {
    if (h.level > opts.maxLevel) continue;

    cursor.y = ensureSpace(doc, cursor.y, rowH);

    const indent = (h.level - 1) * opts.indent;
    const x = cursor.x + indent;
    const pageLabel = String(h.page + opts.pageOffset);

    doc.save().font(opts.font).fontSize(opts.fontSize);
    const pageW = doc.widthOfString(pageLabel);
    const available = maxWidth - indent - pageW - 8;

    let label = h.text;
    while (label && doc.widthOfString(label) > available) label = label.slice(0, -1);
    const labelW = doc.widthOfString(label);

    doc.fillColor(opts.color).text(label, x, cursor.y, { width: available, lineBreak: false });

    // dotted leader between the label and the page number
    if (opts.leader) {
      const dotW = doc.widthOfString(opts.leader);
      const from = x + labelW + 4;
      const to = cursor.x + maxWidth - pageW - 4;
      if (dotW > 0 && to > from) {
        const dots = opts.leader.repeat(Math.max(0, Math.floor((to - from) / dotW)));
        doc.fillColor(opts.leaderColor).text(dots, from, cursor.y, { width: to - from, lineBreak: false });
      }
    }

    doc.fillColor(opts.pageNumberColor)
       .text(pageLabel, cursor.x + maxWidth - pageW, cursor.y, { width: pageW, lineBreak: false });
    doc.restore();

    cursor.y += rowH;
  }

  return cursor;
}

/**
 * Work out how many pages a table of contents needs, and which page each heading
 * will land on once that TOC sits in front of the content. Renders throwaway
 * documents to measure, so the real render gets the page numbers right.
 */
export function planDocument(markdownString, userOpts = {}) {
  const { pdfOptions = { margin: 50 }, toc = {}, ...renderOpts } = userOpts;
  const sink = () => new Writable({ write(_chunk, _enc, cb) { cb(); } });

  // Pass 1: content only, to learn where each heading lands.
  const probe = new PDFDocument({ ...pdfOptions, bufferPages: true });
  probe.pipe(sink());
  const { headings } = renderMarkdownStyled(probe, markdownString, { ...renderOpts, outline: false });
  const contentPages = probe.bufferedPageRange().count;
  probe.end();

  // Pass 2: how many pages does a TOC of those headings occupy?
  const tocProbe = new PDFDocument({ ...pdfOptions, bufferPages: true });
  tocProbe.pipe(sink());
  renderTableOfContents(tocProbe, headings, toc);
  const tocPages = tocProbe.bufferedPageRange().count;
  tocProbe.end();

  return {
    headings: headings.map(h => ({ ...h, page: h.page + tocPages })),
    tocPages,
    contentPages,
    totalPages: tocPages + contentPages
  };
}

/**
 * Render a table of contents followed by the document, with the TOC page numbers
 * already correct. The document should be created with { bufferPages: true } if
 * you also intend to call stampPages.
 */
export function renderMarkdownWithTOC(doc, markdownString, userOpts = {}) {
  const { toc = {}, ...renderOpts } = userOpts;
  const plan = planDocument(markdownString, {
    ...renderOpts,
    toc,
    pdfOptions: doc.options || { margin: 50 }
  });

  renderTableOfContents(doc, plan.headings, toc);
  doc.addPage();                       // content starts on the page after the TOC

  const result = renderMarkdownStyled(doc, markdownString, renderOpts);
  return { ...result, toc: plan };
}

/* ---------------- page furniture: header / footer / page numbers (#7) ---------------- */

/**
 * Stamp a running header and/or footer onto every page. Call it AFTER rendering
 * and BEFORE doc.end(), on a document created with { bufferPages: true } - going
 * back to an earlier page is impossible otherwise.
 *
 *   const doc = new PDFDocument({ margin: 50, bufferPages: true });
 *   renderMarkdownStyled(doc, md, { images });
 *   stampPages(doc, { footer: (n, total) => `${n} / ${total}` });
 *   doc.end();
 *
 * `header` and `footer` may each be a string, or (pageNumber, total) => string.
 * Returns the number of pages stamped.
 */
export function stampPages(doc, opts = {}) {
  const {
    header = null,
    footer = (n, total) => `${n} / ${total}`,
    font = 'Helvetica',
    fontSize = 9,
    color = '#8c959f',
    align = 'center',
    rule = false,
    ruleColor = '#e1e4e8',
    offset = 18,          // distance into the margin, from the text edge
    skipFirst = false,    // leave a title page unstamped
    minPages = 2          // do not number a single-page document
  } = opts;

  if (typeof doc.switchToPage !== 'function' || typeof doc.bufferedPageRange !== 'function') {
    return 0;
  }
  const range = doc.bufferedPageRange();
  if (!range || !range.count || range.count < minPages) return 0;

  const resolve = (v, n) => (typeof v === 'function' ? v(n, range.count) : v);

  for (let i = 0; i < range.count; i++) {
    const pageNumber = i + 1;
    if (skipFirst && pageNumber === 1) continue;

    doc.switchToPage(range.start + i);

    // Writing into the bottom margin would make pdfkit start a new page, which
    // would in turn need stamping: zero the margin while drawing, then restore.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const topEdge = doc.page.margins.top;
    const bottomEdge = doc.page.height - savedBottom;

    doc.save().font(font).fontSize(fontSize).fillColor(color);

    const headerText = resolve(header, pageNumber);
    if (headerText) {
      doc.text(String(headerText), left, topEdge - offset - fontSize, { width, align, lineBreak: false });
      if (rule) {
        doc.moveTo(left, topEdge - offset + 2).lineTo(left + width, topEdge - offset + 2)
           .lineWidth(0.5).stroke(ruleColor);
      }
    }

    const footerText = resolve(footer, pageNumber);
    if (footerText) {
      if (rule) {
        doc.moveTo(left, bottomEdge + offset - fontSize - 4)
           .lineTo(left + width, bottomEdge + offset - fontSize - 4)
           .lineWidth(0.5).stroke(ruleColor);
      }
      doc.fillColor(color)
         .text(String(footerText), left, bottomEdge + offset - fontSize, { width, align, lineBreak: false });
    }

    doc.restore();
    doc.page.margins.bottom = savedBottom;
  }

  doc.flushPages();
  return range.count;
}

/* ---------------- master renderer ---------------- */

export function renderMarkdownStyled(doc, markdownString, userOpts = {}) {
  // Front matter is configuration, not content: strip it before lexing, or the
  // "---" fences read as a horizontal rule plus a setext heading.
  const { data: frontMatter, body, error: frontMatterError } = parseFrontMatter(markdownString || '');
  const maxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cursor = { x: doc.page.margins.left, y: doc.page.margins.top };
  const warnings = [];

  const styles = {
    heading:    { color: '#111', ...(userOpts.heading || {}) },
    paragraph:  { font: 'Helvetica', fontSize: 11, color: '#111', gap: 6, ...(userOpts.paragraph || {}) },
    codeblock:  { codeFont: 'Courier', fontSize: 10, bg: '#f6f8fa', border: '#e1e4e8', padding: 8, round: 4, gap: 8, ...(userOpts.codeblock || {}) },
    table:      { zebraFill: '#fbfbfb', fontSize: 10, ...(userOpts.table || {}) },
    list:       { ...(userOpts.list || {}) },
    blockquote: { ...(userOpts.blockquote || {}) },
    hr:         { ...(userOpts.hr || {}) },
    image:      { ...(userOpts.image || {}) }
  };

  // Page counter, so collected headings can record where they landed (#8).
  const page = { n: doc.bufferedPageRange ? doc.bufferedPageRange().count || 1 : 1 };
  const onPageAdded = () => { page.n += 1; };
  doc.on('pageAdded', onPageAdded);

  const headings = [];
  // stack[0] is the outline root; stack[n] is the most recent heading at level n
  const outline = userOpts.outline === false ? null : [doc.outline];

  try {
    renderBlocks(doc, marked.lexer(body), cursor, {
      width: maxWidth,
      styles,
      warnings,
      headings,
      outline,
      page,
      listDepth: 0,
      images: userOpts.images instanceof Map ? userOpts.images : new Map()
    });
  } finally {
    doc.removeListener('pageAdded', onPageAdded);
  }

  if (frontMatterError) warnings.push(frontMatterError);

  return { x: cursor.x, y: cursor.y, warnings, headings, pageCount: page.n, frontMatter };
}


/* ---------------- DEMO ---------------- */

// Small PNG (160x80) inlined so the demo renders without network access.
const demoImage =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABQCAIAAAARP+ljAAABIklEQVR42u3aoQ1CUQAEwW2GHuiHOqkIhSABRwnPfXGZ5Pwm' +
  'p6fb43Xc/fk97v35Had1fSsvbLdywXYrL2y3csF2Ky9st3LBdisvbLdywXYrL2y3csF2Ky9st3LBdisvbLdywXYrL2y3csF2' +
  'Ky9st3LBdisvbLdywXYrL2y3csF2Ky9st3IBF+1xLtrdXLTHuWgtLlqLi9biorlod3PRHuei3c1Fa3HRWly0FhfNRXuci3Y3' +
  'F+1xLlqLi9biorW4aC0umov2OBftbi7a41y0FhetxUVrcdFctLu5aI9z0e7morW4aC0uWouL5qI9zkW7m4v2OBetxUVrcdFa' +
  'XLQWF81Fe5yLdjcX7XEuWouL1uKitbhoLtrdXLTHuWh3c9FaF7X+S+b0MMLqSLcAAAAASUVORK5CYII=';

const demoMD = `---
title: MdReact demo
author: MdReact
date: 2026-09-18
toc:
  title: Contents
  maxLevel: 2
pageNumbers: true
header: "{title} \u2014 {author}"
footer: "{page} / {total}"
---

# Title H1

A paragraph with **bold**, *italic*, ***both***, \`inline code\`, and a [link](https://example.com).

## Subheading H2

\`\`\`js
function hello(name) {



  console.log('Hello, ' + name);


}


hello('world');
\`\`\`

## Lists

- Unordered item with **bold** and a [link](https://example.com)
- Second item
  - Nested one level
    - Nested two levels
- Back to the top level

1. Ordered first
2. Ordered second
   1. Nested ordered
   2. Another nested
3. Ordered third

- [x] Completed task
- [ ] Outstanding task

## Blockquotes

> A quotation with *emphasis* and \`inline code\`.
> It runs across two source lines.
>
> - and can contain a list
> - with a second item

## Rules and images

A horizontal rule separates these two paragraphs.

---

![A generated sample image](${demoImage})

The image above is embedded as a data URI, so this demo needs no network.

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

/* Demo render: only runs when this file is executed directly
   (`node md2pdf.js`), not when it is imported by the server. */
if (import.meta.url === `file://${process.argv[1]}`) {
  // bufferPages is what lets stampPages number the pages afterwards.
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  doc.pipe(fs.createWriteStream('markdown-styled.pdf'));

  // The demo image is a data URI, so this resolves without touching the network.
  const images = await loadImages(demoMD);

  // Everything about the page furniture comes from the document's front matter.
  const { data } = parseFrontMatter(demoMD);
  const settings = frontMatterToOptions(data);
  applyDocumentInfo(doc, settings);

  const render = settings.toc ? renderMarkdownWithTOC : renderMarkdownStyled;
  const { warnings } = render(doc, demoMD, {
    ...(settings.toc && typeof settings.toc === 'object' ? { toc: settings.toc } : {}),
    images,
    paragraph:  { font: 'Helvetica', fontSize: 11, color: '#111', gap: 10 },
    heading:    { color: '#111' },
    codeblock:  { codeFont: 'Courier', fontSize: 10, bg: '#f6f8fa', border: '#e1e4e8', padding: 10, round: 4, gap: 10 },
    table:      { zebraFill: '#fbfbfb', fontSize: 10 },
    list:       { indent: 18, markerGap: 6 },
    blockquote: { barColor: '#d0d7de', color: '#57606a' },
    hr:         { color: '#d0d7de' },
    image:      { align: 'left' }
  });

  stampPages(doc, {
    header: settings.header,
    footer: settings.footer,
    rule: true,
    skipFirst: Boolean(settings.toc)
  });

  if (warnings.length) console.warn('md2pdf:', warnings.join('; '));

  doc.end();
}
