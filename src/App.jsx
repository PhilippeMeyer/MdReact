import { useState } from 'react'
import MDEditor from '@uiw/react-md-editor';
import './App.css'

function App() {
  const [md, setMd] = useState(`# Title H1

A paragraph with **bold**, *italic*, ***both***, \`inline code\`, and a [link](https://example.com).

| Product | Details             | Price |
|:-------:|:--------------------|------:|
| **Apple** | Crisp *green* one |  1.20 |
| Banana  | ~~ripe~~ now **sweet** | 0.80 |
`);

  const downloadPDF = async () => {
    try {
      const resp = await fetch('http://localhost:4000/api/generatePDF', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ md, filename: 'markdown.pdf' })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();

      // Trigger download
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'markdown.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert('Failed to generate PDF');
    }
  };

  return (
<div data-color-mode="light" style={{ padding: 16 }}>
      <h2>Markdown → PDF</h2>
      <MDEditor value={md} onChange={setMd} height={400} />
      <div style={{ marginTop: 12 }}>
        <button onClick={downloadPDF}>Download PDF</button>
      </div>
    </div>
  );}

export default App
