import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { LockedPage, planPriceText, type MeLock } from './Simple';

/** P1-ST1-T02 หน้าแนะนำโมดูลที่ไม่รวมในแพ็กเกจ — ต้นแบบ v4 `lkp` + PLT-076 "แจ้งผู้ดูแลระบบ" */
const POST = vi.fn();
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: { POST: (p: string, o: unknown) => POST(p, o) },
}));

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function show(lock: MeLock | undefined, canManage: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={['/reports']}>
          <Routes>
            <Route
              path="/reports"
              element={
                <LockedPage feature="report" plan="Starter" lock={lock} canManage={canManage} />
              }
            />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const growth: MeLock = {
  planCode: 'std',
  planName: 'Growth',
  pricePerVehicleMonthly: '1280.00',
  addon: false,
  reason: 'not_in_plan',
};

describe('LockedPage (P1-ST1-T02)', () => {
  beforeEach(() => POST.mockReset());

  it('ราคาแบบต้นแบบ priceL: บาทเต็มใส่ comma · มีสตางค์แสดง 2 ตำแหน่ง', () => {
    expect(planPriceText('1280.00')).toBe('1,280');
    expect(planPriceText('249.50')).toBe('249.50');
  });

  it('ผู้จัดการแพ็กเกจ: ป้าย แพ็กเกจที่มี ราคา · "อัปเกรดเป็นGrowth" และ "เทียบแพ็กเกจ" ไปหน้าแพ็กเกจ', () => {
    show(growth, true);
    expect(screen.getByText('ไม่รวมในแพ็กเกจ Starter')).toBeInTheDocument();
    expect(screen.getByText('Growth')).toBeInTheDocument();
    expect(screen.getByText('฿1,280 / รถ / เดือน')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'แจ้งผู้ดูแลระบบ' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'อัปเกรดเป็น Growth' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/billing?plan=std');
  });

  it('แพ็กเกจปัจจุบันขายเป็น add-on → "ซื้อ Add-on" แทน "อัปเกรด" · ราคาตกลง → "ติดต่อฝ่ายขาย"', () => {
    show({ ...growth, addon: true, pricePerVehicleMonthly: null }, true);
    expect(screen.queryByRole('button', { name: /อัปเกรดเป็น/ })).toBeNull();
    expect(screen.getByText('ติดต่อฝ่ายขาย')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ซื้อ Add-on' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/billing?addon=report');
  });

  it('ผู้ไม่มีสิทธิ์: มีแค่ "แจ้งผู้ดูแลระบบ" → เรียก API แล้วแสดงผล · ซ้ำใน 24 ชม. บอกว่าแจ้งไปแล้ว', async () => {
    POST.mockResolvedValueOnce({
      data: { notified: 2, alreadyRequested: false },
      response: { ok: true, status: 200 },
    });
    show(growth, false);
    expect(screen.queryByRole('button', { name: /อัปเกรดเป็น/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'เทียบแพ็กเกจ' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'แจ้งผู้ดูแลระบบ' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('แจ้งผู้ดูแลระบบแล้ว'),
    );
    expect(POST).toHaveBeenCalledWith('/v1/me/feature-requests', {
      body: { featureKey: 'report' },
    });
    POST.mockResolvedValueOnce({
      data: { notified: 0, alreadyRequested: true },
      response: { ok: true, status: 200 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'แจ้งผู้ดูแลระบบ' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('ไปแล้วภายใน 24 ชั่วโมง'),
    );
  });

  it('ไม่มีแพ็กเกจใดรวมไว้ → ไม่มีการ์ดขวาและปุ่มอัปเกรด (เหลือเทียบแพ็กเกจ)', () => {
    show(
      {
        planCode: null,
        planName: null,
        pricePerVehicleMonthly: null,
        addon: false,
        reason: 'not_in_plan',
      },
      true,
    );
    expect(screen.queryByText('มีในแพ็กเกจ')).toBeNull();
    expect(screen.queryByRole('button', { name: /อัปเกรดเป็น/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'เทียบแพ็กเกจ' })).toBeInTheDocument();
  });

  it('แพ็กเกจรวมอยู่แต่ถูกปิดสิทธิ์ (revoked): ไม่มีปุ่มอัปเกรด/เทียบแพ็กเกจ · บอกให้ติดต่อผู้ให้บริการ', () => {
    const revoked: MeLock = {
      planCode: null,
      planName: null,
      pricePerVehicleMonthly: null,
      addon: false,
      reason: 'revoked',
    };
    show(revoked, true);
    expect(screen.getByText('ปิดใช้งานโดยผู้ให้บริการระบบ')).toBeInTheDocument();
    expect(screen.getByText(/ติดต่อทีมงานผู้ให้บริการ/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /อัปเกรดเป็น/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'เทียบแพ็กเกจ' })).toBeNull();
    expect(screen.queryByText('มีในแพ็กเกจ')).toBeNull();
  });
});
