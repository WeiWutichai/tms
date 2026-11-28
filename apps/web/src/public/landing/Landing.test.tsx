import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { readLandingConfig, type LandingConfig } from './config';
import { en } from '../../i18n/en';
import { LANDING_CATALOGS } from '../../i18n/landing.gen';
import { th } from '../../i18n/th';
import { zh } from '../../i18n/zh';
import { LandingPage, landingNav } from './Landing';
import { plansApi, type PublicPlans } from './plans';
import fixture from '../pricing/plans.fixture.json';
import { LandingRoot } from './LandingRoot';

const plansData = fixture as unknown as PublicPlans;

/** plans: null = pricing.publicVisible = false (ค่าเริ่ม — D-40) */
function renderLanding(
  config: LandingConfig = readLandingConfig({}),
  plans: PublicPlans | null = null,
) {
  return render(
    <I18nProvider lang="th">
      <LandingPage config={config} plans={plans} />
    </I18nProvider>,
  );
}
/** ข้อความทั้งหน้า + alt ของรูป (เกณฑ์ "ไม่มีข้อความอ้างฟีเจอร์นอกเฟส" ต้องครอบคำบรรยายรูปด้วย) */
const pageText = (c: HTMLElement) =>
  [c.textContent ?? '', ...[...c.querySelectorAll('img')].map((i) => i.alt)].join('\n');

// ภาษาที่ test สลับถูกเก็บใน localStorage ของ jsdom (Node 20/22) — ล้างทุก test ไม่ให้ค้างไป test ถัดไป
afterEach(() => {
  document.title = '';
  localStorage.clear();
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

  it('ราคาซ่อนเมื่อ pricing.publicVisible = false (GET /v1/public/plans → 404 — D-40) — ไม่มีเมนูราคา / ดูราคา / แถบราคา / FAQ คิดเงิน', () => {
    const { container } = renderLanding();
    const text = pageText(container);
    expect(text).not.toMatch(/ราคา(?!ขาซื้อ|\s?฿5,800)/);
    expect(text).not.toMatch(/คิดเงินอย่างไร|ต่อรถต่อเดือน/);
    expect(container.querySelector('a[href="/pricing"]')).toBeNull();
  });

  it('เปิดราคา (P1-ST2-T02 — ค่าจาก API): เมนูราคา, ดูราคา → /pricing, แถบ "เริ่ม ฿… ต่อรถต่อเดือน" จากแพ็กเกจแรก, FAQ คิดเงิน', () => {
    const go = vi.spyOn(landingNav, 'go').mockImplementation(() => undefined);
    renderLanding(readLandingConfig({}), plansData);
    fireEvent.click(screen.getByRole('button', { name: 'ราคา' }));
    expect(go).toHaveBeenLastCalledWith('/pricing');
    expect(screen.getByRole('link', { name: 'ดูราคา →' })).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('link', { name: 'ดูราคาทั้งหมด →' })).toHaveAttribute(
      'href',
      '/pricing',
    );
    expect(screen.getByText('เริ่ม ฿350 ต่อรถต่อเดือน')).toBeTruthy();
    expect(screen.getByRole('button', { name: /คิดเงินอย่างไร/ })).toBeInTheDocument();
    go.mockRestore();
  });

  it('โหลดราคาจาก API เอง: 404 = ซ่อน · 200 = แสดง · ผิดพลาด = ซ่อน', async () => {
    const spy = vi.spyOn(plansApi, 'fetch').mockResolvedValueOnce(plansData);
    const view = render(
      <I18nProvider lang="th">
        <LandingPage config={readLandingConfig({})} />
      </I18nProvider>,
    );
    expect(await screen.findByText('เริ่ม ฿350 ต่อรถต่อเดือน')).toBeTruthy();
    view.unmount();
    spy.mockRejectedValueOnce(new Error('x'));
    const v2 = render(
      <I18nProvider lang="th">
        <LandingPage config={readLandingConfig({})} />
      </I18nProvider>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(v2.container.querySelector('a[href="/pricing"]')).toBeNull();
    spy.mockRestore();
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

  it('หน้าสมัครยังไม่เปิด (ค่าเริ่ม): ปุ่มทดลองใช้แสดงช่องทางติดต่อ ไม่พาไป /signup · เปิดแล้ว (VITE_SIGNUP_LIVE) → /signup', () => {
    const go = vi.spyOn(landingNav, 'go').mockImplementation(() => undefined);
    const { unmount } = renderLanding(
      readLandingConfig({ VITE_PUBLIC_CONTACT_EMAIL: 'sales@example.test' }),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'ทดลองใช้ฟรี 30 วัน' })[0]!);
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'เปิดรับสมัครเร็ว ๆ นี้ · ติดต่อ sales@example.test',
    );
    expect(screen.getByRole('link', { name: 'ทดลองใช้ฟรี' })).toHaveAttribute('href', '#contact');
    fireEvent.click(screen.getAllByRole('button', { name: 'เข้าสู่ระบบ' })[0]!);
    expect(go).toHaveBeenLastCalledWith('/login');
    unmount();

    renderLanding(readLandingConfig({ VITE_SIGNUP_LIVE: 'true' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'ทดลองใช้ฟรี 30 วัน' })[0]!);
    expect(go).toHaveBeenLastCalledWith('/signup');
    expect(screen.getByRole('link', { name: 'ทดลองใช้ฟรี' })).toHaveAttribute('href', '/signup');
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
      // P1-ST2-T03: + หน้าสมัคร (`su.*`) + error code ที่หน้าสมัครแสดง (รายการใน scripts/build-i18n.mjs)
      const got = LANDING_CATALOGS[lang] as Record<string, string>;
      const problems = Object.keys(got).filter((k) => k.startsWith('problem.'));
      if (lang === 'th')
        expect(problems, lang).toEqual(
          expect.arrayContaining(['problem.account_exists', 'problem.otp_locked']),
        );
      const want = Object.fromEntries(
        Object.entries(catalogs[lang]).filter(
          ([k]) =>
            k.startsWith('land.') ||
            k.startsWith('pub.') ||
            k.startsWith('su.') ||
            problems.includes(k),
        ),
      );
      expect(got, lang).toEqual(want);
    }
  });

  it('LandingRoot (bundle แยก) แสดงหน้าได้ด้วยชุดย่อย — ไม่มีชื่อ key หลุดบนจอ', () => {
    vi.spyOn(plansApi, 'fetch').mockResolvedValue(null);
    const { container } = render(<LandingRoot />);
    expect(container.textContent).not.toMatch(/\bland\.[a-z]|\bpub\.[a-z]/);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('จัดรถ ตามงาน เก็บ POD');
  });
});
