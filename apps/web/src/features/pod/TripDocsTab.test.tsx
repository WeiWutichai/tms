import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { TripDetail } from '../trips/useTrips';
import type { DoPod } from './usePod';

/** ST4-T07 แท็บ "เอกสารแนบ" ของ drawer เที่ยว: แถวใบคุมรถ + หลักฐานส่งต่อ DO (รูป/ลายเซ็น/น้ำหนัก/ผู้รับ/ไฟล์) */
const pods: Record<string, DoPod> = {};
const mutate = vi.fn();
const upload = vi.fn();
vi.mock('./usePod', async (orig) => ({
  ...(await orig<typeof import('./usePod')>()),
  useDoPods: (ids: string[]) =>
    ids.map((id) => ({ data: pods[id], isLoading: false, isError: false, error: null })),
  useSavePod: () => ({ mutate, isPending: false }),
  uploadPodFile: (...a: unknown[]) => upload(...a),
}));
vi.mock('../vehicles/useVehicleDocs', () => ({ openDocFile: vi.fn() }));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }),
}));
const { TripDocsTab, bodyOfDraft, podFieldError } = await import('./TripDocsTab');
const { ApiError } = await import('../../api');
const { weightDiff } = await import('./usePod');

const fields = (over: Partial<Record<string, string>> = {}) =>
  [
    { key: 'photo', type: 'PHOTO', level: over.PHOTO ?? 'REQUIRED', minCount: 1 },
    { key: 'signature', type: 'SIGNATURE', level: over.SIGNATURE ?? 'REQUIRED' },
    { key: 'note', type: 'NOTE', level: over.NOTE ?? 'ENABLED' },
    { key: 'barcode', type: 'BARCODE', level: 'DISABLED' },
    { key: 'pin', type: 'PIN', level: over.PIN ?? 'DISABLED', length: 4 },
    { key: 'rating', type: 'RATING', level: 'DISABLED', max: 5 },
  ] as DoPod['checklist']['fields'];

const pod = (x: Partial<DoPod> = {}): DoPod =>
  ({
    deliveryOrderId: 'do_1',
    doNo: 'DO-6911-0001',
    doStatus: 'POD_PENDING',
    podStatus: 'NONE',
    editable: true,
    plannedWeightKg: '15000',
    checklist: { outcome: 'SUCCESS', source: 'TENANT', fields: fields(), tenantFields: [] },
    missing: [
      { key: 'photo', type: 'PHOTO', code: 'required', expected: 1, actual: 0 },
      { key: 'signature', type: 'SIGNATURE', code: 'required' },
    ],
    current: null,
    versions: [],
    ...x,
  }) as DoPod;

const trip = {
  id: 'trp_1',
  tripNo: 'TRP-6911-0001',
  status: 'COMPLETED',
  stops: [
    { id: 'p', sequence: 1, type: 'PICKUP', siteName: 'คลังบางนา', deliveryOrderIds: [] },
    {
      id: 'd',
      sequence: 2,
      type: 'DELIVERY',
      siteName: 'โรงงานชลบุรี',
      deliveryOrderIds: ['do_1'],
    },
  ],
  deliveryOrders: [
    { id: 'do_1', doNo: 'DO-6911-0001', status: 'POD_PENDING', dropStopId: 'd', pickupStopId: 'p' },
  ],
} as unknown as TripDetail;

function renderTab(canEdit = true, onPrintSheet?: () => void) {
  const toast = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <TripDocsTab trip={trip} canEdit={canEdit} onPrintSheet={onPrintSheet} onToast={toast} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return toast;
}

beforeEach(() => {
  mutate.mockReset();
  upload.mockReset();
  for (const k of Object.keys(pods)) delete pods[k];
});

describe('TripDocsTab', () => {
  it('แถวใบคุมรถ + DO ที่รอหลักฐานเปิดอัตโนมัติ: ป้ายสถานะ, กล่องว่างของรูป, ปุ่มเก็บลายเซ็น, สิ่งที่ขาด', () => {
    pods.do_1 = pod();
    const print = vi.fn();
    renderTab(true, print);
    expect(screen.getByText('ใบคุมรถ-TRP-6911-0001.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /ดาวน์โหลด ใบคุมรถ/ }));
    expect(print).toHaveBeenCalled();
    const block = screen.getByTestId('do-pod');
    expect(within(block).getByText('DO-6911-0001')).toBeTruthy();
    expect(within(block).getByText('ยังไม่มี POD')).toBeTruthy();
    expect(within(block).getByText('ยังไม่มีรูปหลักฐาน')).toBeTruthy();
    expect(within(block).getByText('ต้องมีอย่างน้อย 1 รูปก่อนยืนยันส่งแล้ว')).toBeTruthy();
    expect(within(block).getByRole('button', { name: 'เก็บลายเซ็นผู้รับ' })).toBeTruthy();
    expect(within(block).getByText('กรอกน้ำหนักจากใบชั่งปลายทาง')).toBeTruthy();
    expect(screen.getByTestId('pod-missing').textContent).toBe('ยังขาด: รูปหลักฐาน, ลายเซ็นผู้รับ');
    // ยังไม่แก้อะไร = บันทึกไม่ได้
    expect(
      (screen.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('กรอกน้ำหนัก → ข้อความต่างจากใบสั่ง · ฉบับแรกบันทึกได้ทันที (ไม่ถามเหตุผล) ส่งทั้งฉบับ', () => {
    pods.do_1 = pod();
    renderTab();
    const w = screen.getByLabelText('น้ำหนักชั่ง (กก.)');
    fireEvent.change(w, { target: { value: '14940' } });
    expect(screen.getByText('ต่างจากใบสั่ง -60 กก.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ชื่อผู้รับ'), { target: { value: 'สมศรี ใจงาม' } });
    fireEvent.change(screen.getByLabelText('ความสัมพันธ์'), { target: { value: 'SECURITY' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const arg = mutate.mock.calls[0]![0];
    expect(arg).toMatchObject({ doId: 'do_1', version: 0 });
    expect(arg.body).toMatchObject({
      weighedKg: '14940',
      receiverName: 'สมศรี ใจงาม',
      receiverRelation: 'SECURITY',
      photoDocumentIds: [],
      signatureDocumentId: null,
    });
    expect(arg.body.reason).toBeUndefined();
    expect('pin' in arg.body).toBe(false);
  });

  it('มีฉบับแล้ว: แสดงรูป/ลายเซ็น/ฉบับ — แก้แล้วบันทึกต้องใส่เหตุผล (ReasonDialog)', () => {
    pods.do_1 = pod({
      podStatus: 'PARTIAL',
      missing: [{ key: 'signature', type: 'SIGNATURE', code: 'required' }],
      current: {
        version: 1,
        podStatus: 'PARTIAL',
        source: 'WEB',
        reason: null,
        recordedBy: 'u1',
        recordedByName: 'สมพร หน้าคลัง',
        recordedAt: '2026-11-17T03:00:00.000Z',
        outcome: 'SUCCESS',
        receiverName: 'สมศรี',
        receiverRelation: 'SELF',
        signature: null,
        photos: [
          {
            id: 'doc_a',
            kind: 'POD_PHOTO',
            mime: 'image/jpeg',
            bytes: 1000,
            filename: 'a.jpg',
            createdAt: '2026-11-17T02:16:00.000Z',
          },
        ],
        files: [],
        weighedKg: null,
        customerRef: null,
        note: null,
        checks: {},
        choices: {},
        barcodes: [],
        pinMasked: null,
        pinUnreadable: false,
        rating: null,
        missing: [],
      },
      versions: [
        {
          version: 1,
          podStatus: 'PARTIAL',
          source: 'WEB',
          reason: null,
          recordedBy: 'u1',
          recordedByName: 'สมพร หน้าคลัง',
          recordedAt: '2026-11-17T03:00:00.000Z',
        },
      ],
    } as Partial<DoPod>);
    renderTab();
    expect(screen.getByText('POD ไม่ครบ')).toBeTruthy();
    expect(screen.getByText('รูปที่ 1 · 09:16')).toBeTruthy();
    expect(screen.getByText(/ฉบับที่ 1 · บันทึกโดย สมพร หน้าคลัง/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'ลบรูปที่ 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }));
    expect(mutate).not.toHaveBeenCalled();
    const dlg = screen.getByRole('dialog', { name: 'แก้หลักฐานส่ง' });
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'รูปเดิมผิดใบส่งของ' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'บันทึกหลักฐานส่ง' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toMatchObject({
      version: 1,
      body: { photoDocumentIds: [], reason: 'รูปเดิมผิดใบส่งของ' },
    });
  });

  it('ST4-T09 ฉบับที่ส่งผ่านลิงก์รถร่วม → "บันทึกโดย {รถร่วม} · ลิงก์รถร่วม"', () => {
    const v = {
      version: 1,
      podStatus: 'COMPLETE',
      source: 'LINK',
      reason: null,
      recordedBy: 'link:6b1e0f5e-1111-4222-8333-944455556666',
      recordedByName: 'หจก. ศรีราชาโลจิสติกส์',
      recordedAt: '2026-11-17T03:00:00.000Z',
    } as const;
    // DO ยังรอหลักฐาน (เปิดบล็อกอัตโนมัติ)
    pods.do_1 = pod({
      podStatus: 'PARTIAL',
      missing: [{ key: 'signature', type: 'SIGNATURE', code: 'required' }],
      current: {
        ...v,
        outcome: 'SUCCESS',
        receiverName: null,
        receiverRelation: null,
        signature: null,
        photos: [],
        files: [],
        weighedKg: null,
        customerRef: null,
        note: null,
        checks: {},
        choices: {},
        barcodes: [],
        pinMasked: null,
        pinUnreadable: false,
        rating: null,
        missing: [],
      },
      versions: [v],
    } as Partial<DoPod>);
    renderTab();
    expect(
      screen.getByText(/ฉบับที่ 1 · บันทึกโดย หจก\. ศรีราชาโลจิสติกส์ · ลิงก์รถร่วม/),
    ).toBeTruthy();
  });

  it('อ่านอย่างเดียว (ไม่มีสิทธิ์ / วางบิลแล้ว): ไม่มีปุ่มอัปโหลด/บันทึก', () => {
    pods.do_1 = pod({ editable: false, doStatus: 'BILLED', podStatus: 'COMPLETE' });
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: /DO-6911-0001/ }));
    expect(screen.getByText('วางบิลแล้ว แก้หลักฐานส่งไม่ได้')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'อัปโหลดรูป' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'บันทึกหลักฐานส่ง' })).toBeNull();
  });

  it('checklist มี PIN/ข้อยืนยัน → แสดงช่อง · PIN ส่งเมื่อกรอกเท่านั้น', () => {
    pods.do_1 = pod({
      checklist: {
        outcome: 'SUCCESS',
        source: 'CUSTOMER',
        fields: [
          ...fields({ PIN: 'REQUIRED' }),
          { key: 'goods_ok', type: 'BOOLEAN', level: 'REQUIRED', label: 'สินค้าครบ' },
        ],
        tenantFields: [],
      } as DoPod['checklist'],
    });
    renderTab();
    fireEvent.click(screen.getByLabelText(/สินค้าครบ/));
    fireEvent.change(screen.getByLabelText(/รหัส PIN จากผู้รับ/), { target: { value: '48a21' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }));
    expect(mutate.mock.calls[0]![0].body).toMatchObject({
      pin: '4821',
      checks: { goods_ok: true },
    });
  });
});

describe('TripDocsTab errors', () => {
  it('422 รายช่อง → ข้อความใต้ช่อง PIN · 412 → คงสิ่งที่แก้ + ปุ่มโหลดฉบับล่าสุด', () => {
    pods.do_1 = pod({
      checklist: {
        outcome: 'SUCCESS',
        source: 'CUSTOMER',
        fields: fields({ PIN: 'REQUIRED' }),
        tenantFields: [],
      } as DoPod['checklist'],
    });
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <TripDocsTab trip={trip} canEdit onToast={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText(/รหัส PIN จากผู้รับ/), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }));
    const opts = mutate.mock.calls[0]![1];
    act(() =>
      opts.onError(
        new ApiError({
          code: 'validation_failed',
          status: 422,
          title: '',
          type: '',
          errors: [{ field: 'pin', code: 'invalid', message: '' }],
        } as never),
      ),
    );
    expect(screen.getByText('รหัส PIN ต้องเป็นตัวเลข 4 หลัก')).toBeTruthy();
    // คนอื่นบันทึกฉบับ 1 ระหว่างนี้ → 412 + ข้อมูลใหม่มา: ยังเห็นค่าที่กรอก + ปุ่มโหลดใหม่
    act(() =>
      mutate.mock.calls[0]![1].onError(
        new ApiError({ code: 'precondition_failed', status: 412, title: '', type: '' } as never),
      ),
    );
    pods.do_1 = pod({
      checklist: pods.do_1!.checklist,
      versions: [
        {
          version: 1,
          podStatus: 'PARTIAL',
          source: 'WEB',
          reason: null,
          recordedBy: 'u2',
          recordedByName: 'คนอื่น',
          recordedAt: '2026-11-17T03:00:00.000Z',
        },
      ],
    } as Partial<DoPod>);
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <TripDocsTab trip={trip} canEdit onToast={vi.fn()} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect((screen.getByLabelText(/รหัส PIN จากผู้รับ/) as HTMLInputElement).value).toBe('12');
    expect(screen.getAllByText(/ถูกแก้โดยผู้อื่นแล้ว/).length).toBeGreaterThan(0);
    expect(
      (screen.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'โหลดฉบับล่าสุด' }));
    expect((screen.getByLabelText(/รหัส PIN จากผู้รับ/) as HTMLInputElement).value).toBe('');
  });

  it('podFieldError แปลงรหัสข้อผิดพลาดเป็นข้อความ', () => {
    const t = ((k: string, p?: Record<string, unknown>) =>
      `${k}${p ? JSON.stringify(p) : ''}`) as never;
    expect(podFieldError(t, { field: 'photoDocumentIds.0', code: 'document_in_use' }, {})).toBe(
      'pod.e.v.inUse',
    );
    expect(podFieldError(t, { field: 'rating', code: 'invalid' }, { max: 5 })).toBe(
      'pod.e.v.rating{"max":5}',
    );
    expect(podFieldError(t, { field: 'signatureDocumentId', code: 'required' }, {})).toBe(
      'pod.e.v.required',
    );
  });
});

describe('helpers', () => {
  it('weightDiff ใช้ทศนิยม 3 ตำแหน่งแบบจำนวนเต็ม', () => {
    expect(weightDiff('14940', '15000')).toBe('-60');
    expect(weightDiff('15000.5', '15000')).toBe('0.5');
    expect(weightDiff('16200', '15000')).toBe('1,200');
    expect(weightDiff('abc', '15000')).toBeNull();
    expect(weightDiff('1', null)).toBeNull();
  });
  it('bodyOfDraft ตัดช่องว่าง/บรรทัดว่างของรหัสสแกน', () => {
    const b = bodyOfDraft({
      photos: [],
      files: [],
      signature: null,
      receiverName: '  ',
      receiverRelation: '',
      weighedKg: '1,250',
      customerRef: '',
      note: '',
      checks: {},
      choices: { box: '' },
      barcodes: ' A \n\nB',
      pin: '',
      pinClear: false,
      rating: '3',
    });
    expect(b).toMatchObject({
      receiverName: null,
      receiverRelation: null,
      weighedKg: '1250',
      choices: {},
      barcodes: ['A', 'B'],
      rating: 3,
    });
    expect('pin' in b).toBe(false);
    expect(
      bodyOfDraft({
        photos: [],
        files: [],
        signature: null,
        receiverName: '',
        receiverRelation: '',
        weighedKg: '',
        customerRef: '',
        note: '',
        checks: {},
        choices: {},
        barcodes: '',
        pin: '',
        pinClear: true,
        rating: '',
      }).pin,
    ).toBeNull();
  });
});
