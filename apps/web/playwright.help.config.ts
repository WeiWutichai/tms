import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * P1-ST6-T01 ภาพหน้าจอของ help center (packages/help-center/site/images) — `pnpm --filter @tms/web help:shots`
 * ใช้ API + web + ฐาน e2e ชุดเดียวกับ E2E (seed เดโม) → ภาพอัปเดตตาม UI จริงทุกครั้งที่รัน แล้วรัน
 * `pnpm --filter @tms/help-center docs:build` + commit · docs:check แดงถ้าภาพที่บทความอ้างไม่มี
 * [DECISION — lead 27 พ.ย. 2569, ย้อนได้] opt-in แบบ e2e:a11y / e2e:mobile (ไม่รวมใน `pnpm e2e` / ci:local) — ภาพ PNG
 * เปลี่ยนทุกไบต์ทุกรอบ (font/anti-alias) จึงไม่เทียบเนื้อหา ตรวจแค่ "มีครบ"
 */
export default defineConfig({
  ...base,
  testMatch: /help-shots\.spec\.ts$/,
  testIgnore: [],
  retries: 0,
});
