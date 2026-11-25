// Small Markdown subset for stories: headings, paragraphs, lists, quotes,
// emphasis, links, images, and [[Person Name|link text]] person links.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: src };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(item[1].trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      data[key] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { data, body: m[2] };
}

function inline(text, resolvePerson) {
  const people = [];
  let out = esc(text);
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, name, label) => {
    const p = resolvePerson(name.trim());
    const shown = label ? label.trim() : name.replace(/\s*\(\d{3,4}\)\s*$/, '').trim();
    if (!p) return shown;
    people.push(p.id);
    return `<a class="person-link" href="#person-${p.id}" data-person="${p.id}">${shown}</a>`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(.*?)&quot;)?\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" loading="lazy">`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const ext = /^https?:/.test(href) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${href}"${ext}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return { html: out, people };
}

export function renderMarkdown(src, resolvePerson) {
  const blocks = src.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const html = [];
  const people = new Set();
  const run = (t) => {
    const r = inline(t, resolvePerson);
    r.people.forEach((p) => people.add(p));
    return r.html;
  };
  const IMG = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/;
  for (const block of blocks) {
    const b = block.trim();
    if (!b) continue;
    // A block of nothing but images becomes figures: one wide, or several side by side.
    // ![alt](src "caption"): the caption may hold [[person]] links.
    const lines = b.split('\n').map((l) => l.trim());
    if (lines.every((l) => IMG.test(l))) {
      const figs = lines.map((l) => {
        const [, alt, src, cap] = l.match(IMG);
        return `<figure class="story-fig"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">${cap ? `<figcaption>${run(cap)}</figcaption>` : ''}</figure>`;
      });
      html.push(figs.length > 1 ? `<div class="fig-row">${figs.join('')}</div>` : figs[0]);
      continue;
    }
    const h = b.match(/^(#{1,4})\s+(.*)$/);
    if (h && !b.includes('\n')) {
      const level = Math.min(h[1].length + 1, 4);
      html.push(`<h${level}>${run(h[2])}</h${level}>`);
    } else if (/^[-*]\s+/.test(b)) {
      const items = b.split(/\n(?=[-*]\s+)/).map((i) => `<li>${run(i.replace(/^[-*]\s+/, '').replace(/\n\s*/g, ' '))}</li>`);
      html.push(`<ul>${items.join('')}</ul>`);
    } else if (/^>\s?/.test(b)) {
      html.push(`<blockquote><p>${run(b.replace(/^>\s?/gm, '').replace(/\n/g, ' '))}</p></blockquote>`);
    } else {
      html.push(`<p>${run(b.replace(/\n/g, ' '))}</p>`);
    }
  }
  return { html: html.join('\n'), people: [...people] };
}
