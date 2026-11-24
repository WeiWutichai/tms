import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { OfferView } from '../features/trips/useTrips';
import type { PodDo, PodLinkPod, PodStop, PodView } from './podLinkApi';

/** Q-LINK แจ้งรับ/ส่งไม่สำเร็จ หรือรับบางส่วน พร้อมเหตุผล + รูป ผ่านลิงก์รถร่วม (D-81 · D68-39; PO 24 พ.ย. 2569) */
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
/** ST4-T09 หลักฐานของ DO — ค่าเริ่ม = ยังส่งไม่ได้ (ยังไม่ถึงจุดส่ง) · checklist ค่าระบบ (รูป ≥ 1 + ลายเซ็น บังคับ) */
const podOf = (o: Partial<PodLinkPod> = {}): PodLinkPod => ({
  mode: null,
  sent: false,
  podStatus: 'NONE',
  photosMax: 5,
  fields: [
    { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
    { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
    { key: 'note', type: 'NOTE', level: 'ENABLED' },
  ],
  lines: [],
  rejectReasons: [],
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
  pod: podOf(),
  failReasons: [],
});
const pv = (o: Partial<PodView> = {}): PodView => ({
  job,
  tripStatus: 'DISPATCHED',
  recordable: true,
  doHint: 'DO-2611-00069',
  query: null,
  match: null,
  sent: [],
  serverTime: new Date().toISOString(),
  ...o,
});

let base: PodView = pv();
let search: Record<string, PodView> = {};
const mutateAsync = vi.fn();
const captureAsync = vi.fn();
const upload = vi.fn();
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
    usePodCapture: () => ({ mutateAsync: captureAsync, isPending: false }),
    uploadPodLinkFile: (...a: unknown[]) => upload(...a),
  };
});
const { PodLinkPage } = await import('./PodLink');
const { podFailTarget, podFailReasons, podFailMissing } = await import('./podLinkApi');

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

const R = (o: Partial<PodDo['failReasons'][number]>): PodDo['failReasons'][number] => ({
  id: 'rsn_x',
  category: 'DELIVERY_FAILED',
  label: 'x',
  requiresNote: false,
  requiresPhoto: false,
  ...o,
});
const reasons = [
  R({ id: 'rsn_closed', label: 'ลูกค้าปิดทำการ' }),
  R({ id: 'rsn_addr', label: 'ที่อยู่ผิด', requiresPhoto: true, requiresNote: true }),
  R({
    id: 'rsn_ref',
    category: 'REJECTED_BY_RECEIVER',
    label: 'สินค้าเสียหาย',
    requiresPhoto: true,
  }),
];
const withR = (m: PodDo): PodDo => ({ ...m, failReasons: reasons });

describe('podFailTarget / podFailReasons / podFailMissing', () => {
  it('จุดรับยังไม่ถึง = รับของไม่ได้ (FAIL) อย่างเดียว · ถึงแล้ว = รับบางส่วน (COMPLETE PARTIAL) + รับไม่ได้ (COMPLETE FAILED)', () => {
    expect(podFailTarget(doc())!.kinds.map((k) => [k.key, k.type, k.outcome])).toEqual([
      ['pickupFailed', 'FAIL', null],
    ]);
    const t = podFailTarget(doc({ status: 'ARRIVED' }))!;
    expect(t.stop.role).toBe('PICKUP');
    expect(t.kinds.map((k) => [k.key, k.type, k.outcome, k.photos])).toEqual([
      ['pickupPartial', 'COMPLETE', 'PARTIAL', false],
      ['pickupFailed', 'COMPLETE', 'FAILED', true],
    ]);
  });
  it('จุดส่ง: หลังจุดรับปิดสำเร็จ · ยังไม่ถึง = FAIL · ถึงแล้ว = COMPLETE · ปิดแล้ว/จุดรับไม่สำเร็จ = ไม่มี', () => {
    const p = doc({ status: 'COMPLETED' }, { status: 'PENDING' });
    expect(podFailTarget(p)!.kinds.map((k) => [k.key, k.type, k.outcome])).toEqual([
      ['dropFailed', 'FAIL', null],
      ['dropRetain', 'FAIL', 'UNDELIVERED_RETAIN'],
    ]);
    const a = doc({ status: 'COMPLETED' }, { status: 'ARRIVED' });
    expect(podFailTarget(a)!.kinds.map((k) => [k.type, k.outcome])).toEqual([
      ['COMPLETE', 'FAILED'],
      ['COMPLETE', 'UNDELIVERED_RETAIN'],
    ]);
    expect(podFailTarget(doc({ status: 'COMPLETED' }, { status: 'COMPLETED' }))).toBeNull();
    expect(podFailTarget(doc({ status: 'FAILED' }))).toBeNull();
  });
  it('เหตุผล: ของยังอยู่บนรถ = DELIVERY_FAILED เท่านั้น · รับบางส่วนซ่อนเหตุผลบังคับรูป', () => {
    const [partial, failed] = podFailTarget(doc({ status: 'ARRIVED' }))!.kinds;
    expect(podFailReasons(reasons, partial!).map((r) => r.id)).toEqual(['rsn_closed']);
    expect(podFailReasons(reasons, failed!)).toHaveLength(3);
    const retain = podFailTarget(doc({ status: 'COMPLETED' }, { status: 'ARRIVED' }))!.kinds[1]!;
    expect(podFailReasons(reasons, retain).map((r) => r.id)).toEqual(['rsn_closed', 'rsn_addr']);
  });
  it('ข้อที่ขาด: ตัวเลือก → เหตุผล → รายละเอียด → รูป', () => {
    const k = podFailTarget(doc())!.kinds[0]!;
    expect(podFailMissing(null, undefined, '', 0)).toBe('kind');
    expect(podFailMissing(k, undefined, '', 0)).toBe('reason');
    expect(podFailMissing(k, reasons[1], '', 0)).toBe('note');
    expect(podFailMissing(k, reasons[1], 'ป้ายไม่ตรง', 0)).toBe('photo');
    expect(podFailMissing(k, reasons[1], 'ป้ายไม่ตรง', 1)).toBeNull();
    expect(podFailMissing(k, reasons[0], '', 0)).toBeNull();
  });
});

describe('หน้าลิงก์: ฟอร์มแจ้งไม่สำเร็จ (Q-LINK)', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    upload.mockReset();
    search = {};
    base = pv();
  });
  const at = (m: PodDo) => {
    search['DO-2611-00069'] = pv({ query: 'DO-2611-00069', match: m });
  };

  it('ส่งไม่สำเร็จที่จุดส่ง (ถึงแล้ว) พร้อมเหตุผลบังคับรูป + รายละเอียด → COMPLETE FAILED + failurePhotos · toast', async () => {
    at(
      withR({
        ...doc({ status: 'COMPLETED' }, { status: 'ARRIVED' }),
        pod: podOf({ mode: 'CLOSE' }),
      }),
    );
    upload.mockResolvedValueOnce('doc_1');
    mutateAsync.mockResolvedValueOnce({ counted: true, occurredAt: '2026-11-24T03:15:00Z' });
    show();
    await type('DO-2611-00069');
    fireEvent.click(screen.getByTestId('pdl-fail-open'));
    expect(screen.getByText('แจ้งปัญหาที่จุดส่ง')).toBeTruthy();
    // ยังไม่เลือก → ข้อความ
    fireEvent.click(screen.getByTestId('pdl-fail-ok'));
    expect(screen.getByTestId('pdl-fail-err').textContent).toBe('เลือกสิ่งที่เกิดขึ้นก่อน');
    fireEvent.click(screen.getByRole('button', { name: 'ส่งไม่สำเร็จ' }));
    fireEvent.click(screen.getByRole('button', { name: 'ที่อยู่ผิด' }));
    expect(screen.getByText('รูปประกอบ (ต้องแนบอย่างน้อย 1 รูป)')).toBeTruthy();
    fireEvent.change(screen.getByTestId('pdl-fail-note'), { target: { value: 'ป้ายไม่ตรง' } });
    fireEvent.click(screen.getByTestId('pdl-fail-ok'));
    expect(screen.getByTestId('pdl-fail-err').textContent).toBe(
      'เหตุผลนี้ต้องแนบรูปอย่างน้อย 1 รูป',
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    const f = new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('pdl-fail-photo-input'), { target: { files: [f] } });
    });
    await waitFor(() => expect(screen.getByText('รูปที่ 1')).toBeTruthy());
    expect(upload).toHaveBeenCalledWith('ml1.p', 'DO-2611-00069', f, 'POD_PHOTO', 'a.jpg');
    await act(async () => {
      fireEvent.click(screen.getByTestId('pdl-fail-ok'));
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const arg = mutateAsync.mock.calls[0]![0];
    expect(arg.stopId).toBe('stp_d');
    expect(arg.body).toMatchObject({
      type: 'COMPLETE',
      outcome: 'FAILED',
      reasonCodeId: 'rsn_addr',
      note: 'ป้ายไม่ตรง',
      failurePhotos: { doNo: 'DO-2611-00069', photoDocumentIds: ['doc_1'] },
    });
    expect(arg.body.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^แจ้งแล้ว ·/));
  });

  it('จุดรับยังไม่ถึง: รับของไม่ได้ (FAIL) ตัวเลือกเดียวเลือกให้เลย · ไม่แนบรูป = ไม่ส่ง failurePhotos · 422 photo_required แสดงข้อความ', async () => {
    at(withR(doc()));
    mutateAsync.mockRejectedValueOnce(
      new ApiError({
        status: 422,
        code: 'validation_failed',
        title: 'x',
        errors: [{ field: 'reasonCodeId', code: 'photo_required', message: 'x' }],
      } as never),
    );
    show();
    await type('DO-2611-00069');
    fireEvent.click(screen.getByTestId('pdl-fail-open'));
    expect(screen.getByText('แจ้งปัญหาที่จุดรับ')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'รับของไม่ได้' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ลูกค้าปิดทำการ' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('pdl-fail-ok'));
    });
    const arg = mutateAsync.mock.calls[0]![0];
    expect(arg).toMatchObject({
      stopId: 'stp_p',
      body: { type: 'FAIL', reasonCodeId: 'rsn_closed' },
    });
    expect(arg.body.failurePhotos).toBeUndefined();
    expect(arg.body.outcome).toBeUndefined();
    expect(screen.getByTestId('pdl-fail-err').textContent).toBe(
      'เหตุผลนี้ต้องแนบรูปอย่างน้อย 1 รูป',
    );
  });

  it('รับบางส่วน: ไม่มีช่องรูป · ย้อนกลับล้างฟอร์ม', async () => {
    at(withR(doc({ status: 'ARRIVED' })));
    show();
    await type('DO-2611-00069');
    fireEvent.click(screen.getByTestId('pdl-fail-open'));
    fireEvent.click(screen.getByRole('button', { name: 'รับของได้บางส่วน' }));
    expect(screen.queryByRole('button', { name: 'ที่อยู่ผิด' })).toBeNull();
    expect(screen.queryByTestId('pdl-fail-photos')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
    expect(screen.getByTestId('pdl-fail-open')).toBeTruthy();
  });

  it('แจ้งไม่สำเร็จแล้ว → กล่อง "แจ้งไม่สำเร็จแล้ว" (ไม่ใช่ "ส่ง POD แล้ว") และไม่มีปุ่มแจ้งซ้ำ · ลิงก์ดูอย่างเดียวไม่มีปุ่ม', async () => {
    at(
      withR({ ...doc({ status: 'COMPLETED' }, { status: 'FAILED' }), pod: podOf({ sent: true }) }),
    );
    show();
    await type('DO-2611-00069');
    expect(screen.getByTestId('pdl-fail-done')).toBeTruthy();
    expect(screen.queryByTestId('pdl-pod-sent')).toBeNull();
    expect(screen.queryByTestId('pdl-fail-open')).toBeNull();
  });

  it('งานยังไม่ปล่อยรถ (recordable = false) → ไม่มีปุ่มแจ้งไม่สำเร็จ', async () => {
    base = pv({ recordable: false, tripStatus: 'ASSIGNED' });
    search['DO-2611-00069'] = pv({
      recordable: false,
      tripStatus: 'ASSIGNED',
      query: 'DO-2611-00069',
      match: withR(doc()),
    });
    show();
    await type('DO-2611-00069');
    expect(screen.getByTestId('pdl-do')).toBeTruthy();
    expect(screen.queryByTestId('pdl-fail-open')).toBeNull();
  });
});

describe('ชื่อเหตุผลซ้ำข้ามหมวด', () => {
  it('"อื่น ๆ" ของหมวดปฏิเสธรับต่อท้าย "(ปฏิเสธรับ)"', async () => {
    search = {
      'DO-2611-00069': pv({
        query: 'DO-2611-00069',
        match: {
          ...doc({ status: 'COMPLETED' }, { status: 'ARRIVED' }),
          failReasons: [
            R({ id: 'o1', label: 'อื่น ๆ' }),
            R({ id: 'o2', label: 'อื่น ๆ', category: 'REJECTED_BY_RECEIVER' }),
          ],
        },
      }),
    };
    show();
    await type('DO-2611-00069');
    fireEvent.click(screen.getByTestId('pdl-fail-open'));
    fireEvent.click(screen.getByRole('button', { name: 'ส่งไม่สำเร็จ' }));
    expect(screen.getByRole('button', { name: 'อื่น ๆ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'อื่น ๆ (ปฏิเสธรับ)' })).toBeTruthy();
  });
});
