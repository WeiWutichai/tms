/**
 * Markdown → HTML ขนาดเล็กสำหรับ docs site (ไม่เพิ่ม dependency — ST7-T12)
 * รองรับเฉพาะที่ guides/ และหน้าที่ generate ใช้: หัวข้อ (# – ####, `{#id}` ท้ายหัวข้อ), ย่อหน้า, code block (```lang),
 * ตาราง (| a | b |), รายการ - / 1., blockquote >, เส้น ---, inline `code` **ตัวหนา** [ลิงก์](url), ภาพ ![alt](src) และ <br>
 * ข้อความทุกส่วนถูก escape — HTML ดิบใน markdown ไม่ถูกส่งต่อ (ยกเว้น comment `<!-- -->` ที่ถูกตัดทิ้ง)
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** id ของหัวข้อ: ตัวพิมพ์เล็ก ช่องว่าง → - ตัดสัญลักษณ์ (คงอักษรไทย) */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

export interface RenderOptions {
  /** แปลง href ของลิงก์ (เช่น `x.md` → `x.html`) */
  rewriteHref?: (href: string) => string;
}

function inline(src: string, opts: RenderOptions): string {
  const out: string[] = [];
  // แยก inline code ก่อน (ข้างในไม่แปลงอะไร)
  const parts = src.split(/(`[^`]+`)/);
  for (const p of parts) {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) {
      out.push(`<code>${escapeHtml(p.slice(1, -1))}</code>`);
      continue;
    }
    let s = escapeHtml(p);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // ภาพ (help center — P1-ST6-T01) ก่อนลิงก์ · src เฉพาะ path สัมพัทธ์ (ไม่มี scheme)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) =>
      /^[a-z][a-z0-9+.-]*:/i.test(src) ? m : `<img src="${src}" alt="${alt}" loading="lazy">`,
    );
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
      const raw = href.replace(/&amp;/g, '&');
      const h = opts.rewriteHref ? opts.rewriteHref(raw) : raw;
      if (/^\s*javascript:/i.test(h)) return text;
      return `<a href="${escapeHtml(h)}">${text}</a>`;
    });
    s = s.replace(/&lt;br&gt;/g, '<br>');
    out.push(s);
  }
  return out.join('');
}

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i]!;
    if (c === '\\' && l[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      inCode = !inCode;
      cur += c;
    } else if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  const lines = md.replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const html: string[] = [];
  const used = new Map<string, number>();
  let i = 0;
  const isBlockStart = (l: string) => /^(#{1,4}\s|```|\||>|-{3,}\s*$|\s*[-*]\s|\s*\d+\.\s)/.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      const lang = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
      html.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*?)\s*(?:\{#([\w.-]+)\})?\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      let id = h[3] ?? slugify(h[2]!);
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      html.push(`<h${level} id="${escapeHtml(id)}">${inline(h[2]!, opts)}</h${level}>`);
      i++;
      continue;
    }
    if (/^-{3,}\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }
    if (line.trim().startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(lines[i++]!);
      const head = splitRow(rows[0]!);
      const body = rows.slice(/^\|?\s*:?-{2,}/.test(rows[1]?.trim() ?? '') ? 2 : 1);
      html.push(
        '<div class="table"><table><thead><tr>' +
          head.map((c) => `<th>${inline(c, opts)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body
            .map(
              (r) =>
                `<tr>${splitRow(r)
                  .map((c) => `<td>${inline(c, opts)}</td>`)
                  .join('')}</tr>`,
            )
            .join('') +
          '</tbody></table></div>',
      );
      continue;
    }
    if (line.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>'))
        q.push(lines[i++]!.replace(/^>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(q.join('\n'), opts)}</blockquote>`);
      continue;
    }
    const li = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (m) {
          items.push(m[2]!);
          i++;
        } else if (lines[i]!.startsWith('  ') && lines[i]!.trim() && items.length) {
          items[items.length - 1] += ' ' + lines[i++]!.trim();
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((x) => `<li>${inline(x, opts)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    html.push(`<p>${inline(para.join(' '), opts)}</p>`);
  }
  return html.join('\n');
}
