import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { readLandingConfig, type LandingConfig } from './config';
import { en } from '../../i18n/en';
import { LANDING_CATALOGS } from '../../i18n/landing.gen';
import { th } from '../../i18n/th';
import { zh } from '../../i18n/zh';
import { LandingPage, landingNav } from './Landing';
import { LandingRoot } from './LandingRoot';

function renderLanding(config: LandingConfig = readLandingConfig({})) {
  return render(
    <I18nProvider lang="th">
      <LandingPage config={config} />
    </I18nProvider>,
  );
}
/** ข้อความทั้งหน้า + alt ของรูป (เกณฑ์ "ไม่มีข้อความอ้างฟีเจอร์นอกเฟส" ต้องครอบคำบรรยายรูปด้วย) */
const pageText = (c: HTMLElement) =>
  [c.textContent ?? '', ...[...c.querySelectorAll('img')].map((i) => i.alt)].join('\n');

afterEach(() => {
  document.title = '';
});

/**
 * P1-ST2-T01 — เกณฑ์ "ไม่มีข้อความอ้างฟีเจอร์ที่ §2.2 ระบุว่าไม่อยู่เฟส 1" (R-11) + ข้อความภาษีตาม D-56 (R-02)
 * ตรวจทุก FAQ ที่เปิดอ่านได้ (กางทีละข้อ)
 */
describe('Landing (P1-ST2-T01)', () => {
  it('ค่าเริ่มต้น: ไม่อ้าง AI / MCP / แอปคนขับ / SAP B1 / Express / GPS connector / Open API สาธารณะ / 50 ทวิ', () => {
    const { container } = renderLanding();
    const questions = screen.getAllByRole('button', { expanded: false });
    const answers: string[] = [];
    for (const q of questions) {
      fireEvent.click(q);
      answers.push(pageText(container));
    }
    const all = [pageText(container), ...answers].join('\n');
    for (const banned of [
      /\bAI\b/,
      /MCP/,
      /แอปคนขับ/,
      /ออฟไลน์/,
      /ไม่มีสัญญาณ/,
      /SAP B1/,
      /Express/,
      /Open API/,
      /Webhook/,
      /sandbox/,
      /50 ทวิ/,
      /3 ภาษา/,
      /เชื่อม 6/,
      /Claude|ChatGPT/,
      // GPS DLT = ชนิดเอกสารรถ (มีในเฟส 0) — ห้ามเฉพาะการอ้าง GPS connector/ติดตามรถ (เฟส 2–3)
      /GPS(?! DLT)/,
    ])
      expect(all, String(banned)).not.toMatch(banned);
    // ใบกำกับภาษี/ใบเสร็จ: พูดได้เฉพาะว่า "ออกจากโปรแกรมบัญชีของคุณ" (D-56)
    for (const m of all.matchAll(/ใบกำกับภาษี[^\n]{0,40}/g))
      expect(m[0]).toMatch(/^ใบกำกับภาษีและใบเสร็จออกจากโปรแกรมบัญชีของคุณ/);
    expect(all).not.toMatch(/เอกสารภาษีออกจากระบบได้เอง/);
  });

  it('คงโครงต้นแบบ: hero, เช้าวันหนึ่งของฝ่ายจัดรถ (07:10 / 07:40 / 17:00), Settlement, เอกสารรถ, FAQ, CTA ทดลองใช้ฟรี 30 วัน', () => {
    renderLanding();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'จัดรถ ตามงาน เก็บ POD วางบิล — จบในที่เดียว',
    );
    expect(screen.getByRole('heading', { name: 'เช้าวันหนึ่งของฝ่ายจัดรถ' })).toBeInTheDocument();
    for (const time of ['07:10', '07:40', '17:00']) expect(screen.getByText(time)).toBeTruthy();
    expect(screen.queryByText('06:30')).toBeNull();
    expect(screen.queryByText('13:25')).toBeNull();
    expect(screen.getByText('จ่ายรถร่วมจาก Settlement ไม่ต้องทำ Excel')).toBeTruthy();
    expect(screen.getByText('รถที่เอกสารหมดอายุ จ่ายงานไม่ได้')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'คำถามที่พบบ่อย' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'ทดลองใช้ฟรี 30 วัน' }).length).toBe(3);
    expect(screen.getByText('ใช้คู่กับ FlowAccount, KRS, PEAK และ LINE ได้')).toBeTruthy();
    expect(screen.getByText('เชื่อม 3 โปรแกรมบัญชี/ERP')).toBeTruthy();
    // FAQ ข้อแรกเปิดอยู่ (hfaq: 0 ในต้นแบบ) และรายชื่อระบบบัญชีตามลำดับต้นแบบ
    expect(
      screen.getByText(/เชื่อม PEAK, FlowAccount หรือ KRS หรือส่งออกไฟล์ให้นักบัญชี/),
    ).toBeTruthy();
  });

  it('ราคาซ่อนเมื่อ pricingVisible = false (D-40) — ไม่มีเมนูราคา / ดูราคา / แถบราคา / FAQ คิดเงิน', () => {
    const { container } = renderLanding();
    const text = pageText(container);
    expect(text).not.toMatch(/ราคา(?!ขาซื้อ|\s?฿5,800)/);
    expect(text).not.toMatch(/คิดเงินอย่างไร|ต่อรถต่อเดือน/);
    expect(container.querySelector('a[href="/pricing"]')).toBeNull();
  });

  it('เปิดราคา (ค่าจาก P1-ST1-T04/T02): เมนูราคา, ดูราคา, แถบ "เริ่ม ฿… ต่อรถต่อเดือน", FAQ คิดเงิน', () => {
    renderLanding({ ...readLandingConfig({}), pricingVisible: true, fromPrice: '350' });
    expect(screen.getByRole('button', { name: 'ราคา' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ดูราคา →' })).toHaveAttribute('href', '/pricing');
    expect(screen.getByText('เริ่ม ฿350 ต่อรถต่อเดือน')).toBeTruthy();
    expect(screen.getByRole('button', { name: /คิดเงินอย่างไร/ })).toBeInTheDocument();
  });

  it('ระบบที่เชื่อมได้มาจาก config (เปิด Express เมื่อยืนยันกับ ESG แล้ว — ไม่ต้องแก้โค้ด)', () => {
    renderLanding(
      readLandingConfig({ VITE_LANDING_INTEGRATIONS: 'FlowAccount, Express ,PEAK,LINE' }),
    );
    expect(screen.getByText('ใช้คู่กับ Express, FlowAccount, PEAK และ LINE ได้')).toBeTruthy();
    expect(screen.getByText('เชื่อม 3 โปรแกรมบัญชี/ERP')).toBeTruthy();
  });

  it('ช่องทางติดต่อ: ไม่ตั้ง = ไม่มีเมนูติดต่อ · ตั้งแล้ว = toast + บรรทัดใน footer', () => {
    const { unmount } = renderLanding();
    expect(screen.queryByRole('button', { name: 'ติดต่อ' })).toBeNull();
    unmount();
    renderLanding(
      readLandingConfig({
        VITE_PUBLIC_CONTACT_LINE: '@example',
        VITE_PUBLIC_CONTACT_PHONE: '02-000-0000',
        VITE_PUBLIC_CONTACT_EMAIL: 'sales@example.test',
      }),
    );
    expect(screen.getByText('LINE @example · 02-000-0000')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'ติดต่อ' })[0]!);
    expect(screen.getByRole('status')).toHaveTextContent(
      'LINE @example · 02-000-0000 · sales@example.test',
    );
  });

  it('ปุ่มทดลองใช้ → /signup, เข้าสู่ระบบ → /login (โหลดหน้าใหม่ — landing เป็น bundle แยก)', () => {
    const go = vi.spyOn(landingNav, 'go').mockImplementation(() => undefined);
    renderLanding();
    fireEvent.click(screen.getAllByRole('button', { name: 'ทดลองใช้ฟรี 30 วัน' })[0]!);
    expect(go).toHaveBeenLastCalledWith('/signup');
    fireEvent.click(screen.getAllByRole('button', { name: 'เข้าสู่ระบบ' })[0]!);
    expect(go).toHaveBeenLastCalledWith('/login');
    expect(screen.getAllByRole('link', { name: 'ทดลองใช้ฟรี' })[0]).toHaveAttribute(
      'href',
      '/signup',
    );
    go.mockRestore();
  });

  it('SEO: title + description + og:* ระหว่างอยู่ในหน้า แล้วถอดออกเมื่อออก', () => {
    const view = renderLanding();
    expect(document.title).toBe('TMS — จัดรถ ตามงาน เก็บ POD วางบิล จบในที่เดียว');
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toMatch(
      /^สำหรับบริษัทขนส่ง 10–200 คัน/,
    );
    expect(document.querySelector('meta[property="og:title"]')).not.toBeNull();
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/home$/,
    );
    view.unmount();
    expect(document.querySelector('meta[property="og:title"]')).toBeNull();
  });

  it('สลับภาษา EN จากแถบภาษาในหัวหน้า', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Dispatch, track, collect POD,',
    );
  });
});

describe('ชุดข้อความย่อยของ landing (i18n/landing.gen.ts)', () => {
  it('ตรงกับ th/en/zh ทุก key ที่ landing ใช้ — ถ้าไม่ตรง ให้รัน pnpm --filter @tms/web i18n:build', () => {
    const catalogs = { th, en, zh } as const;
    for (const lang of ['th', 'en', 'zh'] as const) {
      const want = Object.fromEntries(
        Object.entries(catalogs[lang]).filter(
          ([k]) => k.startsWith('land.') || k.startsWith('pub.'),
        ),
      );
      expect(LANDING_CATALOGS[lang], lang).toEqual(want);
    }
  });

  it('LandingRoot (bundle แยก) แสดงหน้าได้ด้วยชุดย่อย — ไม่มีชื่อ key หลุดบนจอ', () => {
    const { container } = render(<LandingRoot />);
    expect(container.textContent).not.toMatch(/\bland\.[a-z]|\bpub\.[a-z]/);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('จัดรถ ตามงาน เก็บ POD');
  });
});
