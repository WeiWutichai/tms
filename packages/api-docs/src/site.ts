/**
 * ประกอบ docs site ทั้งชุด (ST7-T12): `<slug>.html` + `<slug>.md` ทุกหน้า, llms.txt, llms-full.txt, Postman collection
 * ผลลัพธ์ deterministic (ไม่มีเวลาที่สร้าง) → CI เทียบกับที่ commit ได้ (docs:check)
 */
import { GROUPS, buildPages, type Guide, type Page } from './pages';
import { postmanCollection } from './postman';
import { escapeHtml, renderMarkdown } from './markdown';
import type { Json } from './openapi';

export const POSTMAN_FILE = 'tms-api.postman_collection.json';

/** สีและตัวอักษรตามต้นแบบ TMS v4 (หน้า นักพัฒนา / Open API แท็บ เอกสาร) — ไม่มีต้นแบบของ docs site สาธารณะ (spec/12 §3) */
const CSS = `
:root{--ink:#101418;--muted:#59606B;--line:#E4E6E0;--bg:#FFFFFF;--side:#F4F5F2;--accent:#2257C4;--code:#EEF0EC}
*{box-sizing:border-box}
body{margin:0;font-family:'IBM Plex Sans Thai Looped','IBM Plex Sans',system-ui,sans-serif;color:var(--ink);background:var(--bg);font-size:14px;line-height:1.6}
a{color:var(--accent)}
.layout{display:flex;min-height:100vh}
nav{width:272px;flex:none;background:var(--side);border-right:1px solid var(--line);padding:20px 16px;position:sticky;top:0;height:100vh;overflow:auto}
nav .brand{font-weight:600;font-size:15px;margin-bottom:12px;display:block;color:var(--ink);text-decoration:none}
nav h4{font-size:12px;color:var(--muted);margin:16px 0 4px;font-weight:600}
nav a{display:block;padding:3px 8px;border-radius:6px;text-decoration:none;color:var(--ink);font-size:13px}
nav a.on{background:#FFFFFF;color:var(--accent);font-weight:600}
main{flex:1;min-width:0;padding:28px 40px;max-width:1100px}
main h1{font-size:24px;margin:0 0 8px}main h2{font-size:18px;margin:32px 0 8px;padding-top:12px;border-top:1px solid var(--line)}main h3{font-size:15px;margin:20px 0 6px}
code{font-family:'IBM Plex Mono',monospace;font-size:12.5px;background:var(--code);padding:1px 4px;border-radius:4px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}pre code{background:none;padding:0}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--side);font-weight:600}
blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--accent);background:var(--side)}
.md-link{float:right;font-size:12px}
@media (max-width:800px){.layout{display:block}nav{position:static;width:auto;height:auto}main{padding:16px}}
`;

const rewriteHref = (h: string) =>
  h.replace(/^([\w.-]+)\.md(#.*)?$/, (_m, s: string, a?: string) => `${s}.html${a ?? ''}`);

function nav(pages: Page[], current: string): string {
  const groups = GROUPS.map((g) => {
    const items = pages
      .filter((p) => p.group === g)
      .map(
        (p) =>
          `<a href="${p.slug}.html"${p.slug === current ? ' class="on"' : ''}>${escapeHtml(p.title)}</a>`,
      )
      .join('');
    return `<h4>${escapeHtml(g)}</h4>${items}`;
  });
  return `<nav><a class="brand" href="index.html">TMS API v1</a>${groups.join('')}</nav>`;
}

export function pageHtml(p: Page, pages: Page[]): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(p.title)} · TMS API</title>
<link rel="alternate" type="text/markdown" href="${p.slug}.md">
<style>${CSS.trim()}</style>
</head>
<body>
<div class="layout">
${nav(pages, p.slug)}
<main>
<a class="md-link" href="${p.slug}.md">Markdown</a>
${renderMarkdown(p.md, { rewriteHref })}
</main>
</div>
</body>
</html>
`;
}

export function llmsTxt(pages: Page[]): string {
  const groups = GROUPS.map((g) => {
    const ps = pages.filter((p) => p.group === g);
    return `## ${g}\n\n${ps.map((p) => `- [${p.title}](${p.slug}.md): ${p.summary}`).join('\n')}`;
  });
  return (
    [
      '# TMS API v1',
      '> Open API ของ TMS (ระบบจัดการขนส่งทางบก) — REST JSON ใต้ /v1, auth ด้วย Bearer API key (tk_live_/tk_test_) หรือ OAuth2 client credentials, error แบบ RFC 9457 problem+json, cursor pagination, Idempotency-Key, ETag/If-Match, webhook ลงลายเซ็น HMAC-SHA256',
      'ทุกหน้ามีฉบับ Markdown ที่ URL เดียวกันแต่ลงท้าย .md · เนื้อหาทั้งหมดในไฟล์เดียว: llms-full.txt · spec เต็ม: GET /v1/openapi.json',
      ...groups,
      `## Optional\n\n- [llms-full.txt](llms-full.txt): ทุกหน้าในไฟล์เดียว\n- [Postman collection](${POSTMAN_FILE}): Postman v2.1`,
    ].join('\n\n') + '\n'
  );
}

export function llmsFullTxt(pages: Page[]): string {
  return pages.map((p) => `<!-- ${p.slug}.md -->\n${p.md}`).join('\n---\n\n');
}

/** ไฟล์ทั้งหมดของ site: path → เนื้อหา */
export function buildSite(
  doc: Json,
  guides: Guide[],
  include: (path: string) => string,
): Map<string, string> {
  const pages = buildPages(doc, guides, include);
  const files = new Map<string, string>();
  for (const p of pages) {
    files.set(`${p.slug}.md`, p.md);
    files.set(`${p.slug}.html`, pageHtml(p, pages));
  }
  files.set('llms.txt', llmsTxt(pages));
  files.set('llms-full.txt', llmsFullTxt(pages));
  files.set(POSTMAN_FILE, JSON.stringify(postmanCollection(doc), null, 2) + '\n');
  return files;
}
