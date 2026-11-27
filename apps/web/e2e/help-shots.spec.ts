import { mkdirSync } from 'node:fs';
import { expect, test } from './fixtures';

/**
 * P1-ST6-T01 ภาพหน้าจอของบทความ help center — ชื่อไฟล์ต้องตรงกับ `![](images/<name>.png)` ใน packages/help-center/articles
 * ข้อมูลเดโมจาก seed (owner@demo-a.test — แพ็กเกจ "มาตรฐาน") · ขนาดจอ 1440×900 ตาม E2E
 */
const OUT = new URL('../../../packages/help-center/site/images/', import.meta.url).pathname;

const SHOTS: { name: string; path: string; heading: string }[] = [
  { name: 'settings-org', path: '/settings?sec=org', heading: 'องค์กร' },
  { name: 'settings-users', path: '/settings?sec=users', heading: 'ผู้ใช้และสิทธิ์' },
  { name: 'settings-pod', path: '/settings?sec=pod', heading: 'หลักฐานส่ง (POD) ค่าเริ่มต้น' },
  { name: 'master-customers', path: '/master/customers', heading: 'ลูกค้า' },
  { name: 'orders', path: '/so', heading: 'ใบสั่งขนส่ง (SO)' },
  { name: 'plan-board', path: '/plan', heading: 'กระดานวางแผน' },
  { name: 'trips', path: '/trips', heading: 'เที่ยวรถ / ใบคุมรถ' },
  { name: 'subcon', path: '/sub', heading: 'จ่ายงานรถร่วม' },
  { name: 'billing', path: '/bill', heading: 'วางบิลและใบแจ้งหนี้' },
  { name: 'payments', path: '/pay', heading: 'รับชำระ' },
  { name: 'settle', path: '/settle', heading: 'Settlement รถร่วม' },
];

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

for (const s of SHOTS)
  test(`ภาพ ${s.name}`, async ({ page }) => {
    await page.goto(s.path);
    await expect(page.getByRole('heading', { name: s.heading, exact: true }).first()).toBeVisible();
    await page.waitForLoadState('networkidle');
    // ไม่ให้ toast / cursor กะพริบติดในภาพ
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${OUT}${s.name}.png`, animations: 'disabled', caret: 'hide' });
  });
