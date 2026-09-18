# MdReact

A basic application demoing a md -> pdf component which runs on the server side
The app features MDEditor to edit the md source and calls the server to produce the pdf

## Running it

```bash
npm install && npm --prefix backend install
npm run dev        # editor on http://localhost:5173, PDF server on :4000
npm test           # the renderer's test suite
```

`npm run dev` starts both halves together; `dev:web` and `dev:pdf` run them
separately. The backend runs under nodemon, so it restarts when a `.js` file
changes (`npm --prefix backend start` runs it once without the watcher).

The editor calls `/api/...` on its own origin - the Vite dev server proxies
that to the backend, so there is no hardcoded host and no CORS in development.
Point it elsewhere with `VITE_PDF_SERVER` (see `.env.example`).

### Docker

```bash
docker compose up --build     # everything on http://localhost:4000
```

The image builds the editor and serves it from the PDF server, so the whole app
is one container and one origin. Rate limit, timeout and body size are tunable
through the environment (`PDF_RATE_MAX`, `PDF_TIMEOUT_MS`, `PDF_MAX_BODY`).

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

## Tests

`npm test` runs the renderer's suite (`backend/test/`) on Node's built-in test
runner - no framework. It asserts that every block token `marked` can emit
actually reaches the page, the check the original renderer lacked when lists
and blockquotes were being dropped silently.

## Markdown supported

Headings, paragraphs with inline styling and links, lists (ordered, unordered,
nested and task lists), blockquotes, horizontal rules, fenced code blocks,
tables (headers repeat across page breaks), and images.

Images may be `data:` URIs or remote PNG/JPEG. A URL that does not return an
image renders a placeholder saying why, rather than failing silently. Remote
fetches skip loopback and private hosts.
