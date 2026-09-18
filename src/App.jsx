import { useCallback, useEffect, useRef, useState } from 'react'
import MDEditor from '@uiw/react-md-editor';
import remarkFrontmatter from 'remark-frontmatter';
import './App.css'

// Same-origin by default: the Vite dev server proxies /api to the PDF backend
// (see vite.config.js), and in production the two are served together. Set
// VITE_API_URL to call a backend on another host.
const API = import.meta.env.VITE_API_URL || '/api/generatePDF';
const DRAFT_KEY = 'mdreact:draft';
const PREVIEW_DEBOUNCE_MS = 700;

const STARTER = `---
title: My document
filename: my-document.pdf
pageSize: A4
toc: false
pageNumbers: true
footer: "{page} / {total}"
---

# Title H1

A paragraph with **bold**, *italic*, ***both***, \`inline code\`, and a [link](https://example.com).

- List item one
- List item two
  - Nested item

| Product | Details             | Price |
|:-------:|:--------------------|------:|
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
`;

function readDraft() {
  try {
    const saved = window.localStorage.getItem(DRAFT_KEY);
    if (typeof saved === 'string' && saved.length) return saved;
  } catch {
    // private mode or blocked storage: fall through to the starter document
  }
  return STARTER;
}

function App() {
  const [md, setMd] = useState(readDraft);
  const [pane, setPane] = useState('markdown');      // right pane: markdown | pdf
  const [pdf, setPdf] = useState(null);              // { url, name, blob, source }
  const [status, setStatus] = useState('idle');      // idle | rendering | error
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState([]);

  const abortRef = useRef(null);
  const urlRef = useRef(null);

  // ---- draft autosave (#15) -------------------------------------------------
  useEffect(() => {
    const id = setTimeout(() => {
      try { window.localStorage.setItem(DRAFT_KEY, md); } catch { /* storage may be unavailable */ }
    }, 400);
    return () => clearTimeout(id);
  }, [md]);

  // ---- ask the server for a PDF --------------------------------------------
  const generate = useCallback(async (source, { signal } = {}) => {
    const resp = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ md: source }),
      signal
    });

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try {
        const body = await resp.json();
        if (body && body.error) detail = body.error;
      } catch { /* not JSON; keep the status line */ }
      throw new Error(detail);
    }

    // the document names itself through its front matter
    const disposition = resp.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/i);
    const name = match ? match[1] : 'document.pdf';

    let notes = [];
    const raw = resp.headers.get('x-pdf-warnings');
    if (raw) {
      try {
        // atob yields one byte per char; decode those bytes as UTF-8 so that
        // punctuation like the em dash survives the header round-trip
        const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
        notes = JSON.parse(new TextDecoder().decode(bytes));
      } catch { /* ignore a malformed header */ }
    }

    return { blob: await resp.blob(), name, warnings: notes };
  }, []);

  // ---- live preview (#11), debounced ---------------------------------------
  useEffect(() => {
    if (pane !== 'pdf') return undefined;
    if (pdf && pdf.source === md) return undefined;      // already current

    const id = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus('rendering');
      setMessage('');
      try {
        const { blob, name, warnings: notes } = await generate(md, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = URL.createObjectURL(blob);
        setPdf({ url: urlRef.current, name, blob, source: md });
        setWarnings(notes);
        setStatus('idle');
      } catch (err) {
        if (err.name === 'AbortError') return;
        setStatus('error');
        setMessage(err.message || 'Could not reach the PDF server');
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => clearTimeout(id);
  }, [md, pane, pdf, generate]);

  // release the last object URL when the app goes away
  useEffect(() => () => {
    abortRef.current?.abort();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const saveBlob = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---- download the PDF (#14: the name comes from the document) -------------
  const downloadPDF = async () => {
    if (pdf && pdf.source === md) {
      saveBlob(pdf.blob, pdf.name);
      return;
    }
    setStatus('rendering');
    setMessage('');
    try {
      const { blob, name, warnings: notes } = await generate(md);
      setWarnings(notes);
      setStatus('idle');
      saveBlob(blob, name);
    } catch (err) {
      setStatus('error');
      setMessage(err.message || 'Could not reach the PDF server');
    }
  };

  // ---- import / export markdown (#15) --------------------------------------
  const openFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';                  // allow re-opening the same file
    if (!file) return;
    try {
      setMd(await file.text());
      setPdf(null);
    } catch {
      setStatus('error');
      setMessage(`Could not read ${file.name}`);
    }
  };

  const saveMarkdown = () => {
    const base = (pdf?.name || 'document.pdf').replace(/\.pdf$/i, '');
    saveBlob(new Blob([md], { type: 'text/markdown' }), `${base}.md`);
  };

  const showPdfPane = pane === 'pdf';

  return (
    <div data-color-mode="light" className="app">
      <header className="app-bar">
        <div className="app-brand">
          <img className="app-logo" src="/logo.svg" alt="" width="28" height="28" />
          <h2 className="app-title">Markdown → PDF</h2>
        </div>

        <div className="app-tools">
          <label className="button file-button">
            Open .md
            <input type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={openFile} />
          </label>
          <button type="button" onClick={saveMarkdown}>Save .md</button>

          <span className="segmented" role="group" aria-label="Preview pane">
            <button type="button" aria-pressed={!showPdfPane} onClick={() => setPane('markdown')}>
              Markdown
            </button>
            <button type="button" aria-pressed={showPdfPane} onClick={() => setPane('pdf')}>
              PDF
            </button>
          </span>

          <button type="button" className="primary" onClick={downloadPDF}>
            Download {pdf?.name ?? 'PDF'}
          </button>
        </div>
      </header>

      <div className={showPdfPane ? 'panes split' : 'panes'}>
        <div className="pane">
          <MDEditor
            value={md}
            onChange={(v) => setMd(v ?? '')}
            height="100%"
            preview={showPdfPane ? 'edit' : 'live'}
            // keep YAML front matter out of the preview: it is print configuration,
            // not content, and without this it renders as a stray setext heading
            previewOptions={{ remarkPlugins: [remarkFrontmatter] }}
          />
        </div>

        {showPdfPane && (
          <div className="pane pdf-pane">
            {pdf?.url
              ? <iframe title="PDF preview" src={pdf.url} />
              : <p className="pdf-placeholder">
                  {status === 'error' ? 'No preview available.' : 'Rendering the first preview…'}
                </p>}
          </div>
        )}
      </div>

      <footer className={`status status-${status}`}>
        {status === 'rendering' && <span className="spinner" aria-hidden="true" />}
        {status === 'rendering' && <span>Rendering…</span>}
        {status === 'error' && <span>⚠ {message}</span>}
        {status === 'idle' && warnings.length > 0 &&
          <span className="warnings">⚠ {warnings.join(' · ')}</span>}
        {status === 'idle' && warnings.length === 0 &&
          <span className="muted">Settings live in the YAML block at the top of the document.</span>}
      </footer>
    </div>
  );
}

export default App
