/**
 * ตรวจ site ที่สร้าง (docs:check — P1-ST6-T01 เกณฑ์ตรวจรับ):
 * - ลิงก์ภายในทุกตัว (`href`) ชี้ไฟล์ที่มี และ `#anchor` มี id อยู่จริง · ภาพทุกตัว (`src`) มีไฟล์ใน site/images
 * - ทุก error code ของ API (openapi.json) และของ connector มีหัวข้อใน catalog
 * - ทุก flow ในแถว backlog มีบทความ ≥ 1
 */
import type { ProblemEntry, ConnectorEntry } from './errors';
import { IMAGES_SUBDIR } from './inputs';

/** flow ในแถว P1-ST6-T01 (plan/13) → slug ของบทความที่ต้องมี */
export const REQUIRED_FLOWS: Record<string, string> = {
  'สมัคร/trial': 'signup-trial',
  ตั้งค่าองค์กร: 'company-setup',
  นำเข้าข้อมูล: 'import-data',
  รับงาน: 'orders',
  จัดรถ: 'dispatch',
  ลิงก์รถร่วม: 'subcontractor-link',
  POD: 'pod',
  วางบิล: 'billing',
  รับชำระ: 'payments',
  จ่ายรถร่วม: 'carrier-settlement',
  ส่งออกให้นักบัญชี: 'accountant-export',
  'เชื่อม FlowAccount/PEAK': 'connect-flowaccount-peak',
  แพ็กเกจและการชำระ: 'plans-billing',
};

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decode(m[1]!)));
}

export function checkSite(
  files: Map<string, string>,
  images: ReadonlySet<string>,
  problems: ProblemEntry[],
  connectors: ConnectorEntry[],
): string[] {
  const problemsOut: string[] = [];
  const idCache = new Map<string, Set<string>>();
  const idsOf = (f: string) => {
    if (!idCache.has(f)) idCache.set(f, ids(files.get(f) ?? ''));
    return idCache.get(f)!;
  };
  const usedImages = new Set<string>();
  for (const [name, body] of files) {
    if (!name.endsWith('.html')) continue;
    for (const m of body.matchAll(/\shref="([^"]*)"/g)) {
      const href = decode(m[1]!);
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [path, anchor] = href.split('#') as [string, string | undefined];
      const target = path || name;
      if (!files.has(target)) {
        problemsOut.push(`${name}: ลิงก์เสีย → ${href}`);
        continue;
      }
      if (anchor && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(anchor)))
        problemsOut.push(`${name}: ไม่มีหัวข้อ #${anchor} ใน ${target}`);
    }
    for (const m of body.matchAll(/\ssrc="([^"]*)"/g)) {
      const src = decode(m[1]!);
      if (src.startsWith(`${IMAGES_SUBDIR}/`)) {
        const img = src.slice(IMAGES_SUBDIR.length + 1);
        usedImages.add(img);
        if (!images.has(img))
          problemsOut.push(
            `${name}: ไม่มีภาพ ${src} (รัน \`pnpm --filter @tms/web help:shots\` แล้ว commit)`,
          );
      } else if (!files.has(src)) problemsOut.push(`${name}: ไฟล์ที่อ้างไม่มี → ${src}`);
    }
  }
  for (const img of images)
    if (!usedImages.has(img))
      problemsOut.push(
        `ภาพ ${IMAGES_SUBDIR}/${img} ไม่มีบทความใดใช้ (ลบออกจาก help-shots หรือใส่ในบทความ)`,
      );
  const errIds = idsOf('errors.html');
  for (const p of problems)
    if (!errIds.has(p.code)) problemsOut.push(`errors.html: ไม่มีหัวข้อของ code ${p.code}`);
  const conIds = idsOf('connector-errors.html');
  for (const c of connectors)
    if (!conIds.has(c.key)) problemsOut.push(`connector-errors.html: ไม่มีหัวข้อของ ${c.key}`);
  for (const [flow, slug] of Object.entries(REQUIRED_FLOWS))
    if (!files.has(`${slug}.html`)) problemsOut.push(`ไม่มีบทความของ flow "${flow}" (${slug}.md)`);
  return problemsOut;
}
