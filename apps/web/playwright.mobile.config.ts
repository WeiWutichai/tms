import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * ST4-T15 เมทริกซ์มือถือแบบจำลอง (emulation) ของหน้า public 3 หน้า — `pnpm --filter @tms/web e2e:mobile` (หรือ `pnpm e2e:mobile` ที่ราก)
 * 3 browser ตาม backlog: Chrome Android (chromium) · Safari iOS (webkit — ติดตั้ง: npx playwright install webkit)
 * · LINE in-app (UA ของ LINE + ความสูงจอที่แถบหัว/ท้ายของ LINE กินไป) ทั้งฝั่ง Android (WebView = chromium) และ iOS (WKWebView = webkit)
 *
 * [DECISION — lead 25 พ.ย. 2569, ย้อนได้] แยกเป็น config/สคริปต์ opt-in ไม่รวมใน `pnpm e2e` / ci:local:
 * ชุดนี้รันเมทริกซ์ 4 project × 3 หน้า (สร้างข้อมูลใหม่ทุก project) + ต้องมี webkit ซึ่ง CI/เครื่อง dev ยังไม่บังคับติดตั้ง
 * — ตามแบบ `e2e:a11y` (ST9-T20) · E2E ปกติยังครอบ flow เดียวกันที่ 390 px ใน chromium อยู่แล้ว
 * (subcon-offer-link / subcon-link-pod / tracking-link)
 *
 * [DECISION — lead 25 พ.ย. 2569, ย้อนได้] ทุก project ใช้ความกว้าง 390 px (มาตรฐานหน้า public ของ repo — CLAUDE.md §ภาพเทียบ)
 * และ spec ตรวจซ้ำที่ 360 px (Android ราคาประหยัด) · ความสูง LINE in-app เป็นค่าประมาณจากแถบหัว (ชื่อ + URL) และแถบเครื่องมือล่างของ LINE
 */
const LINE_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0';
const LINE_ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.6613.127 Mobile Safari/537.36 Line/14.10.0/IAB';

export default defineConfig({
  ...base,
  testMatch: /mobile-public\.spec\.ts$/,
  testIgnore: [],
  use: { ...base.use, locale: 'th-TH', timezoneId: 'Asia/Bangkok' },
  projects: [
    {
      name: 'android-chrome',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 839 } },
    },
    {
      name: 'ios-safari',
      use: { ...devices['iPhone 14'] }, // 390 × 664 (หักแถบ Safari แล้ว)
    },
    {
      name: 'line-android',
      use: {
        ...devices['Pixel 7'],
        userAgent: LINE_ANDROID_UA,
        viewport: { width: 390, height: 731 }, // หักแถบหัว LINE 56 + แถบล่าง 52
      },
    },
    {
      name: 'line-ios',
      use: {
        ...devices['iPhone 14'],
        userAgent: LINE_IOS_UA,
        viewport: { width: 390, height: 650 }, // WKWebView ใต้แถบหัว LINE (ชื่อ + URL) เหนือแถบเครื่องมือล่าง
      },
    },
  ],
});
