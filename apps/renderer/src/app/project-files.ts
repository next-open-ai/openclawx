/** Shared project deliverable filtering for project workspace & asset library trees. */

export type ProjectFileEntry = { relative: string; type: 'directory' | 'file' };

/** Agent process / scaffolding scripts — not shown as deliverables. */
export function isAgentProcessFile(relative: string) {
  const parts = relative.replace(/\\/g, '/').split('/');
  const name = parts.at(-1) ?? relative;
  if (parts.some((part) => ['.agents', '.dsh-sessions', '.git', '.python-packages', 'node_modules'].includes(part))) return true;
  if (name === '.openclawx-dsh.cordis.yml' || name === '.DS_Store') return true;
  if (/\.(py|sh)$/i.test(name)) return true;
  if (/^(gen_|patch_|scaffold_|tmp_)/i.test(name) && /\.(js|mjs|cjs|ts)$/i.test(name) && !relative.includes('/')) return true;
  return false;
}

export function deliverableEntries(entries: ProjectFileEntry[]): ProjectFileEntry[] {
  const keptFiles = entries.filter((entry) => entry.type === 'file' && !isAgentProcessFile(entry.relative));
  const keptPaths = keptFiles.map((entry) => entry.relative);
  return entries.filter((entry) => {
    if (entry.type === 'file') return !isAgentProcessFile(entry.relative);
    if (entry.type !== 'directory') return false;
    return keptPaths.some((path) => path === entry.relative || path.startsWith(`${entry.relative}/`));
  });
}

export function fileExt(name: string) {
  return name.split('.').pop()?.toLowerCase() || '';
}

export type PreviewKind = 'html' | 'markdown' | 'image' | 'pdf' | 'code' | 'text' | 'unsupported';

export function previewKindForName(name: string): PreviewKind {
  const ext = fileExt(name);
  if (/^html?$/.test(ext)) return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return 'image';
  if (/^(css|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|xml|txt|csv)$/i.test(ext)) return 'code';
  return 'unsupported';
}

/** Safe, dependency-free Markdown → HTML used by asset previews and chat replies. */
export function markdownToHtml(source: string) {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inCode = false;
  let codeBuf: string[] = [];
  let table: string[] = [];

  const closeList = () => {
    if (list) { html.push(`</${list}>`); list = null; }
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()));
    const separator = rows.findIndex((row) => row.every((cell) => /^:?-{3,}:?$/.test(cell)));
    if (rows.length >= 2 && separator === 1) {
      const headers = rows[0];
      const body = rows.slice(2);
      html.push(`<div class="chat-md-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMd(escape(cell))}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${headers.map((_, index) => `<td>${inlineMd(escape(row[index] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else table.forEach((line) => html.push(`<p>${inlineMd(escape(line))}</p>`));
    table = [];
  };

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inCode) {
        html.push(`<pre><code>${escape(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList(); flushTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    const unordered = raw.match(/^\s*[-*+]\s+(.+)/);
    const ordered = raw.match(/^\s*\d+[.)]\s+(.+)/);
    if (unordered || ordered) {
      flushTable();
      const nextList = ordered ? 'ol' : 'ul';
      if (list !== nextList) { closeList(); html.push(`<${nextList}>`); list = nextList; }
      html.push(`<li>${inlineMd(escape((ordered ?? unordered)![1]))}</li>`);
      continue;
    }
    closeList();
    if (/^\s*\|.*\|\s*$/.test(raw)) { table.push(raw); continue; }
    flushTable();
    const heading = raw.match(/^\s*(#{1,6})\s+(.+)/);
    if (heading) html.push(`<h${heading[1].length}>${inlineMd(escape(heading[2]))}</h${heading[1].length}>`);
    else if (/^\s*>\s?/.test(raw)) html.push(`<blockquote>${inlineMd(escape(raw.replace(/^\s*>\s?/, '')))}</blockquote>`);
    else if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(raw)) html.push('<hr/>');
    // Block elements own their vertical rhythm. Emitting a standalone <br> for
    // Markdown blank lines doubles the space around headings, paragraphs and lists.
    else if (!raw.trim()) { /* semantic block separation only */ }
    else html.push(`<p>${inlineMd(escape(raw))}</p>`);
  }
  closeList();
  flushTable();
  if (inCode) html.push(`<pre><code>${escape(codeBuf.join('\n'))}</code></pre>`);
  return html.join('\n');
}

function inlineMd(value: string) {
  return value
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)(?:\s+"[^"]*")?\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
