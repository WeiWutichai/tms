import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { flagDetail } from './flagText';
import type { StopEventFlag, StopSequence } from './useStopEventFlags';

/** ST4-T02: drawer ข้อยกเว้น — ข้อมูล, ลำดับ event, ปิดเหตุ (ACCEPT) / ไม่ใช้ (IGNORE) ผ่าน ReasonDialog */
const mutate = vi.fn();
const seq: { data: StopSequence | undefined; isError: boolean } = {
  data: undefined,
  isError: false,
};
vi.mock('./useStopEventFlags', () => ({
  useResolveFlag: () => ({ mutate, isPending: false, error: null, reset: vi.fn() }),
  useStopSequence: () => seq,
}));
vi.mock('../trips/TripDrawer', () => ({
  TripDrawer: ({ id }: { id: string }) => <div>trip drawer {id}</div>,
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }),
}));
const { FlagDrawer } = await import('./FlagDrawer');

const ev = (over: Partial<StopEventFlag['event']> = {}): StopEventFlag['event'] => ({
  id: 'evt_1',
  stopId: 'stp_1',
  tripId: 'trp_1',
  type: 'COMPLETE',
  outcome: 'DELIVERED',
  clientEventId: '6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f',
  occurredAt: '2026-11-17T02:40:00.000Z',
  receivedAt: '2026-11-17T03:00:00.000Z',
  appliedAt: null,
  lat: null,
  lng: null,
  accuracyM: null,
  source: 'WEB',
  recordedBy: 'u-1',
  reason: null,
  note: null,
  photoDocumentIds: [],
  sequenceConflict: true,
  clockSkew: false,
  lateReason: null,
  flags: ['SEQUENCE_CONFLICT'],
  ...over,
});
const flag = (over: Partial<StopEventFlag> = {}): StopEventFlag => ({
  id: 'evt_1',
  event: ev(),
  flags: ['SEQUENCE_CONFLICT'],
  status: 'OPEN',
  tripId: 'trp_1',
  tripNo: 'TRP-2611-0042',
  tripStatus: 'IN_PROGRESS',
  stopId: 'stp_1',
  stopSequence: 2,
  stopType: 'DELIVERY',
  siteName: 'คลังบางนา',
  vehiclePlate: '70-2281',
  customerName: 'บจก. ไทยสตีลไพพ์',
  doNos: ['DO-2611-00022'],
  stateBefore: 'EN_ROUTE',
  resolution: null,
  recordedByName: 'สมชาย ใจดี',
  resolvedByName: null,
  ...over,
});

const qc = new QueryClient();
const show = (f: StopEventFlag, canResolve = true, onResolved = vi.fn()) =>
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <I18nProvider>
          <FlagDrawer flag={f} canResolve={canResolve} onClose={vi.fn()} onResolved={onResolved} />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('FlagDrawer (ST4-T02)', () => {
  beforeEach(() => {
    mutate.mockReset();
    seq.data = undefined;
  });

  it('หัว 3 บรรทัด + ข้อมูล (ประเภท/รายละเอียด/อ้างอิง/รถ/ลูกค้า/ผู้บันทึก)', () => {
    show(flag());
    expect(screen.getByText('ศูนย์ข้อยกเว้น · ลำดับเหตุการณ์ขัดกัน')).toBeTruthy();
    expect(screen.getAllByText('TRP-2611-0042').length).toBeGreaterThan(0);
    expect(screen.getByText('จุดที่ 2 · คลังบางนา')).toBeTruthy();
    expect(screen.getByText('ปิดงาน (ส่งสำเร็จ) · ขณะยังไม่ถึงจุด')).toBeTruthy();
    expect(screen.getByText('DO-2611-00022')).toBeTruthy();
    expect(screen.getByText('สมชาย ใจดี')).toBeTruthy();
  });

  it('ปิดเหตุ = ใช้เหตุการณ์นี้ (ACCEPT) ผ่าน ReasonDialog เหตุผล ≥ 10 ตัวอักษร', () => {
    show(flag());
    fireEvent.click(screen.getByRole('button', { name: /ปิดเหตุ/ }));
    const dlg = screen.getByRole('dialog', { name: 'ปิดเหตุ TRP-2611-0042' });
    expect(within(dlg).getByText('รอตัดสิน')).toBeTruthy();
    expect(within(dlg).getByText('ใช้เหตุการณ์นี้')).toBeTruthy();
    const ok = within(dlg)
      .getAllByRole('button', { name: /ปิดเหตุ/ })
      .pop()!;
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: 'สั้น' } });
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'คนขับลืมกดถึงจุด ลูกค้ายืนยันแล้ว' },
    });
    fireEvent.click(ok);
    expect(mutate).toHaveBeenCalledWith(
      { id: 'evt_1', decision: 'ACCEPT', reason: 'คนขับลืมกดถึงจุด ลูกค้ายืนยันแล้ว' },
      expect.anything(),
    );
  });

  it('เมนู ⋯ "ไม่ใช้เหตุการณ์นี้" = IGNORE', () => {
    show(flag());
    fireEvent.click(screen.getByRole('button', { name: 'เพิ่มเติม' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /ไม่ใช้เหตุการณ์นี้/ }));
    const dlg = screen.getByRole('dialog', { name: /ไม่ใช้เหตุการณ์นี้/ });
    fireEvent.change(within(dlg).getByRole('textbox'), {
      target: { value: 'คนขับกดซ้ำ ยืนยันทางโทรศัพท์แล้ว' },
    });
    fireEvent.click(
      within(dlg)
        .getAllByRole('button', { name: /ไม่ใช้เหตุการณ์นี้/ })
        .pop()!,
    );
    expect(mutate.mock.calls[0]![0]).toMatchObject({ decision: 'IGNORE' });
  });

  it('ธงแจ้ง "ผลจุดไม่ตรงใบส่งของ" อย่างเดียว → ไม่มีเมนู "ไม่ใช้" (รับทราบได้อย่างเดียว — ST4-T03)', () => {
    show(flag({ flags: ['OUTCOME_MISMATCH'] }));
    expect(screen.queryByRole('button', { name: 'เพิ่มเติม' })).toBeNull();
    expect(screen.getByText('ผลจุดไม่ตรงใบส่งของ')).toBeTruthy();
  });

  it('ไม่มีสิทธิ์ / ปิดแล้ว → ไม่มีปุ่มตัดสิน · ปิดแล้วแสดงการตัดสิน', () => {
    const { unmount } = show(flag(), false);
    expect(screen.queryByRole('button', { name: /ปิดเหตุ/ })).toBeNull();
    unmount();
    show(
      flag({
        status: 'RESOLVED',
        resolution: {
          decision: 'IGNORE',
          reason: 'คนขับกดซ้ำ ยืนยันแล้ว',
          flags: ['SEQUENCE_CONFLICT'],
          resolvedBy: 'u-2',
          resolvedAt: '2026-11-17T04:00:00.000Z',
        },
        resolvedByName: 'วิภา ผู้จัดรถ',
      }),
    );
    expect(screen.queryByRole('button', { name: /ปิดเหตุ/ })).toBeNull();
    expect(screen.getByText('การตัดสิน')).toBeTruthy();
    expect(screen.getByText('ไม่ใช้ (เก็บเป็นประวัติ)')).toBeTruthy();
    expect(screen.getByText('วิภา ผู้จัดรถ')).toBeTruthy();
  });

  it('แท็บกิจกรรม: ลำดับ event ของจุดพร้อมผลแต่ละตัว · เปิดเอกสารอ้างอิง = drawer เที่ยว', () => {
    seq.data = {
      data: [
        {
          ...ev({ id: 'evt_0', type: 'DEPART', outcome: null, sequenceConflict: false, flags: [] }),
          seqStatus: 'APPLIED',
          counted: true,
          resolution: null,
        },
        { ...ev(), seqStatus: 'CONFLICT', counted: false, resolution: null },
      ],
      effective: {
        state: 'EN_ROUTE',
        outcome: null,
        enRouteAt: '2026-11-17T01:30:00.000Z',
        arrivedAt: null,
        closedAt: null,
        lastEventId: 'evt_0',
      },
    };
    show(flag());
    fireEvent.click(screen.getByRole('tab', { name: 'กิจกรรม' }));
    expect(screen.getByText('ลำดับเหตุการณ์ของจุดนี้')).toBeTruthy();
    expect(screen.getByText('ใช้แล้ว')).toBeTruthy();
    expect(screen.getByText('ขัดลำดับ')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'เปิดเอกสารอ้างอิง' }));
    expect(screen.getByText('trip drawer trp_1')).toBeTruthy();
  });
});

describe('flagDetail', () => {
  const t = (k: string, p?: Record<string, string | number>) =>
    p ? `${k}${JSON.stringify(p)}` : k;
  it('รวมเหตุของทุกธง', () => {
    const s = flagDetail(
      t as never,
      {
        flags: ['LATE', 'CLOCK_SKEW'],
        stateBefore: null,
        event: ev({ type: 'ARRIVE', outcome: null, lateReason: 'TRIP_CANCELLED' }),
      },
      (x) => x.slice(11, 16),
    );
    expect(s).toBe('exc.ev.ARRIVE · exc.late.TRIP_CANCELLED · exc.skew{"o":"02:40","r":"03:00"}');
  });
  it('ธงจุดรับยังไม่ปิด / ผลไม่ตรง DO (ST4-T03)', () => {
    const s = flagDetail(
      t as never,
      { flags: ['PICKUP_NOT_DONE', 'OUTCOME_MISMATCH'], stateBefore: null, event: ev() },
      (x) => x,
    );
    expect(s).toBe('exc.ev.COMPLETE (exc.out.DELIVERED) · exc.pickupPending · exc.mismatch');
  });
});
