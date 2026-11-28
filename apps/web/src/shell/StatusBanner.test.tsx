import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { method: string; path: string }[] = [];
const res = (data: unknown) =>
  Promise.resolve({ data, error: undefined, response: new Response(null, { status: 200 }) });
vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>();
  const handle = (method: string) => (path: string) => {
    calls.push({ method, path });
    if (path === '/v1/me/billing-admins') return res({ data: [{ name: 'เจ้าของ บริษัท' }] });
    if (path === '/v1/me/billing-admins/notify')
      return res({ notified: 1, alreadyRequested: false });
    return res({});
  };
  return { ...real, api: { GET: handle('GET'), POST: handle('POST') } };
});
import { I18nProvider } from '../i18n';
import { pickBanner, StatusBanner, type BannerInput } from './StatusBanner';

const base = (
  o: Partial<BannerInput> & { acc?: Partial<BannerInput['account']> } = {},
): BannerInput => ({
  impersonating: o.impersonating ?? false,
  status: o.status ?? 'active',
  account: {
    trialEndsAt: null,
    trialDaysLeft: null,
    pastDueSince: null,
    readOnlyInDays: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    vehicles: { active: 3, limit: 20 },
    accountingSoftware: null,
    ...o.acc,
  },
});

function show(input: BannerInput, canManageBilling = true) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <MemoryRouter>
          <StatusBanner
            input={input}
            tenantId="ten_x"
            planName="มาตรฐาน"
            canManageBilling={canManageBilling}
            yearStyle="BE"
          />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('แถบสถานะบัญชี (P1-ST1-T05 · PLT-050)', () => {
  beforeEach(() => {
    localStorage.clear();
    calls.length = 0;
  });

  it('ลำดับ PLT-050: read_only > past_due > pending > trial ≤ 7 > quota > trial > 7 > cancelAtPeriodEnd', () => {
    const quota = { vehicles: { active: 18, limit: 20 }, cancelAtPeriodEnd: true };
    expect(pickBanner(base({ status: 'read_only', acc: quota }))).toBe('read_only');
    expect(pickBanner(base({ status: 'past_due', acc: { ...quota, readOnlyInDays: 4 } }))).toBe(
      'past_due',
    );
    expect(pickBanner(base({ status: 'pending_verification', acc: quota }))).toBe('pending');
    expect(pickBanner(base({ status: 'trialing', acc: { ...quota, trialDaysLeft: 7 } }))).toBe(
      'trial_soon',
    );
    expect(pickBanner(base({ status: 'trialing', acc: { ...quota, trialDaysLeft: 8 } }))).toBe(
      'quota',
    );
    expect(pickBanner(base({ status: 'trialing', acc: { trialDaysLeft: 8 } }))).toBe('trial');
    expect(pickBanner(base({ acc: { cancelAtPeriodEnd: true } }))).toBe('cancel');
    expect(pickBanner(base())).toBeNull();
    // quota < 90% ไม่ขึ้น · ไม่จำกัด (null) ไม่ขึ้น
    expect(pickBanner(base({ acc: { vehicles: { active: 17, limit: 20 } } }))).toBeNull();
    expect(pickBanner(base({ acc: { vehicles: { active: 99, limit: null } } }))).toBeNull();
  });

  it('เกณฑ์ตรวจรับ: past_due วันที่ 3 + impersonation → ไม่แสดงแถบสถานะ (เห็นเฉพาะแถบส้ม impersonation)', () => {
    const input = base({
      impersonating: true,
      status: 'past_due',
      acc: { pastDueSince: '2026-11-25', readOnlyInDays: 5 },
    });
    expect(pickBanner(input)).toBeNull();
    const { container } = show(input);
    expect(container.querySelector('[data-banner]')).toBeNull();
  });

  it('past_due: ข้อความต้นแบบ + ปุ่ม "ชำระเงิน" สำหรับผู้จัดการแพ็กเกจ · ปิดไม่ได้', () => {
    show(base({ status: 'past_due', acc: { pastDueSince: '2026-11-25', readOnlyInDays: 5 } }));
    expect(screen.getByText('ค้างชำระ · เหลือ 5 วันก่อนเป็นอ่านอย่างเดียว')).toBeInTheDocument();
    expect(screen.getByText('ใบแจ้งค่าบริการ TMS ครบกำหนด 25 พ.ย. 2569')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ชำระเงิน' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ปิดแถบนี้' })).toBeNull();
  });

  it('ผู้ไม่มีสิทธิ์ billing: "แจ้งผู้ดูแลระบบ" → dialog ชื่อผู้ดูแล (ไม่มีอีเมล) → ส่งแจ้งผ่านระบบ · Esc ปิด', async () => {
    show(base({ status: 'read_only' }), false);
    expect(screen.queryByRole('button', { name: 'ชำระเงิน' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'แจ้งผู้ดูแลระบบ' }));
    const dlg = screen.getByRole('dialog', { name: 'แจ้งผู้ดูแลระบบ' });
    expect(await screen.findByText('เจ้าของ บริษัท')).toBeInTheDocument();
    expect(dlg.textContent).not.toContain('@');
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ส่งอีเมลแจ้ง' }));
    expect(await screen.findByText('ส่งแจ้งเตือนและอีเมลถึงผู้ดูแลแล้ว')).toBeInTheDocument();
    expect(calls).toContainEqual({ method: 'POST', path: '/v1/me/billing-admins/notify' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('past_due ที่ไม่มีวันครบกำหนด (ทีมงานตั้งเอง) → หัวข้อไม่มีจำนวนวัน', () => {
    show(base({ status: 'past_due' }));
    expect(screen.getByText('ค้างชำระค่าบริการ TMS')).toBeInTheDocument();
    expect(screen.queryByText(/เหลือ 0 วัน/)).toBeNull();
  });

  it('trial หมดวันนี้ (เหลือ 0) → "หมดวันนี้" · pending มีปุ่ม "ดูสถานะ" ทุกสิทธิ์', () => {
    const r = show(base({ status: 'trialing', acc: { trialDaysLeft: 0 } }));
    expect(
      screen.getByText('ทดลองใช้แพ็กเกจ มาตรฐาน หมดวันนี้ — เลือกแพ็กเกจเพื่อใช้งานต่อ'),
    ).toBeInTheDocument();
    r.unmount();
    show(base({ status: 'pending_verification' }), false);
    expect(screen.getByRole('button', { name: 'ดูสถานะ' })).toBeInTheDocument();
  });

  it('trial > 7 วัน ปิดได้ → ซ่อนทั้งวัน (กลับมาวันถัดไป) · ข้อความ R-02 เมื่อไม่มีโปรแกรมบัญชี', () => {
    const input = base({
      status: 'trialing',
      acc: {
        trialDaysLeft: 12,
        trialEndsAt: '2026-12-09T17:00:00.000Z',
        accountingSoftware: 'none',
      },
    });
    const r = show(input);
    expect(screen.getByText('ทดลองใช้แพ็กเกจ มาตรฐาน เหลือ 12 วัน')).toBeInTheDocument();
    expect(screen.getByText(/ถึง 10 ธ\.ค\. 2569/)).toHaveTextContent(
      'ใบกำกับภาษีและใบเสร็จออกจากโปรแกรมบัญชีของคุณ',
    );
    fireEvent.click(screen.getByRole('button', { name: 'ปิดแถบนี้' }));
    expect(r.container.querySelector('[data-banner]')).toBeNull();
    r.unmount();
    expect(show(input).container.querySelector('[data-banner]')).toBeNull();
  });

  it('trial ≤ 7 วัน ปิดไม่ได้', () => {
    show(base({ status: 'trialing', acc: { trialDaysLeft: 3 } }));
    expect(
      screen.getByText('ทดลองใช้แพ็กเกจ มาตรฐาน เหลือ 3 วัน — เลือกแพ็กเกจเพื่อใช้งานต่อ'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ปิดแถบนี้' })).toBeNull();
  });
});
