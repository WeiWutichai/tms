import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** P1-ST1-T06 แถบรถ active บนหน้าทะเบียนรถ (ต้นแบบ v4 vx.showTier) + drawer ทะเบียนที่ถูกนับ + เที่ยวแรก */
let data: Record<string, unknown> = {};
vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  return {
    ...real,
    api: {
      GET: () => Promise.resolve({ data, response: new Response(null, { status: 200 }) }),
    },
  };
});

const { ActiveVehiclesBar } = await import('./ActiveVehiclesBar');

function Host({ plan }: { plan?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <ActiveVehiclesBar
      plan={plan}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
    />
  );
}
const mount = (plan?: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider lang="th">
        <MemoryRouter>
          <Host plan={plan} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );

const ROW = {
  plate: '70-1001',
  plateMissing: false,
  subcontract: false,
  vehicleType: 'หกล้อ',
  carrierName: null,
  trips: 10,
  firstTripId: 'trp_1',
  firstTripNo: 'TRP-2611-0001',
  firstCountedAt: '2026-11-01T01:00:00.000Z',
  adjusted: false,
};

describe('แถบรถ active (P1-ST1-T06)', () => {
  it('ตัวเลขจริง "รถ active เดือนนี้ 1/15 คันตาม tier" + แพ็กเกจ → drawer รายการทะเบียน + เที่ยวแรก', async () => {
    data = {
      period: '2026-11',
      status: 'open',
      finalizedAt: null,
      activeVehicles: 1,
      own: 1,
      subcontract: 0,
      limit: 15,
      data: [ROW],
    };
    mount('Growth');
    const bar = await screen.findByTestId('veh-active-bar');
    expect(bar.textContent).toContain('รถ active เดือนนี้ 1/15 คันตาม tier');
    expect(bar.textContent).toContain('แพ็กเกจ Growth · รถ active สูงสุด 15 คันต่อเดือน');
    fireEvent.click(screen.getByRole('button', { name: /รถ active เดือนนี้/ }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toContain('รถ active พ.ย. 2569');
    const list = screen.getByTestId('usage-list');
    expect(list.textContent).toContain('70-1001 · หกล้อ');
    expect(list.textContent).toContain('10 เที่ยว');
    expect(list.textContent).toContain('วิ่ง 1 พ.ย. 2569');
    const link = screen.getByRole('link', { name: 'TRP-2611-0001' });
    expect(link.getAttribute('href')).toBe('/plan?trip=trp_1');
  });

  it('ไม่จำกัดโควตา → ไม่มีแถบความคืบหน้า · ไม่มีรถ → ข้อความว่าง', async () => {
    data = {
      period: '2026-11',
      status: 'open',
      finalizedAt: null,
      activeVehicles: 0,
      own: 0,
      subcontract: 0,
      limit: null,
      data: [],
    };
    mount('Enterprise');
    const bar = await screen.findByTestId('veh-active-bar');
    expect(bar.textContent).toContain('รถ active เดือนนี้ 0 คัน');
    expect(bar.textContent).toContain('แพ็กเกจ Enterprise');
    fireEvent.click(screen.getByRole('button', { name: /รถ active เดือนนี้/ }));
    expect(await screen.findByTestId('usage-empty')).toBeTruthy();
  });
});
