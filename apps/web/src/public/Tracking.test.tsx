import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { TrackingShipment, TrackingView } from './trackingApi';

/** ST4-T14 หน้าติดตามของผู้รับ (ต้นแบบ TMS Tracking.dc.html) */
const steps = (n: number): TrackingShipment['steps'] =>
  ['ACCEPTED', 'DEPARTED', 'IN_TRANSIT', 'DELIVERED'].map((key, i) => ({
    key,
    done: i < n,
    at: i < n ? `2026-11-18T0${i}:10:00Z` : null,
  }));
const ship = (o: Partial<TrackingShipment> = {}): TrackingShipment => ({
  doNo: 'DO-2611-00060',
  customerName: 'บจก. สยามพลาสติก',
  customerRef: 'PO-45861',
  status: 'IN_TRANSIT',
  steps: steps(3),
  eta: { from: '2026-11-18T03:30:00Z', to: '2026-11-18T04:00:00Z', basis: 'PLAN' },
  deliveredAt: null,
  doDate: '2026-11-18',
  route: { from: 'สมุทรปราการ', to: 'ชลบุรี' },
  vehicle: { typeName: 'รถ 6 ล้อ', plateMasked: '70-12xx กทม.' },
  items: [{ description: 'เม็ดพลาสติก PP', qty: '120', unit: 'ถุง', qtyDelivered: null }],
  pod: null,
  updatedAt: '2026-11-18T02:15:00Z',
  ...o,
});

let view: { data?: TrackingView; error: unknown; isError: boolean; isLoading: boolean };
const mutateAsync = vi.fn();
vi.mock('./trackingApi', async (orig) => {
  const real = await orig<typeof import('./trackingApi')>();
  return {
    ...real,
    useTrackingView: () => view,
    useTrackingLookup: () => ({ mutateAsync, isPending: false }),
  };
});
const { TrackingPage } = await import('./Tracking');
const { stepViews, telHref } = await import('./trackingApi');

const company = { name: 'ศรีไทยขนส่ง', phone: '02-118-4400' };
const show = () =>
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/t/ml1.x']}>
        <Routes>
          <Route path="/t/:token" element={<TrackingPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
const ok = (v: TrackingView) => ({ data: v, error: null, isError: false, isLoading: false });

describe('trackingApi (ST4-T14)', () => {
  it('stepper ตามต้นแบบ: ขั้นปัจจุบันน้ำเงินตัวหนา · ขั้นที่ผ่าน = check · ส่งแล้วทุกขั้นเสร็จ · ส่งไม่สำเร็จขั้นสุดท้ายแดง', () => {
    const a = stepViews(ship());
    expect(a.map((x) => x.icon)).toEqual(['check', 'check', 'navigation', 'package-check']);
    expect(a[2]).toMatchObject({ bg: '#2257C4', lc: '#2257C4', fw: 600, lineR: '#E5E7EB' });
    expect(a[3]).toMatchObject({
      bg: '#FFFFFF',
      bd: '#D1D5DB',
      lc: '#6B7280',
      lineR: 'transparent',
    });
    const d = stepViews(ship({ status: 'DELIVERED', steps: steps(4) }));
    expect(d.map((x) => x.icon)).toEqual(['check', 'check', 'check', 'check']);
    expect(d[3]).toMatchObject({ fw: 500, lc: '#111827' });
    const f = stepViews(ship({ status: 'FAILED', steps: steps(4) }));
    expect(f[3]).toMatchObject({ label: 'FAILED', icon: 'x', bg: '#B3322A', lc: '#B3322A' });
    const c = stepViews(ship({ status: 'CANCELLED', steps: steps(0) }));
    expect(c.every((x) => x.bg === '#FFFFFF')).toBe(true);
    expect(telHref('02-118 4400')).toBe('tel:021184400');
  });
});

describe('TrackingPage (ST4-T14)', () => {
  beforeEach(() => mutateAsync.mockReset());

  it('ลิงก์ต่อ DO: หัวแบรนด์บริษัท · ป้ายสถานะ · ETA ช่วงเวลาตามแผน · ทะเบียนปิด · ปุ่มโทร = เบอร์บริษัท · ไม่มีราคา', () => {
    view = ok({ company, mode: 'SHIPMENT', shipment: ship() });
    show();
    expect(screen.getByTestId('trk-company').textContent).toBe('ศรีไทยขนส่ง');
    expect(screen.getByTestId('trk-badge').textContent).toBe('กำลังส่ง');
    expect(screen.getByTestId('trk-eta').textContent).toContain('คาดว่าจะถึง');
    expect(screen.getByTestId('trk-eta').textContent).toContain('10:30–11:00 น.');
    expect(screen.getByTestId('trk-vehicle').textContent).toContain('70-12xx กทม.');
    expect(screen.getByRole('link', { name: /02-118-4400/ }).getAttribute('href')).toBe(
      'tel:021184400',
    );
    expect(screen.getByTestId('trk-refs').textContent).toContain('PO-45861');
    expect(screen.getByTestId('trk-items').textContent).toContain('120 ถุง');
    expect(screen.getByText('มีคำถามเกี่ยวกับการจัดส่ง ติดต่อ 02-118-4400')).toBeTruthy();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain(
      'noindex',
    );
    expect(document.body.textContent).not.toMatch(/บาท|฿/);
  });

  it('ส่งแล้ว + POD: ส่งถึงแล้ว (เขียว) · รูป/ลายเซ็น/ชื่อผู้รับ · ส่งจริงน้อยกว่าแผน', () => {
    view = ok({
      company: { name: 'ศรีไทยขนส่ง', phone: null },
      mode: 'SHIPMENT',
      shipment: ship({
        status: 'DELIVERED',
        steps: steps(4),
        eta: null,
        deliveredAt: '2026-11-18T02:32:00Z',
        items: [{ description: 'เม็ดพลาสติก PP', qty: '120', unit: 'ถุง', qtyDelivered: '110' }],
        pod: {
          receiverName: 'คุณสมศรี',
          recordedAt: '2026-11-18T02:35:00Z',
          photos: [{ url: 'https://api.example/p1', expiresAt: '2026-11-18T03:00:00Z' }],
          signature: { url: 'https://api.example/s', expiresAt: '2026-11-18T03:00:00Z' },
        },
      }),
    });
    show();
    const eta = screen.getByTestId('trk-eta').textContent!;
    expect(eta).toContain('ส่งถึงแล้ว');
    expect(eta).toContain('09:32 น.');
    expect(eta).toContain('ส่งถึง ชลบุรี วันที่ 18 พ.ย. 2569');
    expect(screen.getByTestId('trk-items').textContent).toContain('ส่งจริง 110 ถุง');
    const pod = screen.getByTestId('trk-pod');
    expect(pod.textContent).toContain('ผู้รับ คุณสมศรี · 09:35 น.');
    expect(screen.getByAltText('รูปหลักฐานการส่ง 1').getAttribute('referrerpolicy')).toBe(
      'no-referrer',
    );
    expect(screen.getByAltText('ลายเซ็นผู้รับ')).toBeTruthy();
    // ไม่มีเบอร์บริษัท → ไม่มีปุ่มโทร
    expect(screen.queryByRole('link', { name: /tel/ })).toBeNull();
    expect(screen.getByText('มีคำถามเกี่ยวกับการจัดส่ง ติดต่อบริษัทขนส่ง')).toBeTruthy();
  });

  it('ส่งไม่สำเร็จ → "บริษัทจะติดต่อกลับ" · ยกเลิก → "งานนี้ถูกยกเลิก"', () => {
    view = ok({
      company,
      mode: 'SHIPMENT',
      shipment: ship({ status: 'FAILED', steps: steps(4), eta: null, vehicle: null }),
    });
    const { unmount } = show();
    expect(screen.getByTestId('trk-eta').textContent).toContain('บริษัทจะติดต่อกลับ');
    expect(screen.getAllByText('ส่งไม่สำเร็จ').length).toBeGreaterThan(0);
    unmount();
    view = ok({
      company,
      mode: 'SHIPMENT',
      shipment: ship({ status: 'CANCELLED', steps: steps(0), eta: null, vehicle: null }),
    });
    show();
    expect(screen.getByTestId('trk-eta').textContent).toContain('งานนี้ถูกยกเลิก');
  });

  it('ลิงก์ของลูกค้า: ค้นเลข PO + เบอร์ 4 ตัวท้าย → แสดงสถานะ · ไม่พบ/ล็อก → ข้อความ · ค้นเลขอื่น', async () => {
    view = ok({ company, mode: 'SEARCH', shipment: null });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'ติดตาม' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'กรอกเลขอย่างน้อย 3 ตัว และเบอร์โทร 4 ตัวท้าย',
    );
    expect(mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('เลขใบส่งของ หรือเลข PO'), {
      target: { value: ' PO-45861 ' },
    });
    fireEvent.change(screen.getByLabelText('เบอร์โทรผู้รับ 4 ตัวท้าย'), {
      target: { value: '45a07' },
    });
    expect((screen.getByLabelText('เบอร์โทรผู้รับ 4 ตัวท้าย') as HTMLInputElement).value).toBe(
      '4507',
    );
    mutateAsync.mockRejectedValueOnce(
      new ApiError({ code: 'not_found', status: 404, title: '', type: '' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ติดตาม' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('ไม่พบข้อมูล ตรวจเลขและเบอร์โทรอีกครั้ง'),
    );
    expect(mutateAsync).toHaveBeenCalledWith({ ref: 'PO-45861', phoneLast4: '4507' });
    mutateAsync.mockRejectedValueOnce(
      new ApiError({ code: 'rate_limited', status: 429, title: '', type: '' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ติดตาม' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('ค้นหาผิดหลายครั้ง กรุณาลองใหม่ภายหลัง'),
    );
    mutateAsync.mockResolvedValueOnce(ship());
    fireEvent.click(screen.getByRole('button', { name: 'ติดตาม' }));
    await waitFor(() => expect(screen.getByTestId('trk-badge').textContent).toBe('กำลังส่ง'));
    fireEvent.click(screen.getByRole('button', { name: 'ค้นหาเลขอื่น' }));
    expect(screen.getByRole('button', { name: 'ติดตาม' })).toBeTruthy();
  });

  it('ลิงก์ใช้ไม่ได้ (404) → "ลิงก์นี้ใช้ไม่ได้"', () => {
    view = {
      data: undefined,
      error: new ApiError({ code: 'not_found', status: 404, title: '', type: '' }),
      isError: true,
      isLoading: false,
    };
    show();
    expect(screen.getByRole('alert').textContent).toContain('ลิงก์นี้ใช้ไม่ได้');
    expect(screen.queryByRole('button', { name: 'ติดตาม' })).toBeNull();
  });
});
