# MdReact

A basic application demoing a md -> pdf component which runs on the server side
The app features MDEditor to edit the md source and calls the server to produce the pdf

## Running it

```bash
npm install && npm run dev       # editor on http://localhost:5173
cd backend && npm install && npm run dev   # PDF server on http://localhost:4000
```

The backend's `dev` script runs under nodemon, so it restarts when a `.js` file
changes; `npm start` runs it once without the watcher.

`node backend/md2pdf.js` renders a self-contained demo to `markdown-styled.pdf`.

## Document settings (YAML front matter)

A document carries its own print settings in a YAML block at the very top of the
file. The block is configuration, not content: it never appears in the PDF, and
the editor preview hides it too.

```markdown
---
title: Quarterly Report
author: Philippe Meyer
date: 2026-09-18
filename: rapport-q3.pdf       # what the download is called
pageSize: A4                   # letter, legal, A3…, or [width, height] in points
orientation: portrait          # or landscape
margin: 50                     # or margins: { top: 60, bottom: 60, left: 50, right: 50 }
theme: serif                   # default | serif | compact | wide
toc: true                      # or a map: { title: Sommaire, maxLevel: 2 }
pageNumbers: true              # footer "n / total"; skipped on a 1-page document
header: "{title}"
footer: "{page} / {total} — {date}"
---

# The document starts here
```

| Key | Effect |
|:--|:--|
| `title`, `author`, `date` | Written into the PDF properties, and usable as placeholders |
| `filename` | Download name; defaults to a slug of `title`. Always forced to `.pdf` |
| `pageSize` | `A4`, `letter`, `legal`, `A3`… or `[width, height]` in points |
| `orientation` | `portrait` (default) or `landscape` |
| `margin`, `margins` | A single number, or per-side `{ top, bottom, left, right }` |
| `theme` | `default`, `serif`, `compact` or `wide` |
| `toc` | `true`, or a map of `renderTableOfContents` options, to prepend a contents page |
| `pageNumbers` | `false` turns the default `n / total` footer off |
| `header`, `footer` | Running text; `false` to disable one |
| `paragraph`, `heading`, `codeblock`, `table`, `list`, `blockquote` | Style maps, applied over the theme |

`header` and `footer` accept the placeholders `{page}`, `{total}`, `{title}`,
`{author}` and `{date}`.

Anything not set in front matter falls back to the request body
(`{ md, filename, toc, pageNumbers, header }`), then to the defaults.

## The editor

- **Markdown / PDF** switches the right pane between the markdown preview and a
  live preview of the real PDF, re-rendered as you type.
- **Open .md** / **Save .md** import and export the source; the draft is also
  kept in `localStorage`, so a reload does not lose it.
- The download button shows the filename the document has chosen for itself.
- Warnings (an image that could not be loaded, an unknown page size) appear in
  the status line rather than only in the server log.

## Markdown supported

Headings, paragraphs with inline styling and links, lists (ordered, unordered,
nested and task lists), blockquotes, horizontal rules, fenced code blocks,
tables (headers repeat across page breaks), and images.

Images may be `data:` URIs or remote PNG/JPEG. A URL that does not return an
image renders a placeholder saying why, rather than failing silently. Remote
fetches skip loopback and private hosts.
