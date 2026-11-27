import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** โฟลเดอร์ของ package (ทำงานได้ทั้งจาก src/ ตอน test และ dist/ ตอนรัน) */
export const PKG_DIR = resolve(__dirname, '..');
export const SITE_DIR = join(PKG_DIR, 'site');
/** ภาพหน้าจอ — สร้างโดย Playwright (`pnpm --filter @tms/web help:shots`) ไม่ใช่ generator นี้ (cli ไม่ลบ/ไม่เทียบเนื้อหา แต่ตรวจว่าภาพที่อ้างมีครบ) */
export const IMAGES_SUBDIR = 'images';
export const IMAGES_DIR = join(SITE_DIR, IMAGES_SUBDIR);
export const OPENAPI_PATH = resolve(PKG_DIR, '../contracts/openapi.json');
/** ข้อความ error ที่หน้าจอแสดงจริง (`problem.<code>` ใน th.ts — ไม่มี = ใช้ title จาก API) */
export const TH_I18N_PATH = resolve(PKG_DIR, '../../apps/web/src/i18n/th.ts');

export interface Article {
  /** ชื่อไฟล์ไม่รวมเลขลำดับ — URL `<slug>.html` */
  slug: string;
  title: string;
  /** หมวดในเมนูซ้าย (ต้องอยู่ใน GROUPS) */
  group: string;
  summary: string;
  /** `soon` = ฟีเจอร์ยังไม่เปิด (ป้าย "เร็ว ๆ นี้" — ห้ามเขียนวิธีใช้ UI ที่ยังไม่มี) */
  status: 'live' | 'soon';
  md: string;
}

/** front matter แบบ `key: value` บรรทัดละคู่ระหว่าง `---` (ไม่เพิ่ม dependency) */
export function parseArticle(file: string, src: string): Article {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!m) throw new Error(`${file}: ไม่มี front matter (--- title/group/summary ---)`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  for (const k of ['title', 'group', 'summary'])
    if (!meta[k]) throw new Error(`${file}: front matter ขาด ${k}`);
  if (meta.status && meta.status !== 'soon' && meta.status !== 'live')
    throw new Error(`${file}: status ต้องเป็น live หรือ soon`);
  return {
    slug: file.replace(/^\d+-/, '').replace(/\.md$/, ''),
    title: meta.title!,
    group: meta.group!,
    summary: meta.summary!,
    status: meta.status === 'soon' ? 'soon' : 'live',
    md: src.slice(m[0].length).replace(/^\n+/, ''),
  };
}

export function loadArticles(dir = join(PKG_DIR, 'articles')): Article[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseArticle(f, readFileSync(join(dir, f), 'utf8')));
}

/** `problem.<code>` → ข้อความ จาก th.ts (regex เดียวกับ apps/web/scripts/build-i18n.mjs) */
export function parseProblemMessages(thSrc: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of thSrc.matchAll(/^\s+'problem\.([a-z0-9_]+)':\s+'((?:[^'\\]|\\.)*)',$/gm))
    out[m[1]!] = m[2]!.replace(/\\(.)/g, '$1');
  // ข้อความยาวที่ prettier ขึ้นบรรทัดใหม่: 'problem.x':\n    'ข้อความ',
  for (const m of thSrc.matchAll(/^\s+'problem\.([a-z0-9_]+)':\n\s+'((?:[^'\\]|\\.)*)',$/gm))
    out[m[1]!] ??= m[2]!.replace(/\\(.)/g, '$1');
  return out;
}

export interface Inputs {
  articles: Article[];
  /** openapi.json (สร้างจากโค้ด API — `x-problem-codes` = PROBLEMS ทั้งชุด) */
  doc: Record<string, any>;
  problemMessages: Record<string, string>;
}

export function loadInputs(): Inputs {
  return {
    articles: loadArticles(),
    doc: JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')),
    problemMessages: parseProblemMessages(readFileSync(TH_I18N_PATH, 'utf8')),
  };
}
