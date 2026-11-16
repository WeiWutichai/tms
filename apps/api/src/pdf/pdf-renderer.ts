import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ProblemException } from '../common/problem';
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
/**
 * จำกัดงาน render พร้อมกัน + เส้นตาย (review ST3-T20) — รอคิวเกิน PDF_QUEUE_TIMEOUT_MS (30000) → 503 `service_busy`,
 * render เกิน PDF_TIMEOUT_MS (30000) → 503 `pdf_render_timeout` (ข้อความไทย) · พร้อมกัน PDF_MAX_CONCURRENT (3)
 */
export class RenderGate {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    readonly max: number,
    /** เส้นตาย render นับจากได้ช่อง */
    readonly timeoutMs: number,
    /** เส้นตายรอคิว */
    readonly queueMs: number = timeoutMs,
  ) {}

  get running(): number {
    return this.active;
  }

  async run<T>(fn: (onTimeout: (cb: () => void) => void) => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(() => {
          const i = this.queue.indexOf(go);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new ProblemException('service_busy'));
        }, this.queueMs);
        this.queue.push(go);
      });
    }
    this.active++;
    let cleanup: (() => void) | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn((cb) => (cleanup = cb)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cleanup?.();
            reject(new ProblemException('pdf_render_timeout'));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const envInt = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isInteger(v) && v > 0 ? v : d;
};

@Injectable()
export class PdfRenderer implements OnModuleDestroy {
  private browser: Promise<Browser> | null = null;
  private current: Browser | null = null;
  readonly gate = new RenderGate(
    envInt('PDF_MAX_CONCURRENT', 3),
    envInt('PDF_TIMEOUT_MS', 30_000),
    envInt('PDF_QUEUE_TIMEOUT_MS', 30_000),
  );

  /** เปิด Chromium (test แทนด้วยตัวปลอมได้) */
  protected launch(): Promise<Browser> {
    return chromium.launch({ headless: true, args: ['--font-render-hinting=none'] });
  }

  private getBrowser(): Promise<Browser> {
    // Chromium ตาย/ถูกปิด → เปิดใหม่ในคำขอถัดไป (ไม่ค้าง promise ของ browser ที่ใช้ไม่ได้แล้ว — ST3-T20)
    this.browser ??= this.launch()
      .then((b) => {
        b.on('disconnected', () => {
          if (this.current === b) this.browser = null;
        });
        this.current = b;
        return b;
      })
      .catch((e: unknown) => {
        this.browser = null;
        throw e;
      });
    return this.browser;
  }

  /** browser หลุดระหว่าง getBrowser() กับ newContext() → ทิ้งแล้วเปิดใหม่ 1 ครั้ง (review ST3-T20 L3) */
  private async newContext(): Promise<BrowserContext> {
    const opts = {
      viewport: { width: 794, height: 1123 },
      deviceScaleFactor: 1,
      locale: 'th-TH',
      timezoneId: 'Asia/Bangkok',
    };
    const b = await this.getBrowser();
    try {
      return await b.newContext(opts);
    } catch (e) {
      if (b.isConnected()) throw e;
      if (this.current === b) {
        this.browser = null;
        this.current = null;
      }
      return (await this.getBrowser()).newContext(opts);
    }
  }

  html(opts: RenderOptions): string {
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${escapeHtml(opts.title ?? '')}</title><style>${sarabunFontCss()}
@page{size:A4;margin:0}html,body{margin:0;padding:0;font-family:'Sarabun',sans-serif;font-size:14px;line-height:1.5;color:#101418;-webkit-print-color-adjust:exact;print-color-adjust:exact}
${opts.css ?? ''}</style></head><body>${opts.body}</body></html>`;
  }

  /**
   * เปิดหน้าเพื่อ render (ใช้ร่วมระหว่าง PDF และ screenshot ของ golden test) — ผ่าน RenderGate
   * template ที่แบ่งหน้าเอง (`[data-paginate]`) → รอสคริปต์ตั้ง `html[data-paged]` ก่อน
   */
  async withPage<T>(opts: RenderOptions, fn: (page: Page) => Promise<T>): Promise<T> {
    return this.gate.run(async (onTimeout) => {
      const context = await this.newContext();
      onTimeout(() => void context.close().catch(() => undefined));
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
        await page.waitForFunction(
          "!document.querySelector('[data-paginate]') || document.documentElement.hasAttribute('data-paged')",
        );
        return await fn(page);
      } finally {
        await context.close().catch(() => undefined);
      }
    });
  }

  async pdf(opts: RenderOptions): Promise<Buffer> {
    return this.withPage(opts, (page) =>
      page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.current = null;
    if (b) await (await b).close();
  }
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
