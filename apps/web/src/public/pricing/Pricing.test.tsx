import { estimatePlanCharge, vatEstimate, type BillingCycle } from '@tms/domain';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { readLandingConfig, type LandingConfig } from '../landing/config';
import { fmtMoney, plansApi, type PublicPlans } from '../landing/plans';
import { landingNav } from '../landing/PublicShell';
import fixture from './plans.fixture.json';
import { PricingPage } from './Pricing';
import { PricingRoot } from './PricingRoot';

const data = fixture as unknown as PublicPlans;

function renderPricing(plans: PublicPlans | null | undefined = data, config?: LandingConfig) {
  return render(
    <I18nProvider lang="th">
      <PricingPage plans={plans} config={config ?? readLandingConfig({})} />
    </I18nProvider>,
  );
}
const month = () => screen.getByTestId('calc-month').textContent;
const setN = (n: number) =>
  fireEvent.change(screen.getAllByRole('textbox', { name: /จำนวนรถ active/ })[0]!, {
    target: { value: String(n) },
  });
const plan = (code: string) => data.plans.find((p) => p.code === code)!;
/** ยอดที่ควรเห็น = ผลของ domain (ไม่คำนวณซ้ำใน test) */
const domainMonth = (code: string, n: number, cycle: BillingCycle) =>
  `฿${fmtMoney(estimatePlanCharge(plan(code), n, cycle)!.monthly)} / เดือน`;

afterEach(() => {
  document.title = '';
  vi.restoreAllMocks();
});

/**
 * P1-ST2-T02 — หน้าราคาสาธารณะตามต้นแบบ TMS Signup view `pricing`
 * เกณฑ์ตรวจรับ: รถ 30 คัน → ราคาบนเครื่องคำนวณ = ผลจาก domain (ตารางกรณี รวมขั้นต่ำ + รายปี) ·
 * เซลล์ตารางเปรียบเทียบ (✓ / ซื้อเพิ่ม / ตัวเลข / —) มาจาก matrix · ซ่อนทั้งหน้าเมื่อ pricing.publicVisible = false
 */
describe('หน้าราคา (P1-ST2-T02)', () => {
  it('โครงต้นแบบ: ป้ายทดลอง, หัวข้อ, toggle รายเดือน/รายปี, การ์ดจากข้อมูล, คำนวณค่าใช้จ่าย, เปรียบเทียบแพ็กเกจ, FAQ', () => {
    renderPricing();
    expect(screen.getByText('ทดลอง 30 วัน ไม่ต้องใช้บัตร')).toBeTruthy();
    expect(screen.getByText('ราคาตั้งต้น — ยังไม่ประกาศ')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'จ่ายตามจำนวนรถที่วิ่งจริงในเดือน',
    );
    expect(screen.getByRole('button', { name: 'รายเดือน' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /รายปี/ })).toHaveTextContent('รายปีลด 15%');
    expect(screen.getByRole('heading', { name: 'คำนวณค่าใช้จ่าย' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'เปรียบเทียบแพ็กเกจ' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'คำถามที่พบบ่อย' })).toBeInTheDocument();
    // การ์ด: ราคา/ช่วงรถ/ขั้นต่ำจากข้อมูล (docs/02 §2) · ป้าย "นิยม" จาก plan.badge
    const growth = within(screen.getByTestId('plan-std'));
    expect(growth.getByText('นิยม')).toBeTruthy();
    expect(growth.getByText('฿280')).toBeTruthy();
    expect(growth.getByText('รถ active 16–60 คัน')).toBeTruthy();
    expect(growth.getByText('ขั้นต่ำ ฿4,500 / เดือน · ผู้ใช้ไม่จำกัด')).toBeTruthy();
    expect(growth.getByRole('button', { name: 'เริ่มทดลองใช้ 30 วัน' })).toBeTruthy();
    expect(growth.getByText('+ Customer portal')).toBeTruthy();
    expect(growth.getByText('Open API (req/นาที): 300')).toBeTruthy();
    const ent = within(screen.getByTestId('plan-ent'));
    expect(ent.getAllByText('ติดต่อฝ่ายขาย').length).toBe(2);
    expect(ent.getByText('รถ active 201 คันขึ้นไป')).toBeTruthy();
    expect(within(screen.getByTestId('plan-start')).getAllByText(/ไม่มีในแพ็กเกจนี้/)).toHaveLength(
      2,
    );
  });

  it('รายปี: ราคาต่อรถ − ส่วนลดรายปี และหมายเหตุต่อปี', () => {
    renderPricing();
    fireEvent.click(screen.getByRole('button', { name: /รายปี/ }));
    expect(within(screen.getByTestId('plan-start')).getByText('฿297.50')).toBeTruthy();
    expect(within(screen.getByTestId('plan-std')).getByText('฿238')).toBeTruthy();
    expect(within(screen.getByTestId('plan-biz')).getByText('฿187')).toBeTruthy();
    expect(
      within(screen.getByTestId('plan-std')).getByText('จ่ายรายปี ฿2,856 / รถ · ลด 15%'),
    ).toBeTruthy();
  });

  it.each([
    // [รถ, รอบ, แพ็กเกจที่เลือกอัตโนมัติตามช่วงรถ]
    [30, 'monthly', 'std'],
    [30, 'annual', 'std'],
    [5, 'monthly', 'start'], // ขั้นต่ำ 2,500
    [5, 'annual', 'start'], // ขั้นต่ำ − 15%
    [15, 'annual', 'start'],
    [16, 'monthly', 'std'], // 4,480 < ขั้นต่ำ 4,500
    [61, 'monthly', 'biz'], // 13,420 < ขั้นต่ำ 13,500
    [150, 'annual', 'biz'],
  ] as const)(
    'เครื่องคำนวณ %i คัน %s → แพ็กเกจ %s = ผลจาก estimatePlanCharge',
    (n, cycle, code) => {
      renderPricing();
      if (cycle === 'annual') fireEvent.click(screen.getByRole('button', { name: /รายปี/ }));
      setN(n);
      expect(screen.getByRole('button', { name: plan(code).nameTh, pressed: true })).toBeTruthy();
      expect(month()).toBe(domainMonth(code, n, cycle));
      const out = within(screen.getByTestId('calc-result'));
      // ราคายังไม่รวม VAT + VAT เป็นประมาณการ (vatEstimate — VAT_RATE_7 ของ domain)
      const inclMonth = vatEstimate(estimatePlanCharge(plan(code), n, cycle)!.monthly).total;
      expect(
        out.getByText(`ราคายังไม่รวม VAT · รวม VAT ≈ ฿${fmtMoney(inclMonth)} / เดือน`),
      ).toBeTruthy();
      const est = estimatePlanCharge(plan(code), n, cycle)!;
      expect(!!out.queryByText('ต่ำกว่าขั้นต่ำ · คิดขั้นต่ำต่อเดือน')).toBe(est.minimumApplied);
      expect(out.getByText(`฿${fmtMoney(est.yearly)}`)).toBeTruthy();
    },
  );

  it('รถ 30 คัน = ฿8,400.00 / เดือน (docs/02 §7) · รายปี ฿7,140.00 · VAT 7% เป็นประมาณการ', () => {
    renderPricing();
    setN(30);
    expect(month()).toBe('฿8,400.00 / เดือน');
    const out = within(screen.getByTestId('calc-result'));
    expect(out.getByText('ราคายังไม่รวม VAT · รวม VAT ≈ ฿8,988.00 / เดือน')).toBeTruthy();
    expect(out.getByText('VAT 7% ของยอดต่อปี (ประมาณการ)')).toBeTruthy();
    expect(out.getByText('฿7,056.00')).toBeTruthy();
    expect(out.getByText('ต่อปี รวม VAT (ประมาณการ)')).toBeTruthy();
    expect(out.getByText('฿107,856.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /รายปี/ }));
    expect(month()).toBe('฿7,140.00 / เดือน');
    expect(screen.getByText('ส่วนลดรายปี 15%')).toBeTruthy();
  });

  it('กดแพ็กเกจนอกช่วงรถ → ย้ายจำนวนรถเข้าช่วง · Enterprise = ติดต่อฝ่ายขาย', () => {
    renderPricing();
    setN(5);
    fireEvent.click(screen.getByRole('button', { name: 'Business', pressed: false }));
    expect(screen.getAllByRole('textbox', { name: /จำนวนรถ active/ })[0]).toHaveValue('61');
    expect(month()).toBe(domainMonth('biz', 61, 'monthly'));
    fireEvent.click(screen.getByRole('button', { name: 'Enterprise', pressed: false }));
    expect(month()).toBe('ติดต่อฝ่ายขาย');
    expect(screen.getByText('ราคาตามจำนวนรถและบริการ')).toBeTruthy();
  });

  it('ตารางเปรียบเทียบ: เซลล์มาจาก matrix (✓ / ซื้อเพิ่ม / ตัวเลข / ไม่จำกัด / —) ตามหมวด', () => {
    renderPricing();
    const cells = (key: string) =>
      within(screen.getByTestId(`row-${key}`))
        .getAllByRole('cell')
        .slice(1)
        .map((c) => (c.querySelector('[role="img"]') ? '✓' : c.textContent));
    expect(cells('multi')).toEqual(['—', '—', '✓', '✓']);
    expect(cells('portal')).toEqual(['ซื้อเพิ่ม', '✓', '✓', '✓']);
    expect(cells('api')).toEqual(['—', '300', '1,000', '1,000']);
    expect(cells('conn')).toEqual(['—', '1', '1', 'ไม่จำกัด']);
    expect(cells('settle')).toEqual(['✓', '✓', '✓', '✓']);
    for (const cat of ['ปฏิบัติการ', 'บัญชี', 'รายงานและลูกค้า', 'เชื่อมต่อ', 'โควตา'])
      expect(screen.getByRole('cell', { name: cat })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'ฟีเจอร์',
      'Starter',
      'Growth',
      'Business',
      'Enterprise',
    ]);
  });

  it('FAQ: ไม่อ้างแอปคนขับ / ใบกำกับภาษี / Open API / AI · วันเก็บข้อมูลจากค่าตั้ง · กฎ "รายปีลด 15%"', () => {
    const { container } = renderPricing();
    const faq = container.querySelector('.prc-faq')!;
    const texts: string[] = [];
    for (const q of within(faq as HTMLElement).getAllByRole('button')) {
      if (q.getAttribute('aria-expanded') === 'false') fireEvent.click(q);
      texts.push(faq.textContent ?? '');
    }
    const all = texts.join('\n');
    for (const banned of [
      /แอปคนขับ/,
      /ใบกำกับภาษี/,
      /Open API/,
      /\bAI\b/,
      /MCP/,
      /SAP B1/,
      /Express/,
    ])
      expect(all, String(banned)).not.toMatch(banned);
    expect(all).toMatch(/เก็บข้อมูลไว้ 90 วัน/);
    expect(all).toMatch(/รายปีลด 15%/);
    expect(all).toMatch(/เชื่อมตรงกับ PEAK, FlowAccount และ KRS/);
  });

  it('ปิดหน้าราคา (404 → null) → กลับ /home ไม่แสดงราคา', () => {
    const go = vi.spyOn(landingNav, 'go').mockImplementation(() => undefined);
    const { container } = renderPricing(null);
    expect(go).toHaveBeenCalledWith('/home');
    expect(container.textContent).not.toMatch(/฿|ราคา/);
  });

  it('โหลดจาก API: 404 → กลับ /home · ผิดพลาด → ลองอีกครั้ง', async () => {
    const go = vi.spyOn(landingNav, 'go').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(plansApi, 'fetch').mockResolvedValueOnce(null);
    const view = render(<PricingRoot />);
    await waitFor(() => expect(go).toHaveBeenCalledWith('/home'));
    view.unmount();
    fetchSpy.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(data);
    render(<PricingRoot />);
    fireEvent.click(await screen.findByRole('button', { name: 'ลองอีกครั้ง' }));
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      'จ่ายตามจำนวนรถที่วิ่งจริงในเดือน',
    );
  });

  it('สมัครยังไม่เปิด: ปุ่มทดลองใช้แสดงช่องทางติดต่อ · เปิดแล้ว → /signup?plan=… · ติดต่อฝ่ายขาย → ช่องทางติดต่อ', () => {
    const go = vi.spyOn(landingNav, 'go').mockImplementation(() => undefined);
    const { unmount } = renderPricing(
      data,
      readLandingConfig({ VITE_PUBLIC_CONTACT_EMAIL: 'sales@example.test' }),
    );
    fireEvent.click(
      within(screen.getByTestId('plan-std')).getByRole('button', { name: 'เริ่มทดลองใช้ 30 วัน' }),
    );
    expect(go).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'เปิดรับสมัครเร็ว ๆ นี้ · ติดต่อ sales@example.test',
    );
    fireEvent.click(within(screen.getByTestId('plan-ent')).getByRole('button'));
    expect(screen.getByRole('status')).toHaveTextContent('sales@example.test');
    // เมนู "ราคา" on ในหน้านี้
    expect(screen.getByRole('button', { name: 'ราคา' })).toHaveAttribute('aria-current', 'page');
    unmount();
    renderPricing(data, readLandingConfig({ VITE_SIGNUP_LIVE: 'true' }));
    fireEvent.click(
      within(screen.getByTestId('plan-biz')).getByRole('button', { name: 'เริ่มทดลองใช้ 30 วัน' }),
    );
    expect(go).toHaveBeenLastCalledWith('/signup?plan=biz');
  });

  it('SEO: title ของหน้าราคา + canonical /pricing', () => {
    renderPricing();
    expect(document.title).toBe('ราคา TMS — จ่ายตามจำนวนรถที่วิ่งจริงในเดือน');
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/pricing$/,
    );
  });
});
