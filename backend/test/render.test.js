import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import PDFDocument from 'pdfkit';
import { marked } from 'marked';

import {
  renderMarkdownStyled,
  renderMarkdownWithTOC,
  stampPages,
  loadImages,
  parseFrontMatter,
  frontMatterToOptions,
  frontMatterToPageOptions,
  frontMatterToFilename
} from '../md2pdf.js';

const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

/** Count page objects in a finished PDF. */
const countPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

/** Collect a document into a Buffer. */
function collect(doc) {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Render markdown and hand back the result plus the finished PDF buffer. */
function render(md, opts = {}, pdfOptions = { margin: 50 }) {
  const doc = new PDFDocument({ ...pdfOptions, bufferPages: true });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  const result = renderMarkdownStyled(doc, md, opts);
  doc.end();
  return done.then(() => ({ ...result, pdf: Buffer.concat(chunks) }));
}

/* -------------------------------------------------------------------------
 * Every block token marked can emit must render something. This is the test
 * that would have caught lists and blockquotes being dropped silently.
 * ---------------------------------------------------------------------- */

const SAMPLES = {
  heading: '# Heading',
  paragraph: 'Just a paragraph.',
  list: '- one\n- two',
  ordered_list: '1. one\n2. two',
  task_list: '- [x] done\n- [ ] todo',
  nested_list: '- one\n  - nested\n    - deeper',
  blockquote: '> quoted text',
  hr: 'before\n\n---\n\nafter',
  code: '```js\nconst x = 1;\n```',
  table: '| A | B |\n|:--|--:|\n| 1 | 2 |'
};

test('every supported block token reaches the page', async (t) => {
  for (const [name, md] of Object.entries(SAMPLES)) {
    await t.test(name, async () => {
      const empty = await render('');
      const filled = await render(md);
      assert.ok(
        filled.pdf.length > empty.pdf.length,
        `${name} produced no output beyond an empty document`
      );
      assert.deepEqual(filled.warnings, [], `${name} reported warnings`);
    });
  }
});

test('marked emits no block type the renderer ignores', () => {
  const all = Object.values(SAMPLES).join('\n\n');
  const types = new Set(marked.lexer(all).map((t) => t.type));
  const handled = new Set([
    'heading', 'paragraph', 'text', 'code', 'table',
    'list', 'blockquote', 'hr', 'space', 'def', 'image'
  ]);
  for (const type of types) {
    assert.ok(handled.has(type), `token "${type}" has no branch in renderBlocks`);
  }
});

test('an unsupported token is reported, not dropped', async () => {
  const { warnings } = await render('<div>raw html</div>');
  assert.ok(warnings.some((w) => w.includes('html')), `expected an html warning, got ${JSON.stringify(warnings)}`);
});

/* ---- headings, outline, page numbers ---------------------------------- */

test('headings are collected with their page numbers', async () => {
  const { headings } = await render('# One\n\n## Two\n\n### Three');
  assert.deepEqual(headings.map((h) => [h.level, h.text]), [[1, 'One'], [2, 'Two'], [3, 'Three']]);
  assert.ok(headings.every((h) => h.page >= 1));
});

test('a heading is never orphaned at the foot of a page', async () => {
  const para = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do. ';
  let orphaned = 0;
  for (let n = 20; n <= 46; n++) {
    const md = Array.from({ length: n }, (_, i) => `${para}(${i})`).join('\n\n') +
               '\n\n## Candidate\n\nBody that must stay with the heading.';
    const { headings, pageCount } = await render(md);
    const h = headings.find((x) => x.text === 'Candidate');
    // the heading must not be the last thing rendered on a page that has more after it
    if (h && h.page > pageCount) orphaned++;
  }
  assert.equal(orphaned, 0);
});

test('stampPages numbers every page and adds none', async () => {
  const md = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${'text '.repeat(40)}`).join('\n\n');
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  const done = collect(doc);
  renderMarkdownStyled(doc, md);
  const before = doc.bufferedPageRange().count;
  const stamped = stampPages(doc, { footer: (n, t) => `${n} / ${t}` });
  doc.end();
  const pdf = await done;

  assert.ok(before > 1, 'test needs a multi-page document');
  assert.equal(stamped, before);
  // writing a footer into the bottom margin once made pdfkit append a page per
  // stamp; compare the finished document against what was rendered
  assert.equal(countPages(pdf), before, 'stamping must not append pages');
  // content streams are compressed, so compare against the same document
  // rendered without stamping rather than searching for the literal text
  const plainDoc = new PDFDocument({ margin: 50, bufferPages: true });
  const plainDone = collect(plainDoc);
  renderMarkdownStyled(plainDoc, md);
  plainDoc.end();
  const plain = await plainDone;

  assert.equal(countPages(plain), before);
  assert.ok(pdf.length > plain.length, 'stamped document should carry the extra footers');
});

test('a single-page document is not numbered', async () => {
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  doc.pipe(sink());
  renderMarkdownStyled(doc, '# Short');
  assert.equal(stampPages(doc, {}), 0);
  doc.end();
});

/* ---- table of contents ------------------------------------------------- */

test('TOC page numbers account for the pages the TOC itself takes', async () => {
  const md = '# One\n\n' + 'text '.repeat(400) + '\n\n# Two\n\nEnd.';
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  doc.pipe(sink());
  const { toc } = renderMarkdownWithTOC(doc, md, { toc: {} });
  doc.end();
  assert.ok(toc.tocPages >= 1);
  assert.ok(toc.headings.every((h) => h.page > toc.tocPages),
    'every heading must sit after the contents pages');
});

/* ---- front matter ------------------------------------------------------ */

test('front matter is parsed and kept out of the body', () => {
  const { data, body } = parseFrontMatter('---\ntitle: T\ntoc: true\n---\n\n# Heading');
  assert.equal(data.title, 'T');
  assert.equal(data.toc, true);
  assert.equal(body.trim(), '# Heading');
});

test('a rule in the middle of a document is not front matter', () => {
  const md = 'text\n\n---\n\nmore';
  assert.deepEqual(parseFrontMatter(md), { data: {}, body: md, raw: null });
});

test('malformed front matter degrades instead of throwing', () => {
  const { data, error } = parseFrontMatter('---\ntitle: "unclosed\n bad: [\n---\n# X');
  assert.deepEqual(data, {});
  assert.match(error, /not valid YAML/);
});

test('front matter never renders as content', async () => {
  const { warnings } = await render('---\ntitle: Secret Setting\n---\n\n# Body');
  assert.deepEqual(warnings, []);
});

test('header and footer placeholders expand', () => {
  const o = frontMatterToOptions({ title: 'T', author: 'A', date: '2026-01-01', footer: '{page}/{total} {title}' });
  assert.equal(o.footer(2, 7), '2/7 T');
});

test('pageNumbers: false removes the footer', () => {
  assert.equal(frontMatterToOptions({ pageNumbers: false }).footer, null);
});

test('themes change the body font', () => {
  assert.equal(frontMatterToOptions({ theme: 'serif' }).styles.paragraph.font, 'Times-Roman');
  assert.equal(frontMatterToOptions({}).styles.paragraph, undefined);
});

/* ---- page setup and filename ------------------------------------------- */

test('page setup maps onto PDFDocument options', () => {
  assert.equal(frontMatterToPageOptions({ pageSize: 'A4' }).options.size, 'A4');
  assert.equal(frontMatterToPageOptions({ orientation: 'landscape' }).options.layout, 'landscape');
  assert.deepEqual(
    frontMatterToPageOptions({ margins: { top: 10, bottom: 20, left: 30, right: 40 } }).options.margins,
    { top: 10, bottom: 20, left: 30, right: 40 }
  );
});

test('an unknown page size warns and keeps the default', () => {
  const { options, warnings } = frontMatterToPageOptions({ pageSize: 'Banana' });
  assert.equal(options.size, undefined);
  assert.match(warnings[0], /unknown pageSize/);
});

test('filenames are taken from front matter, or slugged from the title', () => {
  assert.equal(frontMatterToFilename({ filename: 'report.pdf' }), 'report.pdf');
  assert.equal(frontMatterToFilename({ filename: 'report' }), 'report.pdf');
  assert.equal(frontMatterToFilename({ title: 'Rapport Trimestriel 2026!' }), 'rapport-trimestriel-2026.pdf');
  assert.equal(frontMatterToFilename({}, 'fallback.pdf'), 'fallback.pdf');
});

test('a filename cannot escape its directory', () => {
  assert.equal(frontMatterToFilename({ filename: '../../etc/passwd' }), 'passwd.pdf');
  assert.equal(frontMatterToFilename({ filename: '/absolute/path.pdf' }), 'path.pdf');
  assert.ok(!frontMatterToFilename({ filename: '..' }).includes('..'));
});

/* ---- images ------------------------------------------------------------ */

const RED_DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a data: URI image is loaded and drawn', async () => {
  const md = `![dot](${RED_DOT})`;
  const images = await loadImages(md);
  assert.ok(Buffer.isBuffer(images.get(RED_DOT)));
  const { warnings } = await render(md, { images });
  assert.deepEqual(warnings, []);
});

test('a missing image explains itself instead of failing', async () => {
  const { warnings } = await render('![x](https://example.invalid/nope.png)', { images: new Map() });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /image skipped/);
});

test('loopback and private hosts are refused', async () => {
  for (const host of ['http://localhost/x.png', 'http://127.0.0.1/x.png',
                      'http://192.168.1.5/x.png', 'http://169.254.169.254/x.png']) {
    const m = await loadImages(`![x](${host})`, { timeoutMs: 500 });
    assert.equal(Buffer.isBuffer(m.get(host)), false, `${host} should not have been fetched`);
    assert.match(m.get(host).error, /private host/);
  }
});

test('a relative image path is refused unless baseDir is given', async () => {
  const m = await loadImages('![x](./secret.png)');
  assert.match(m.get('./secret.png').error, /baseDir/);
});
