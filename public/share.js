// Print-ready view of one agent document: /share.html#<agent id>/<analysis|design|flow|proposal>
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const [agentId, kind] = location.hash.slice(1).split('/');
$('#print').onclick = () => window.print();

async function main() {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 401 ? 'Sign in to Agent Manager first, then reopen this page.' : `HTTP ${res.status}`);
  const a = await res.json();
  const d = a.docs?.[kind];
  if (!d?.markdown) throw new Error('This document has not been written yet.');
  const blocks = [];
  const text = d.markdown.replace(/```mermaid\s*\n([\s\S]*?)```/g, (_, src) => {
    blocks.push(src.trim());
    return `\n\nMERMAIDBLOCK${blocks.length - 1}\n\n`;
  });
  $('#doc').innerHTML =
    DOMPurify.sanitize(marked.parse(text, { gfm: true })).replace(/<p>MERMAIDBLOCK(\d+)<\/p>/g, (_, i) => `<div class="diagram" data-i="${i}"></div>`) +
    `<p class="meta">${esc(a.name)} · ${esc(a.projectInfo?.name ?? '')} · written ${esc(new Date(d.at).toLocaleString())}</p>`;
  document.title = (d.markdown.match(/^#\s+(.+)$/m)?.[1] ?? `${kind} · ${a.name}`).slice(0, 120);
  if (blocks.length) {
    const mermaid = (await import('/vendor/mermaid/mermaid.esm.min.mjs')).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    for (const el of document.querySelectorAll('.diagram')) {
      try {
        el.innerHTML = (await mermaid.render(`d${el.dataset.i}`, blocks[Number(el.dataset.i)])).svg;
      } catch {
        el.innerHTML = `<pre>${esc(blocks[Number(el.dataset.i)])}</pre>`;
      }
    }
  }
  $('#status').textContent = 'Ready to print or save as PDF.';
}
main().catch((err) => {
  $('#status').textContent = '';
  $('#doc').innerHTML = `<p class="error">${esc(err.message)}</p>`;
});
