/**
 * ประกอบ help center ทั้งชุด (P1-ST6-T01): `<slug>.html` + `<slug>.md` ทุกหน้า, `index.html`, `search-index.js`
 * ผลลัพธ์ deterministic (ไม่มีเวลาที่สร้าง) → CI เทียบกับที่ commit ได้ (docs:check)
 *
 * โครงหน้า (R-14 — ต้นแบบไม่มีหน้า help center): แผ่นเอกสารบนพื้นโต๊ะจาก `design/prototype/doc-page.js` แบบ FLOWING
 * (พื้น #f5f5f4 padding 48px 24px · แผ่นขาวกว้าง 8.5in radius 7px เงา 0 2px 10px rgba(20,20,19,.12) ขอบใน 0.75in)
 * + สี/ตัวอักษร TMS v4 ชุดเดียวกับ packages/api-docs
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (1) เพิ่มแถบบน (ชื่อ + ช่องค้นหา) และเมนูหมวดด้านซ้ายนอกแผ่นเอกสาร — doc-page ไม่มีการนำทาง
 *   (2) จอ ≤ 800px: แผ่นเต็มความกว้าง ขอบใน 20px เมนูย้ายขึ้นบน (doc-page เลื่อนแนวนอน — ใช้กับจอมือถือ 390px ไม่ได้)
 */
import { escapeHtml, renderMarkdown } from '@tms/api-docs';
import type { Article } from './inputs';
import { connectorEntries, connectorErrorsArticle, errorsArticle, problemCodes } from './errors';

/** หมวดในเมนูซ้ายตามลำดับการใช้งาน (สมัคร → ตั้งค่า → งานขนส่ง → การเงิน → เชื่อมระบบบัญชี → แพ็กเกจ → อ้างอิง) */
export const GROUPS = [
  'เริ่มต้นใช้งาน',
  'งานขนส่ง',
  'การเงิน',
  'เชื่อมระบบบัญชี',
  'บัญชีและแพ็กเกจ',
  'อ้างอิง',
] as const;

export const SEARCH_FILE = 'search-index.js';
/** สคริปต์ค้นหาเป็นไฟล์แยก (ไม่ inline) — P1-ST6-T02 เสิร์ฟ help center ใต้ `/help/` ของเว็บ ซึ่ง CSP `script-src 'self'` ห้าม inline script */
export const SEARCH_JS_FILE = 'search.js';
/** บทความ "ติดต่อทีมงาน" (P1-ST6-T03) — ลิงก์จากแถบบนทุกหน้า */
export const CONTACT_SLUG = 'contact';
export const SOON_LABEL = 'เร็ว ๆ นี้';
const BRAND = 'ศูนย์ช่วยเหลือ TMS';

const CSS = `
:root{--ink:#101418;--muted:#59606B;--line:#E4E6E0;--desk:#f5f5f4;--sheet:#FFFFFF;--side:#F4F5F2;--accent:#2257C4;--code:#EEF0EC;--soon-bg:#FFF4D6;--soon-ink:#7A5200}
*{box-sizing:border-box}
body{margin:0;font-family:'IBM Plex Sans Thai Looped','IBM Plex Sans',system-ui,sans-serif;color:var(--ink);background:var(--desk);font-size:15px;line-height:1.7}
a{color:var(--accent)}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:16px;padding:10px 24px;background:var(--sheet);border-bottom:1px solid var(--line)}
.top .brand{font-weight:600;font-size:16px;color:var(--ink);text-decoration:none;white-space:nowrap}
.top .contact{font-size:14px;font-weight:600;text-decoration:none;white-space:nowrap;margin-left:auto}
.search{position:relative;flex:1;max-width:520px}
.search input{width:100%;font:inherit;font-size:14px;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--side)}
.search input:focus{outline:2px solid var(--accent);outline-offset:0;background:#fff}
.results{position:absolute;left:0;right:0;top:calc(100% + 4px);background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 2px 10px rgba(20,20,19,.12);max-height:60vh;overflow:auto;display:none}
.results.on{display:block}
.results a{display:block;padding:8px 12px;text-decoration:none;color:var(--ink);border-bottom:1px solid var(--line)}
.results a:last-child{border-bottom:0}
.results a:hover,.results a.sel{background:var(--side)}
.results small{display:block;color:var(--muted);font-size:12px}
.results .none{padding:8px 12px;color:var(--muted);font-size:13px}
.desk{display:flex;gap:24px;align-items:flex-start;justify-content:center;padding:48px 24px}
nav.side{width:232px;flex:none;position:sticky;top:72px;font-size:13.5px}
nav.side h4{font-size:12px;color:var(--muted);margin:16px 0 4px;font-weight:600}
nav.side h4:first-child{margin-top:0}
nav.side a{display:block;padding:3px 8px;border-radius:6px;text-decoration:none;color:var(--ink)}
nav.side a.on{background:var(--sheet);color:var(--accent);font-weight:600}
.sheet{width:8.5in;max-width:100%;min-width:0;background:var(--sheet);box-shadow:0 2px 10px rgba(20,20,19,.12);border-radius:7px;padding:.75in}
.sheet h1{font-size:26px;line-height:1.3;margin:0 0 12px;text-wrap:balance}
.sheet h2{font-size:19px;margin:32px 0 8px;padding-top:12px;border-top:1px solid var(--line);text-wrap:balance}
.sheet h3{font-size:16px;margin:22px 0 6px}
.sheet p,.sheet li{text-wrap:pretty}
.sheet img{display:block;max-width:100%;height:auto;margin:12px 0;border:1px solid var(--line);border-radius:7px}
code{font-family:'IBM Plex Mono',monospace;font-size:13px;background:var(--code);padding:1px 4px;border-radius:4px}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto}pre code{background:none;padding:0}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:var(--side);font-weight:600}
td[id]{scroll-margin-top:72px}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--side);border-radius:0 6px 6px 0}
.soon{display:inline-block;font-size:12px;font-weight:600;color:var(--soon-ink);background:var(--soon-bg);border-radius:999px;padding:1px 10px;margin-left:6px;vertical-align:middle}
.md-link{float:right;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:12px 0 24px}
.card{display:block;border:1px solid var(--line);border-radius:7px;padding:12px 14px;text-decoration:none;color:var(--ink)}
.card:hover{border-color:var(--accent)}
.card b{display:block;margin-bottom:2px}
.card span{color:var(--muted);font-size:13px}
@media (max-width:1100px){nav.side{display:none}}
@media (max-width:800px){.top{flex-wrap:wrap;padding:10px 16px}.top .contact{order:1}.search{order:2;flex-basis:100%;max-width:none}.desk{display:block;padding:16px}.sheet{width:auto;padding:20px}}
@media print{.top,nav.side,.md-link{display:none}body{background:none}.desk{padding:0}.sheet{box-shadow:none;border-radius:0;width:auto;padding:0}}
`;

/** ค้นหาฝั่ง client: ตรงตัวอักษร (ภาษาไทยไม่เว้นวรรคระหว่างคำ — ไม่ตัดคำ) ทุกคำที่พิมพ์ต้องพบ · หัวข้อได้คะแนนก่อนเนื้อหา */
const SEARCH_JS = `
(function(){var box=document.getElementById('q'),out=document.getElementById('results');if(!box||!out)return;var sel=-1;
function norm(s){return (s||'').toLowerCase().normalize('NFC')}
function run(){var q=norm(box.value).trim();out.innerHTML='';sel=-1;if(!q){out.classList.remove('on');return}
var terms=q.split(/\\s+/),idx=window.HELP_INDEX||[],hits=[];
for(var i=0;i<idx.length;i++){var d=idx[i],t=norm(d.t),b=norm(d.b),ok=true,score=0;
for(var j=0;j<terms.length;j++){var w=terms[j];if(t.indexOf(w)>=0)score+=10;else if(b.indexOf(w)>=0)score+=1;else{ok=false;break}}
if(ok)hits.push([score,i])}
hits.sort(function(a,b){return b[0]-a[0]||a[1]-b[1]});
if(!hits.length){out.innerHTML='<div class="none">ไม่พบผลลัพธ์ ลองใช้คำอื่น</div>'}
hits.slice(0,12).forEach(function(h){var d=idx[h[1]],a=document.createElement('a');a.href=d.u;a.textContent=d.t;var s=document.createElement('small');s.textContent=d.g;a.appendChild(s);out.appendChild(a)});
out.classList.add('on')}
box.addEventListener('input',run);
box.addEventListener('keydown',function(e){var as=out.querySelectorAll('a');if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(!as.length)return;sel=(sel+(e.key==='ArrowDown'?1:-1)+as.length)%as.length;as.forEach(function(a,k){a.classList.toggle('sel',k===sel)})}else if(e.key==='Enter'){var t=as[sel>=0?sel:0];if(t)location.href=t.href}else if(e.key==='Escape'){out.classList.remove('on')}});
document.addEventListener('click',function(e){if(!e.target.closest||!e.target.closest('.search'))out.classList.remove('on')});
})();
`;

export interface Page extends Article {
  /** HTML ของเนื้อหา (render แล้ว) */
  body: string;
}

const rewriteHref = (h: string) =>
  h.replace(/^([\w.-]+)\.md(#.*)?$/, (_m, s: string, a?: string) => `${s}.html${a ?? ''}`);

/** `| `code` {#code} |` ในตาราง → `<td id="code">` (anchor ต่อรหัสใน catalog) */
const cellAnchors = (html: string) =>
  html.replace(/<td><code>([\w.-]+)<\/code> \{#\1\}<\/td>/g, '<td id="$1"><code>$1</code></td>');
const stripCellAnchors = (md: string) => md.replace(/ \{#[\w.-]+\} \|/g, ' |');

function titleHtml(p: Article): string {
  return (
    escapeHtml(p.title) + (p.status === 'soon' ? ` <span class="soon">${SOON_LABEL}</span>` : '')
  );
}

function nav(pages: Page[], current: string): string {
  const groups = GROUPS.map((g) => {
    const items = pages
      .filter((p) => p.group === g)
      .map(
        (p) =>
          `<a href="${p.slug}.html"${p.slug === current ? ' class="on"' : ''}>${titleHtml(p)}</a>`,
      )
      .join('');
    return items ? `<h4>${escapeHtml(g)}</h4>${items}` : '';
  });
  return `<nav class="side" aria-label="หมวดบทความ">${groups.join('')}</nav>`;
}

function shell(title: string, current: string, pages: Page[], main: string, md?: string): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${BRAND}</title>
${md ? `<link rel="alternate" type="text/markdown" href="${md}">\n` : ''}<style>${CSS.trim()}</style>
</head>
<body>
<header class="top">
<a class="brand" href="index.html">${BRAND}</a>
<div class="search" role="search"><input id="q" type="search" placeholder="ค้นหาวิธีใช้งานหรือข้อความ error" aria-label="ค้นหา" autocomplete="off"><div id="results" class="results"></div></div>
<a class="contact" href="${CONTACT_SLUG}.html">ติดต่อทีมงาน</a>
</header>
<div class="desk">
${nav(pages, current)}
<main class="sheet">
${main}
</main>
</div>
<script src="${SEARCH_FILE}"></script>
<script src="${SEARCH_JS_FILE}"></script>
</body>
</html>
`;
}

function articleHtml(p: Page, pages: Page[]): string {
  const soon =
    p.status === 'soon'
      ? `<p><span class="soon">${SOON_LABEL}</span></p>\n` // ข้อความ "ยังไม่เปิด" อยู่ในบทความเอง (ไม่ซ้ำ)
      : '';
  return shell(
    p.title,
    p.slug,
    pages,
    `<a class="md-link" href="${p.slug}.md">Markdown</a>\n${soon}${p.body}`,
    `${p.slug}.md`,
  );
}

function indexHtml(pages: Page[]): string {
  const groups = GROUPS.map((g) => {
    const ps = pages.filter((p) => p.group === g);
    if (!ps.length) return '';
    const cards = ps
      .map(
        (p) =>
          `<a class="card" href="${p.slug}.html"><b>${titleHtml(p)}</b><span>${escapeHtml(p.summary)}</span></a>`,
      )
      .join('');
    return `<h2>${escapeHtml(g)}</h2>\n<div class="cards">${cards}</div>`;
  });
  return shell(
    BRAND,
    'index',
    pages,
    `<h1>${BRAND}</h1>\n<p>คู่มือใช้งาน TMS ทีละขั้น ตั้งแต่ตั้งค่าบริษัท รับงาน จัดรถ ไปจนถึงวางบิล รับชำระ และจ่ายรถร่วม — พิมพ์สิ่งที่ต้องการในช่องค้นหาด้านบน หรือเลือกหัวข้อด้านล่าง</p>\n${groups.join('\n')}`,
  );
}

/** ข้อความล้วนของ markdown สำหรับดัชนีค้นหา */
export function plainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\{#[\w.-]+\}/g, '')
    .replace(/[`*#>|]/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SearchDoc {
  /** หัวข้อ */
  t: string;
  /** หมวด (แสดงใต้ผลลัพธ์) */
  g: string;
  /** URL สัมพัทธ์ */
  u: string;
  /** เนื้อหา */
  b: string;
}

export function searchIndex(pages: Page[], extra: SearchDoc[]): string {
  const docs: SearchDoc[] = [
    ...pages.map((p) => ({
      t: p.title + (p.status === 'soon' ? ` (${SOON_LABEL})` : ''),
      g: p.group,
      u: `${p.slug}.html`,
      b: plainText(p.md),
    })),
    ...extra,
  ];
  return `window.HELP_INDEX=${JSON.stringify(docs)};\n`;
}

/** ทุกหน้า (บทความ + catalog error ที่สร้างจากโค้ด) ตามลำดับ GROUPS แล้วตามลำดับไฟล์ */
export function buildPages(
  articles: Article[],
  doc: Record<string, any>,
  problemMessages: Record<string, string>,
): { pages: Page[]; extra: SearchDoc[] } {
  for (const a of articles)
    if (!(GROUPS as readonly string[]).includes(a.group))
      throw new Error(`${a.slug}: หมวด "${a.group}" ไม่อยู่ใน GROUPS`);
  const problems = problemCodes(doc, problemMessages);
  const connectors = connectorEntries();
  const all = [...articles, errorsArticle(problems), connectorErrorsArticle(connectors)];
  const slugs = new Set<string>();
  for (const a of all) {
    if (slugs.has(a.slug) || a.slug === 'index') throw new Error(`slug ซ้ำ: ${a.slug}`);
    slugs.add(a.slug);
  }
  const ordered = GROUPS.flatMap((g) => all.filter((a) => a.group === g));
  const pages = ordered.map((a) => ({
    ...a,
    body: cellAnchors(renderMarkdown(a.md, { rewriteHref })),
  }));
  const extra: SearchDoc[] = [
    ...problems.map((e) => ({
      t: e.message,
      g: `รหัส error · ${e.code}`,
      u: `errors.html#${e.code}`,
      b: e.code,
    })),
    ...connectors.map((e) => ({
      t: e.title,
      g: `error การเชื่อมระบบบัญชี · ${e.key}`,
      u: `connector-errors.html#${e.key}`,
      b: `${e.key} ${e.action}`,
    })),
  ];
  return { pages, extra };
}

/** ไฟล์ทั้งหมดของ site (ยกเว้นภาพใน images/ — สร้างโดย Playwright): path → เนื้อหา */
export function buildSite(
  articles: Article[],
  doc: Record<string, any>,
  problemMessages: Record<string, string>,
): Map<string, string> {
  const { pages, extra } = buildPages(articles, doc, problemMessages);
  const files = new Map<string, string>();
  files.set('index.html', indexHtml(pages));
  for (const p of pages) {
    files.set(`${p.slug}.md`, stripCellAnchors(p.md));
    files.set(`${p.slug}.html`, articleHtml(p, pages));
  }
  files.set(SEARCH_FILE, searchIndex(pages, extra));
  files.set(SEARCH_JS_FILE, SEARCH_JS.trim() + '\n');
  return files;
}
