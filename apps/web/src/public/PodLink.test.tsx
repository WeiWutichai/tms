import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { I18nProvider } from '../i18n';
import type { OfferView } from '../features/trips/useTrips';
import type { PodDo, PodLinkPod, PodStop, PodView } from './podLinkApi';

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
const {
  nextPodAction,
  podHint,
  podClientEventId,
  normalizeDoNo,
  stopState,
  retryOf,
  podLinkMissing,
  podLinkBody,
} = await import('./podLinkApi');

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
        { stopId: 'stp_p', type: 'LOADED' },
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
    // จุดรับถึงแล้วแต่จุดส่งถึงไปก่อน → ออกจากจุดรับ = ขึ้นของเสร็จอย่างเดียว
    expect(
      nextPodAction(doc({ status: 'ARRIVED', nextOpen: false }, { status: 'ARRIVED' })),
    ).toEqual({
      key: 'leavePickup',
      steps: [{ stopId: 'stp_p', type: 'LOADED' }],
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

  it('ออกจากจุดรับ = LOADED (D68-39 ไม่มี outcome) แล้ว DEPART จุดถัดไป · ล้ม → ข้อความให้ลองใหม่', async () => {
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
      body: { type: 'LOADED' },
    });
    expect(mutateAsync.mock.calls[0]![0].body).not.toHaveProperty('outcome');
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

describe('ส่ง POD ผ่านลิงก์ (ST4-T09)', () => {
  const atDropDo = (pod: Partial<PodLinkPod> = {}) =>
    ({
      ...doc(
        { status: 'COMPLETED', leftAt: '2026-11-18T03:00:00Z', nextOpen: false },
        { status: 'ARRIVED' },
      ),
      pod: podOf({ mode: 'CLOSE', ...pod }),
    }) as PodDo;
  const png = (n: number) => new File([`p${n}`], `p${n}.png`, { type: 'image/png' });
  const pickPhotos = async (files: File[]) => {
    fireEvent.change(screen.getByTestId('pdl-photo-input'), { target: { files } });
    await waitFor(() => expect(upload).toHaveBeenCalled());
  };
  const sign = () => fireEvent.pointerDown(screen.getByTestId('pdl-sig'), { pointerId: 1 });

  beforeEach(() => {
    base = pv();
    search = {};
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
    captureAsync.mockReset();
    captureAsync.mockResolvedValue({});
    upload.mockReset();
    let n = 0;
    upload.mockImplementation(() => Promise.resolve(`doc_${String(++n).padStart(32, '0')}`));
    // jsdom ไม่มี canvas — วาดไม่ได้ แต่กดแผ่นเซ็น = เซ็นแล้ว · toBlob คืน PNG จำลอง
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(new Blob(['sig'], { type: 'image/png' }));
    };
  });

  it('podLinkMissing / podLinkBody: ข้อบังคับตาม checklist · ส่งเฉพาะข้อที่ checklist ใช้', () => {
    const fields = [
      ...podOf().fields,
      { key: 'goods_ok', type: 'BOOLEAN', level: 'REQUIRED', label: 'สินค้าครบ' },
      { key: 'pin', type: 'PIN', level: 'REQUIRED', length: 4 },
    ] as PodLinkPod['fields'];
    const d = {
      photos: 0,
      signed: false,
      note: '',
      checks: {},
      choices: {},
      barcodes: '',
      pin: '12',
      rating: null,
    };
    expect(podLinkMissing(fields, d).map((f) => f.key)).toEqual([
      'photo',
      'signature',
      'goods_ok',
      'pin',
    ]);
    const ok = {
      ...d,
      photos: 2,
      signed: true,
      checks: { goods_ok: true, junk: true },
      pin: '4821',
    };
    expect(podLinkMissing(fields, ok)).toEqual([]);
    expect(
      podLinkBody('DO-1', fields, { ...ok, rating: 5 }, { photos: ['a', 'b'], signature: 's' }),
    ).toEqual({
      doNo: 'DO-1',
      photoDocumentIds: ['a', 'b'],
      signatureDocumentId: 's',
      checks: { goods_ok: true },
      pin: '4821',
    });
  });

  it('เกณฑ์ตรวจรับ: ถึงจุดส่ง → รูป 2 ใบ + ลายเซ็น → "ส่ง POD" = COMPLETE + pod ในคำขอเดียว → toast + ล้างช่องค้น', async () => {
    search['DO-2611-00069'] = pv({ query: 'DO-2611-00069', match: atDropDo() });
    show();
    await type('DO-2611-00069');
    expect(screen.queryByTestId('pdl-hint')).toBeNull();
    expect(
      screen.getByText('แนบรูปใบส่งของที่มีลายเซ็นผู้รับ และรูปสินค้าที่ปลายทาง'),
    ).toBeTruthy();
    // ไม่มีรูป → toast ตามต้นแบบ
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect(await screen.findByText('แนบรูปอย่างน้อย 1 รูป')).toBeTruthy();
    expect(mutateAsync).not.toHaveBeenCalled();
    await pickPhotos([png(1), png(2)]);
    await waitFor(() => expect(screen.getByText('รูปที่ 2')).toBeTruthy());
    // ยังไม่เซ็น
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect(await screen.findByText('ให้ผู้รับเซ็นชื่อ')).toBeTruthy();
    sign();
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(upload.mock.calls[2]!.slice(0, 2)).toEqual(['ml1.p', 'DO-2611-00069']);
    expect(upload.mock.calls[2]![3]).toBe('POD_SIGNATURE');
    const call = mutateAsync.mock.calls[0]![0];
    expect(call.stopId).toBe('stp_d');
    expect(call.body).toMatchObject({
      type: 'COMPLETE',
      outcome: 'DELIVERED',
      clientEventId: await podClientEventId('ml1.p', { stopId: 'stp_d', type: 'COMPLETE' }),
      pod: {
        doNo: 'DO-2611-00069',
        photoDocumentIds: [`doc_${'1'.padStart(32, '0')}`, `doc_${'2'.padStart(32, '0')}`],
        signatureDocumentId: `doc_${'3'.padStart(32, '0')}`,
      },
    });
    expect(call.body.occurredAt).toMatch(/\+07:00$/);
    expect(await screen.findByText('ส่ง POD DO-2611-00069 แล้ว')).toBeTruthy();
    expect((screen.getByTestId('pdl-q') as HTMLInputElement).value).toBe('');
  });

  it('review L: ปิดงานไม่ได้ → ข้อความตามรหัส (stop_not_ready / stop_already_closed)', async () => {
    search['DO-2611-00069'] = pv({ query: 'DO-2611-00069', match: atDropDo() });
    show();
    await type('DO-2611-00069');
    await pickPhotos([png(1)]);
    sign();
    const err = (code: string) =>
      new ApiError({ type: 'x', title: 'x', status: 409, code } as never);
    mutateAsync.mockRejectedValueOnce(err('stop_not_ready'));
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect(await screen.findByText('ปิดงานจุดก่อนหน้าก่อน')).toBeTruthy();
    mutateAsync.mockRejectedValueOnce(err('stop_already_closed'));
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect(
      await screen.findByText('จุดนี้ถูกปิดแล้ว — ส่ง POD ของ DO นี้ได้ (ค้นเลข DO อีกครั้ง)'),
    ).toBeTruthy();
  });

  it('เกณฑ์ตรวจรับ: รูปที่ 6 ถูกปฏิเสธ — อัปโหลดได้ 5 รูป ปุ่ม "+ เพิ่มรูป" หาย + ข้อความ', async () => {
    search['DO-2611-00069'] = pv({ query: 'DO-2611-00069', match: atDropDo() });
    show();
    await type('DO-2611-00069');
    await pickPhotos([1, 2, 3, 4, 5, 6].map(png));
    await waitFor(() => expect(screen.getByText('รูปที่ 5')).toBeTruthy());
    expect(upload).toHaveBeenCalledTimes(5);
    expect(screen.queryByText('รูปที่ 6')).toBeNull();
    expect(screen.queryByTestId('pdl-add-photo')).toBeNull();
    expect(screen.getByText('แนบรูปได้ไม่เกิน 5 รูป')).toBeTruthy();
    // ลบรูป → เพิ่มได้อีก
    fireEvent.click(screen.getByLabelText('ลบรูปที่ 5'));
    expect(screen.getByTestId('pdl-add-photo')).toBeTruthy();
  });

  it('จุดส่งปิดแล้ว (SUBMIT) → ส่ง POD อย่างเดียว · server ตอบไม่ครบ → ข้อความรายการที่ขาด · ข้อบังคับอื่นของ checklist แสดงเฉพาะที่บังคับ', async () => {
    const fields = [
      ...podOf().fields,
      { key: 'goods_ok', type: 'BOOLEAN', level: 'REQUIRED', label: 'สินค้าครบ ไม่เสียหาย' },
      { key: 'box', type: 'SINGLE_CHOICE', level: 'ENABLED', label: 'สภาพกล่อง', options: ['ดี'] },
    ] as PodLinkPod['fields'];
    const m = {
      ...doc(
        { status: 'COMPLETED', leftAt: '2026-11-18T03:00:00Z', nextOpen: false },
        { status: 'COMPLETED' },
      ),
      pod: podOf({ mode: 'SUBMIT', fields }),
    } as PodDo;
    search['DO-2611-00069'] = pv({ query: 'DO-2611-00069', match: m, recordable: false });
    show();
    await type('DO-2611-00069');
    expect(screen.queryByTestId('pdl-locked')).toBeNull();
    expect(screen.queryByText('สภาพกล่อง')).toBeNull();
    await pickPhotos([png(1)]);
    sign();
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect(await screen.findByText('ยังขาด: สินค้าครบ ไม่เสียหาย')).toBeTruthy();
    fireEvent.click(screen.getByText('สินค้าครบ ไม่เสียหาย'));
    captureAsync.mockRejectedValueOnce(
      new ApiError({
        type: 'x',
        title: 'x',
        status: 422,
        code: 'pod_incomplete',
        missing: [{ key: 'signature', type: 'SIGNATURE', code: 'required' }],
      } as never),
    );
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect(
      await screen.findByText('หลักฐานยังไม่ครบตามที่ลูกค้ากำหนด: ลายเซ็นผู้รับ'),
    ).toBeTruthy();
    expect(captureAsync.mock.calls[0]![0]).toMatchObject({
      doNo: 'DO-2611-00069',
      checks: { goods_ok: true },
    });
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('DO ส่ง POD แล้ว → "ส่ง POD ของ DO นี้แล้ว / รอ…ตรวจสอบ" ไม่มีฟอร์ม · รายการ "ส่งแล้ว n รูป · รอตรวจ"', async () => {
    base = pv({ sent: [{ doNo: 'DO-2611-00069', photoCount: 2 }] });
    search['DO-2611-00069'] = pv({
      query: 'DO-2611-00069',
      match: {
        ...doc({ status: 'COMPLETED', leftAt: '2026-11-18T03:00:00Z' }, { status: 'COMPLETED' }),
        pod: podOf({ sent: true, podStatus: 'COMPLETE' }),
      },
    });
    show();
    expect(screen.getByTestId('pdl-sent').textContent).toContain('DO-2611-00069');
    expect(screen.getByText('2 รูป · รอตรวจ')).toBeTruthy();
    await type('DO-2611-00069');
    expect(screen.getByText('ส่ง POD ของ DO นี้แล้ว')).toBeTruthy();
    expect(screen.getByText('รอศรีไทยขนส่งตรวจสอบ')).toBeTruthy();
    expect(screen.queryByTestId('pdl-pod-submit')).toBeNull();
    expect(screen.queryByTestId('pdl-hint')).toBeNull();
  });

  it('ST4-T10: จำนวนที่ส่งจริง (ค่าเริ่ม = แผน, −/+) · น้อยกว่าแผนไม่เลือกเหตุผล → ไม่ส่ง · เลือกแล้วส่ง lines ใน pod', async () => {
    search['DO-2611-00069'] = pv({
      query: 'DO-2611-00069',
      match: atDropDo({
        lines: [
          {
            doLineId: `dol_${'1'.padStart(32, '0')}`,
            lineNo: 1,
            description: 'ปูนซีเมนต์',
            unit: 'ตัน',
            qtyPlanned: '5',
          },
        ],
        rejectReasons: [
          { id: 'rsn_s', label: 'จำนวนไม่ครบ', requiresNote: false, requiresPhoto: true },
          {
            id: 'rsn_p',
            label: 'ลูกค้าปฏิเสธรับบางรายการ',
            requiresNote: true,
            requiresPhoto: true,
          },
        ],
      }),
    });
    show();
    await type('DO-2611-00069');
    expect(screen.getByText('จำนวนที่ส่งจริง')).toBeTruthy();
    expect(screen.getByText('แผน 5 ตัน')).toBeTruthy();
    const q = screen.getByLabelText('จำนวนที่ส่งจริง ปูนซีเมนต์') as HTMLInputElement;
    expect(q.value).toBe('5');
    // + ไม่เกินแผน · − ลดทีละ 1
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่ม ปูนซีเมนต์' }));
    expect(q.value).toBe('5');
    fireEvent.click(screen.getByRole('button', { name: 'ลด ปูนซีเมนต์' }));
    expect(q.value).toBe('4');
    expect(screen.getByText('ส่งน้อยกว่าแผน เลือกเหตุผลที่ผู้รับไม่รับ')).toBeTruthy();
    await pickPhotos([png(1)]);
    sign();
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect((await screen.findByTestId('pdl-pod-err')).textContent).toBe(
      'ส่งน้อยกว่าแผน เลือกเหตุผลก่อนส่ง',
    );
    expect(mutateAsync).not.toHaveBeenCalled();
    // เหตุผลบังคับโน้ต → ต้องกรอก
    fireEvent.click(screen.getByRole('button', { name: 'ลูกค้าปฏิเสธรับบางรายการ' }));
    // QA L2: เลือกเหตุผลแล้วข้อความเตือนเดิมหาย
    expect(screen.queryByTestId('pdl-pod-err')).toBeNull();
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    expect((await screen.findByTestId('pdl-pod-err')).textContent).toBe(
      'เหตุผลนี้ต้องระบุรายละเอียด',
    );
    fireEvent.click(screen.getByRole('button', { name: 'จำนวนไม่ครบ' }));
    fireEvent.click(screen.getByTestId('pdl-pod-submit'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0]![0].body.pod.lines).toEqual([
      { lineNo: 1, qtyActual: '4', rejectReasonCodeId: 'rsn_s', note: null },
    ]);
  });
});
