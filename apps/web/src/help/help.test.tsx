import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import { NAV, SUBPAGES } from '../nav';
import { readHelpConfig } from './config';
import { cleanPath, SUPPORT_TAG } from './contact';
import { HelpMenu } from './HelpMenu';
import { ProblemAlert } from './ProblemAlert';
import { connectorGuideUrl, HELP_ROUTES, helpUrlFor, problemHelpUrl } from './routes';

/**
 * P1-ST6-T02 ลิงก์ "คู่มือ" จากทุกหน้า + ลิงก์วิธีแก้ของ error · P1-ST6-T03 ติดต่อทีมงาน
 * ตรวจกับไฟล์ help center จริงที่ commit ไว้ (`packages/help-center/site`) — บทความ/หัวข้อหายหรือเปลี่ยนชื่อ = test แดง
 */
const SITE = resolve(process.cwd(), '../../packages/help-center/site');
const html = (slug: string) =>
  readFileSync(resolve(SITE, slug === 'index' ? 'index.html' : `${slug}.html`), 'utf8');

/** ทุกหน้าที่เข้าได้จากเมนู (รวมรายการโปรดและหน้าย่อยที่ไม่อยู่ในเมนู) */
const navPages = () => {
  const out = new Set<string>();
  for (const g of NAV) {
    if (g.page) out.add(g.page);
    for (const k of g.kids ?? []) out.add(k.page);
  }
  for (const s of SUBPAGES) out.add(s.page);
  return out;
};

const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

afterEach(() => vi.restoreAllMocks());

describe('ลิงก์คู่มือจากทุกหน้า (route → บทความ)', () => {
  it('ทุกหน้าใน NAV มีบทความ · ไม่มีแถวค้างของหน้าที่ไม่มีแล้ว', () => {
    const pages = navPages();
    const missing = [...pages].filter((p) => !HELP_ROUTES[p]);
    expect(missing, `หน้าที่ยังไม่มีลิงก์คู่มือ — เพิ่มใน help/routes.ts`).toEqual([]);
    const stale = Object.keys(HELP_ROUTES).filter((p) => !pages.has(p));
    expect(stale).toEqual([]);
  });

  it('บทความและหัวข้อที่ชี้มีอยู่จริงใน help center', () => {
    for (const [page, target] of Object.entries(HELP_ROUTES)) {
      const src = html(target.slug); // ไม่มีไฟล์ = throw
      if (target.anchor)
        expect(src, `${page} → ${target.slug}#${target.anchor}`).toContain(`id="${target.anchor}"`);
    }
  });

  it('URL ตามค่าตั้ง · หน้าที่ไม่อยู่ในเมนู = หน้าแรกของ help center', () => {
    expect(helpUrlFor('so')).toBe('/help/orders.html');
    expect(helpUrlFor('hold')).toBe('/help/orders.html#hold');
    expect(helpUrlFor(undefined)).toBe('/help/');
    expect(helpUrlFor('unknown')).toBe('/help/');
    expect(helpUrlFor('bill', 'https://help.example.test/')).toBe(
      'https://help.example.test/billing.html',
    );
    expect(
      readHelpConfig({ VITE_HELP_CENTER_URL: 'https://help.example.test' }).helpCenterUrl,
    ).toBe('https://help.example.test/');
  });
});

describe('error → หัวข้อใน catalog', () => {
  it('ตัวอย่าง 422 validation_failed แสดงลิงก์ "ดูวิธีแก้" ไปหัวข้อของรหัสนั้น (มีอยู่จริง)', () => {
    const err = new ApiError({
      type: 'https://docs.tms.example/problems/validation_failed',
      code: 'validation_failed',
      status: 422,
      title: 'Validation failed',
    });
    wrap(<ProblemAlert err={err} text="ข้อมูลไม่ถูกต้อง" />);
    const a = screen.getByRole('link', { name: 'ดูวิธีแก้' });
    expect(a.getAttribute('href')).toBe('/help/errors.html#validation_failed');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(html('errors')).toContain('id="validation_failed"');
    expect(problemHelpUrl('validation_failed')).toBe('/help/errors.html#validation_failed');
  });

  it('error ที่ไม่ใช่ problem+json (เครือข่ายล่ม) = แถบเดิมไม่มีลิงก์', () => {
    wrap(<ProblemAlert err={new Error('network')} text="ระบบขัดข้อง" />);
    expect(screen.getByText('ระบบขัดข้อง')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('คู่มือ error การเชื่อมระบบบัญชีชี้หัวข้อของรหัส', () => {
    expect(connectorGuideUrl('PERIOD_CLOSED')).toBe('/help/connector-errors.html#PERIOD_CLOSED');
    expect(html('connector-errors')).toContain('id="PERIOD_CLOSED"');
  });
});

describe('เมนูคู่มือและติดต่อทีมงาน (แถบบน)', () => {
  const ctx = {
    page: 'hold',
    pageTitle: 'ใบค้าง',
    path: '/so/hold?q=สมชาย#x',
    tenantId: 'ten_abc',
  };

  it('คู่มือหน้านี้ / ศูนย์ช่วยเหลือ เปิดแท็บใหม่', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    wrap(<HelpMenu {...ctx} cfg={readHelpConfig({})} />);
    fireEvent.click(screen.getByRole('button', { name: 'คู่มือและติดต่อทีมงาน' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'คู่มือหน้านี้' }));
    expect(open).toHaveBeenLastCalledWith('/help/orders.html#hold', '_blank', 'noopener');
    fireEvent.click(screen.getByRole('button', { name: 'คู่มือและติดต่อทีมงาน' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'ศูนย์ช่วยเหลือ' }));
    expect(open).toHaveBeenLastCalledWith('/help/', '_blank', 'noopener');
  });

  it('ยังไม่ตั้งช่องทาง (X-04) → ปุ่มติดต่อปิด + ข้อความบอกเหตุ · ไม่มีค่าเดา', () => {
    const cfg = readHelpConfig({
      VITE_SUPPORT_EMAIL: 'ไม่ใช่อีเมล',
      VITE_SUPPORT_LINE_OA: 'no-at',
    });
    expect(cfg.supportEmail).toBeUndefined();
    expect(cfg.supportLineOa).toBeUndefined();
    // review: อีเมลที่พา query ไปด้วย (ฉีด cc/bcc ใน mailto) ต้องไม่ผ่าน
    for (const bad of ['support@x.co?cc=evil', 'a%40b@x.co', 'a@x.co#x', 'a/b@x.co', 'a=b@x.co'])
      expect(readHelpConfig({ VITE_SUPPORT_EMAIL: bad }).supportEmail, bad).toBeUndefined();
    expect(readHelpConfig({ VITE_SUPPORT_EMAIL: 'help+tms@example.co.th' }).supportEmail).toBe(
      'help+tms@example.co.th',
    );
    wrap(<HelpMenu {...ctx} cfg={cfg} />);
    fireEvent.click(screen.getByRole('button', { name: 'คู่มือและติดต่อทีมงาน' }));
    const b = screen.getByRole('menuitem', { name: 'ติดต่อทีมงาน' }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(screen.getByText(/ยังไม่ได้ตั้งช่องทางติดต่อทีมงาน/)).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'ติดต่อทีมงานทางอีเมล' })).toBeNull();
  });

  it('อีเมล: ถึง support · หัวเรื่องมีป้าย + รหัสบริษัท · เนื้อความมีหน้าที่เปิด (ไม่มี query/hash) · ไม่มีข้อมูลผู้ใช้', () => {
    const cfg = readHelpConfig({
      VITE_SUPPORT_EMAIL: 'support@example.test',
      VITE_SUPPORT_LINE_OA: '@example',
    });
    wrap(<HelpMenu {...ctx} cfg={cfg} />);
    fireEvent.click(screen.getByRole('button', { name: 'คู่มือและติดต่อทีมงาน' }));
    // คลิก = window.location.assign(mailto) — jsdom ไม่รองรับการเปลี่ยนหน้า จึงตรวจปลายทางจาก data-href
    const url = screen
      .getByRole('menuitem', { name: 'ติดต่อทีมงานทางอีเมล' })
      .getAttribute('data-href')!;
    expect(url.startsWith('mailto:support@example.test?subject=')).toBe(true);
    const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(q.get('subject')).toBe(`${SUPPORT_TAG} ติดต่อทีมงาน · รหัสบริษัท ten_abc`);
    expect(q.get('body')).toContain('รหัสบริษัท: ten_abc');
    expect(q.get('body')).toContain('หน้าที่เปิดอยู่: ใบค้าง (/so/hold)');
    expect(url).not.toContain(encodeURIComponent('สมชาย'));
  });

  it('LINE OA: ข้อความร่างถึงบัญชีทางการพร้อมรหัสบริษัท', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const cfg = readHelpConfig({ VITE_SUPPORT_LINE_OA: '@example' });
    wrap(<HelpMenu {...ctx} cfg={cfg} />);
    fireEvent.click(screen.getByRole('button', { name: 'คู่มือและติดต่อทีมงาน' }));
    expect(screen.queryByRole('menuitem', { name: 'ติดต่อทีมงานทางอีเมล' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'ติดต่อทีมงานทาง LINE' }));
    const url = open.mock.calls[0]![0] as string;
    expect(url.startsWith('https://line.me/R/oaMessage/%40example/?')).toBe(true);
    expect(decodeURIComponent(url.split('/?')[1]!)).toContain('รหัสบริษัท: ten_abc');
  });

  it('cleanPath ตัด query/hash', () => {
    expect(cleanPath('/pay?tab=over#x')).toBe('/pay');
    expect(cleanPath('')).toBe('/');
  });
});
