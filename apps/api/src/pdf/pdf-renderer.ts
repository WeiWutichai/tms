import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { chromium, type Browser } from 'playwright-core';
import { sarabunFontCss } from './fonts';

export interface RenderOptions {
  /** HTML ส่วน body (template ใส่ข้อมูลแล้ว) */
  body: string;
  /** CSS ของเอกสาร (ไม่ต้องใส่ @font-face — ใส่ให้อัตโนมัติ) */
  css?: string;
  title?: string;
}

/**
 * HTML → PDF ด้วย headless Chromium (ST0-T17, plan/02 T-09)
 * - A4, margin 0 (template กำหนดเอง), พิมพ์พื้นหลัง, ฟอนต์ Sarabun ฝังในไฟล์
 * - ไม่โหลดอะไรจากเน็ต: block ทุก request ที่ไม่ใช่ data:/about: (กัน template ดึงรูป/สคริปต์ภายนอก)
 * - เอกสารภาษี render ครั้งเดียวตอน ISSUED แล้วเก็บผ่าน FileStore แบบเขียนครั้งเดียว (docs/01 §1)
 */
@Injectable()
export class PdfRenderer implements OnModuleDestroy {
  private browser: Promise<Browser> | null = null;

  private getBrowser(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true, args: ['--font-render-hinting=none'] });
    return this.browser;
  }

  html(opts: RenderOptions): string {
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(opts.title ?? '')}</title><style>${sarabunFontCss()}
@page{size:A4;margin:0}html,body{margin:0;padding:0;font-family:'Sarabun',sans-serif;font-size:14px;line-height:1.5;color:#101418;-webkit-print-color-adjust:exact;print-color-adjust:exact}
${opts.css ?? ''}</style></head><body>${opts.body}</body></html>`;
  }

  /** เปิดหน้าเพื่อ render (ใช้ร่วมระหว่าง PDF และ screenshot ของ golden test) */
  async withPage<T>(
    opts: RenderOptions,
    fn: (page: import('playwright-core').Page) => Promise<T>,
  ): Promise<T> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: { width: 794, height: 1123 },
      deviceScaleFactor: 1,
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
    });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const url = route.request().url();
        return url.startsWith('data:') || url.startsWith('about:')
          ? route.continue()
          : route.abort();
      });
      await page.setContent(this.html(opts), { waitUntil: 'load' });
      await page.evaluate('document.fonts.ready');
      return await fn(page);
    } finally {
      await context.close();
    }
  }

  async pdf(opts: RenderOptions): Promise<Buffer> {
    return this.withPage(opts, (page) =>
      page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) await (await this.browser).close();
    this.browser = null;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
