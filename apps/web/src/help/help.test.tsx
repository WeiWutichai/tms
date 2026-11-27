import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import { NAV, SUBPAGES } from '../nav';
import { readHelpConfig } from './config';
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
});
