import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { OfferView } from '../features/trips/useTrips';
import type { PodDo, PodStop, PodView } from './podLinkApi';

/** ST4-T08 หน้าลิงก์งานของรถร่วม (ต้นแบบ TMS Subcon แท็บ "ส่ง POD" + ปุ่มสถานะ S4) */
const job: OfferView = {
  company: 'ศรีไทยขนส่ง',
  carrierName: 'หจก. ศรีราชาโลจิสติกส์',
  status: 'ACCEPTED',
  tripNo: 'TRP-6911-0004',
  tripDate: '2026-11-18',
  pickupAt: null,
  origin: 'บางปู',
  destination: 'แหลมฉบัง',
  customerName: 'บจก. เอ็นเอสเอฟ อินดัสทรี',
  vehicleTypeName: '6 ล้อ',
  weightKg: '8600',
  buyAmount: '5600.00',
  terms: { whtRate: null, paymentTermDays: 15, requirePodToPay: true },
  contactName: null,
  expiresAt: new Date().toISOString(),
  serverTime: new Date().toISOString(),
  accepted: { plate: '74-5521', driverName: 'สมชาย ใจดี' },
  rejectReason: null,
  rejectReasons: [],
  podUrl: 'https://app.example/link/pod/ml1.p',
};
const stop = (o: Partial<PodStop>): PodStop => ({
  id: 'stp_p',
  role: 'PICKUP',
  sequence: 1,
  siteName: 'คลังบางปู',
  status: 'PENDING',
  outcome: null,
  arrivedAt: null,
  leftAt: null,
  nextStopId: 'stp_d',
  nextOpen: true,
  ...o,
});
const doc = (p: Partial<PodStop> = {}, d: Partial<PodStop> = {}): PodDo => ({
  doNo: 'DO-2611-00069',
  doDate: '2026-11-18',
  customerName: 'บจก. เอ็นเอสเอฟ อินดัสทรี',
  pickup: stop(p),
  delivery: stop({
    id: 'stp_d',
    role: 'DELIVERY',
    sequence: 2,
    siteName: 'ท่าเรือแหลมฉบัง ประตู 3',
    nextStopId: null,
    nextOpen: false,
    ...d,
  }),
  retries: [],
});
const pv = (o: Partial<PodView> = {}): PodView => ({
  job,
  tripStatus: 'DISPATCHED',
  recordable: true,
  doHint: 'DO-2611-00069',
  query: null,
  match: null,
  serverTime: new Date().toISOString(),
  ...o,
});

let base: PodView = pv();
let search: Record<string, PodView> = {};
const mutateAsync = vi.fn();
vi.mock('./podLinkApi', async (orig) => {
  const real = await orig<typeof import('./podLinkApi')>();
  return {
    ...real,
    currentPosition: () => Promise.resolve(null),
    usePodView: (_t: string, doNo: string | null) => ({
      data: doNo ? search[doNo] : base,
      error: null,
      isError: false,
      isLoading: false,
      refetch: vi.fn(),
    }),
    usePodEvent: () => ({ mutateAsync, isPending: false }),
  };
});
const { PodLinkPage } = await import('./PodLink');
const { nextPodAction, podHint, podClientEventId, normalizeDoNo, stopState, retryOf } =
  await import('./podLinkApi');

const show = () =>
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={['/link/pod/ml1.p']}>
        <Routes>
          <Route path="/link/pod/:token" element={<PodLinkPage />} />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
const type = async (v: string) => {
  fireEvent.change(screen.getByTestId('pdl-q'), { target: { value: v } });
  await act(() => new Promise((r) => setTimeout(r, 350)));
};

describe('podLinkApi (ST4-T08)', () => {
  it('ปุ่มถัดไป: ถึงจุดรับ → ออกจากจุดรับ (ปิดงานจุดรับ + DEPART จุดถัดไป) → ถึงจุดส่ง → ไม่มีปุ่ม (รอ POD)', () => {
    expect(nextPodAction(doc())).toEqual({
      key: 'arrivePickup',
      steps: [{ stopId: 'stp_p', type: 'ARRIVE' }],
    });
    expect(nextPodAction(doc({ status: 'ARRIVED' }))).toEqual({
      key: 'leavePickup',
      steps: [
        { stopId: 'stp_p', type: 'COMPLETE' },
        { stopId: 'stp_d', type: 'DEPART' },
      ],
    });
    // ผู้จัดรถปิดจุดรับแทนแล้ว ยังไม่ออก → DEPART อย่างเดียว
    expect(nextPodAction(doc({ status: 'COMPLETED' }))?.steps).toEqual([
      { stopId: 'stp_d', type: 'DEPART' },
    ]);
    expect(
      nextPodAction(doc({ status: 'COMPLETED', leftAt: '2026-11-18T03:00:00Z', nextOpen: false }))
        ?.key,
    ).toBe('arriveDrop');
    const atDrop = doc(
      { status: 'COMPLETED', leftAt: 'x', nextOpen: false },
      { status: 'ARRIVED' },
    );
    expect(nextPodAction(atDrop)).toBeNull();
    expect(podHint(atDrop)).toBe('atDrop');
    // multi-drop: ส่งแล้ว มีจุดถัดไป → ออกจากจุดส่ง
    expect(
      nextPodAction(
        doc(
          { status: 'COMPLETED', leftAt: 'x', nextOpen: false },
          { status: 'COMPLETED', nextStopId: 'stp_3', nextOpen: true },
        ),
      ),
    ).toEqual({ key: 'leaveDrop', steps: [{ stopId: 'stp_3', type: 'DEPART' }] });
    expect(nextPodAction(doc({ status: 'FAILED' }))).toBeNull();
    expect(podHint(doc({ status: 'FAILED' }))).toBe('pickupFailed');
  });

  it('QA M1: จุดถัดไปไม่ว่าง (ถึงแล้ว/มี DEPART) → ไม่เสนอ DEPART ที่จะขัดลำดับ', () => {
    // จุดรับถึงแล้วแต่จุดส่งถึงไปก่อน → ออกจากจุดรับ = ปิดงานจุดรับอย่างเดียว
    expect(
      nextPodAction(doc({ status: 'ARRIVED', nextOpen: false }, { status: 'ARRIVED' })),
    ).toEqual({
      key: 'leavePickup',
      steps: [{ stopId: 'stp_p', type: 'COMPLETE' }],
    });
    // ส่งแล้ว แต่จุดถัดไปมี event แล้ว → ไม่มีปุ่มออก
    expect(
      nextPodAction(
        doc(
          { status: 'COMPLETED', nextOpen: false },
          { status: 'COMPLETED', nextStopId: 'stp_3', nextOpen: false },
        ),
      ),
    ).toBeNull();
  });

  it('clientEventId คงที่ต่อ (ลิงก์, จุด, ชนิด) รูป UUID v4 · normalizeDoNo · ป้ายสถานะ', async () => {
    const step = { stopId: 'stp_p', type: 'ARRIVE' as const };
    expect(await podClientEventId('ml1.p', step, 0)).toBe(await podClientEventId('ml1.p', step));
    expect(await podClientEventId('ml1.p', step, 1)).not.toBe(
      await podClientEventId('ml1.p', step),
    );
    expect(retryOf({ ...doc(), retries: [{ stopId: 'stp_p', type: 'ARRIVE', n: 2 }] }, step)).toBe(
      2,
    );
    const a = await podClientEventId('ml1.p', { stopId: 'stp_p', type: 'ARRIVE' });
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await podClientEventId('ml1.p', { stopId: 'stp_p', type: 'ARRIVE' })).toBe(a);
    expect(await podClientEventId('ml1.p', { stopId: 'stp_p', type: 'COMPLETE' })).not.toBe(a);
    expect(await podClientEventId('ml1.q', { stopId: 'stp_p', type: 'ARRIVE' })).not.toBe(a);
    expect(normalizeDoNo(' do-2611-000๖๙ ')).toBe('DO-2611-00069');
    expect(stopState(stop({ status: 'COMPLETED', leftAt: 'x' })).key).toBe('LEFT');
    expect(stopState(stop({ status: 'COMPLETED' })).key).toBe('PICKED');
    expect(stopState(stop({ role: 'DELIVERY', status: 'COMPLETED', leftAt: 'x' })).key).toBe(
      'DELIVERED',
    );
  });
});

describe('PodLinkPage (ST4-T08)', () => {
  beforeEach(() => {
    base = pv();
    search = {};
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
  });

  it('หัวพอร์ทัล + แท็บ งาน/ส่ง POD (เริ่มที่ ส่ง POD) · แท็บงานแสดงใบสั่งงาน + รับงานแล้ว', () => {
    show();
    expect(screen.getByText('ศรีไทยขนส่ง · พอร์ทัลรถร่วม')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'ส่ง POD' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('อัปโหลดหลักฐานการส่ง')).toBeTruthy();
    expect(screen.getByPlaceholderText('เช่น DO-2611-00069')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'งาน' }));
    expect(screen.getByText('TRP-6911-0004')).toBeTruthy();
    expect(screen.getByText('รถ 74-5521 · สมชาย ใจดี')).toBeTruthy();
  });

  it('ค้นไม่พบ → ⌕ "ไม่พบเลข DO นี้" + ตัวช่วย', async () => {
    search['DO-1'] = pv({ query: 'DO-1', match: null });
    show();
    await type('do-1');
    expect(screen.getByTestId('pdl-nf').textContent).toContain('ไม่พบเลข DO นี้');
    expect(screen.getByTestId('pdl-nf').textContent).toContain(
      'ตรวจเลขบนใบส่งของ หรือดู DO-2611-00069',
    );
  });

  it('ค้นพบ → การ์ด DO + แถวจุด + กด "ถึงจุดรับ" ส่ง ARRIVE พร้อม clientEventId/เวลา +07:00 → toast', async () => {
    search['DO-2611-00069'] = pv({ query: 'DO-2611-00069', match: doc() });
    show();
    await type('DO-2611-00069');
    expect(screen.getByTestId('pdl-do').textContent).toContain(
      'คลังบางปู → ท่าเรือแหลมฉบัง ประตู 3',
    );
    expect(screen.getByTestId('pdl-stop-PICKUP').textContent).toContain('ยังไม่ถึง');
    fireEvent.click(screen.getByRole('button', { name: 'ถึงจุดรับ' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const call = mutateAsync.mock.calls[0]![0];
    expect(call.stopId).toBe('stp_p');
    expect(call.body).toMatchObject({ type: 'ARRIVE' });
    expect(call.body.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.body.occurredAt).toMatch(/\+07:00$/);
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/^บันทึกถึงจุดรับแล้ว/),
    );
  });

  it('ออกจากจุดรับ = COMPLETE (DELIVERED) แล้ว DEPART จุดถัดไป · ล้ม → ข้อความให้ลองใหม่', async () => {
    search['DO-2611-00069'] = pv({
      query: 'DO-2611-00069',
      match: doc({ status: 'ARRIVED', arrivedAt: '2026-11-18T02:42:00Z' }),
    });
    show();
    await type('DO-2611-00069');
    expect(screen.getByTestId('pdl-stop-PICKUP').textContent).toContain('ถึงแล้ว 09:42 น.');
    mutateAsync
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new ApiError({ type: '', title: '', status: 500, code: 'internal' }));
    fireEvent.click(screen.getByRole('button', { name: 'ออกจากจุดรับ' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync.mock.calls[0]![0]).toMatchObject({
      stopId: 'stp_p',
      body: { type: 'COMPLETE', outcome: 'DELIVERED' },
    });
    expect(mutateAsync.mock.calls[1]![0]).toMatchObject({
      stopId: 'stp_d',
      body: { type: 'DEPART' },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'บันทึกไม่สำเร็จ ตรวจสัญญาณแล้วลองอีกครั้ง (ต้องออนไลน์)',
      ),
    );
  });

  it('QA M2: event ไม่ถูกนับ (ธง) → "บันทึกแล้ว · รอฝ่ายจัดรถตรวจสอบ" · retries → clientEventId รอบใหม่', async () => {
    search['DO-2611-00069'] = pv({
      query: 'DO-2611-00069',
      match: { ...doc(), retries: [{ stopId: 'stp_p', type: 'ARRIVE', n: 1 }] },
    });
    mutateAsync.mockResolvedValue({ counted: false, occurredAt: '2026-11-18T01:00:00Z' });
    show();
    await type('DO-2611-00069');
    fireEvent.click(screen.getByRole('button', { name: 'ถึงจุดรับ' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('บันทึกแล้ว · รอฝ่ายจัดรถตรวจสอบ'),
    );
    const { podClientEventId: id } = await import('./podLinkApi');
    expect(mutateAsync.mock.calls[0]![0].body.clientEventId).toBe(
      await id('ml1.p', { stopId: 'stp_p', type: 'ARRIVE' }, 1),
    );
  });

  it('QA L2: ส่งล้มแล้วโหลดใหม่พบว่าบันทึกแล้ว (ปุ่มถัดไปเปลี่ยน) → ล้างข้อความแดง', async () => {
    search['DO-2611-00069'] = pv({ query: 'DO-2611-00069', match: doc() });
    mutateAsync.mockRejectedValueOnce(new Error('network'));
    const r = show();
    await type('DO-2611-00069');
    fireEvent.click(screen.getByRole('button', { name: 'ถึงจุดรับ' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    search['DO-2611-00069'] = pv({
      query: 'DO-2611-00069',
      match: doc({ status: 'ARRIVED', arrivedAt: '2026-11-18T02:42:00Z' }),
    });
    r.rerender(
      <I18nProvider>
        <MemoryRouter initialEntries={['/link/pod/ml1.p']}>
          <Routes>
            <Route path="/link/pod/:token" element={<PodLinkPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button', { name: 'ออกจากจุดรับ' })).toBeTruthy();
  });

  it('ยังไม่ปล่อยรถ → ไม่มีปุ่ม + แถบรอฝ่ายจัดรถ', async () => {
    search['DO-2611-00069'] = pv({
      query: 'DO-2611-00069',
      match: doc(),
      recordable: false,
      tripStatus: 'ASSIGNED',
    });
    show();
    await type('DO-2611-00069');
    expect(screen.getByTestId('pdl-locked').textContent).toBe(
      'ยังกดสถานะไม่ได้ — รอฝ่ายจัดรถปล่อยงาน',
    );
    expect(screen.queryByTestId('pdl-act')).toBeNull();
  });
});
