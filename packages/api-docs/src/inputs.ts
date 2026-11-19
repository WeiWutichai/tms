import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Guide } from './pages';
import type { Json } from './openapi';

/** โฟลเดอร์ของ package (ทำงานได้ทั้งจาก src/ ตอน test และ dist/ ตอนรัน) */
export const PKG_DIR = resolve(__dirname, '..');
export const SITE_DIR = join(PKG_DIR, 'site');
export const OPENAPI_PATH = resolve(PKG_DIR, '../contracts/openapi.json');

export function loadInputs(): { doc: Json; guides: Guide[]; include: (p: string) => string } {
  const doc = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));
  const dir = join(PKG_DIR, 'guides');
  const guides = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({
      slug: f.replace(/^\d+-/, '').replace(/\.md$/, ''),
      md: readFileSync(join(dir, f), 'utf8'),
    }));
  const include = (p: string) => readFileSync(join(PKG_DIR, p), 'utf8');
  return { doc, guides, include };
}
