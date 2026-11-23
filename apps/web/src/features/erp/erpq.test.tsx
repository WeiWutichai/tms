import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { I18nProvider } from '../../i18n';
import { th } from '../../i18n/th';
import type { ReconcileResult } from './useReconcile';

/**
 * ST8-T12 หน้า MISMATCH (ต้นแบบ TMS v4 `erp`): สถานะ/แท็บ · ตารางเทียบ TMS กับ ERP (รายการที่หาย/เกิน/ช่องเงิน) · เรียงตาม severity ·
 * dialog ปิด 3 ทาง (ยอมรับความต่าง / แก้ที่ TMS / ขออนุมัติ → ใช้ค่า TMS ส่งซ้ำ) ส่งเหตุผล + ข้อความ error เฉพาะ
 */
const state: { one: ReconcileResult | null } = { one: null };
const mutate = vi.fn();
vi.mock('./useReconcile', async (orig) => {
  const real = await orig<typeof import('./useReconcile')>();
  return {
    ...real,
    useReconcileResult: () => ({ data: state.one, isError: false }),
    useDocumentSyncLog: () => ({ data: { data: [] } }),
    useCloseAction: () => ({
      isPending: false,
      error: null,
      mutate: (v: unknown, o: { onSuccess: (r: unknown) => void }) => {
        mutate(v);
        o.onSuccess(state.one);
      },
    }),
  };
});
const { compareRows, diffFields, rowStatus, bySeverity, messageOf, TAB_QUERY } =
  await import('./erpq');
const { CloseDialog, closeErrorText } = await import('./ErpDialogs');
const { ErpDrawer } = await import('./ErpDrawer');

const t = ((k: string, p?: Record<string, unknown>) =>
  String((th as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, n) =>
    String(p?.[n] ?? ''),
  )) as never;

const base = (over: Partial<ReconcileResult> = {}): ReconcileResult =>
  ({
    id: 'rec_1',
    connector: { id: 'con_1', adapterKey: 'krs', displayName: 'KRS' },
    entityType: 'INVOICE',
    invoiceId: 'ivc_1',
    localNumber: 'INV-00000-6911-0001',
    result: 'MISMATCH',
    severity: 'MONEY',
    source: 'NIGHTLY',
    status: 'OPEN',
    check: 'DOCUMENT',
    code: 'content_mismatch',
    reason: null,
    refMismatches: null,
    documentDiff: {
      levels: ['LINE_COUNT', 'HEADER', 'TOTAL'],
      lineCount: { local: 3, remote: 1 },
      missingLines: [
        { lineNo: 2, deliveryOrderNumber: 'DO-2' },
        { lineNo: 3, deliveryOrderNumber: 'DO-3' },
      ],
      extraLines: [],
      header: [{ field: 'dueDate', local: '2026-12-01', remote: '2026-12-31' }],
      lineFields: [
        {
          lineNo: 1,
          deliveryOrderNumber: 'DO-1',
          field: 'trip.vehiclePlate',
          local: '70-1234',
          remote: null,
        },
      ],
      total: [
        {
          field: 'totals.total',
          local: null,
          remote: null,
          sellLocalValue: '3000.00',
          sellRemoteValue: '1000.00',
        },
      ],
      totalSkipped: null,
      truncated: false,
    },
    runAt: '2026-11-23T02:00:00Z',
    lastSeenAt: '2026-11-23T02:00:00Z',
    resolvedAt: null,
    acknowledgedAt: null,
    ackReason: null,
    resolution: null,
    resolutionReason: null,
    overwrite: null,
    customer: { id: 'cus_1', name: 'บริษัท ลูกค้า จำกัด' },
    invoiceStatus: 'ISSUED',
    replacedByInvoice: null,
    sends: { count: 2, lastSentAt: '2026-11-22T09:42:00Z' },
    createdAt: '2026-11-23T02:00:00Z',
    updatedAt: '2026-11-23T02:00:00Z',
    ...over,
  }) as ReconcileResult;

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('erpq — สถานะ / ตารางเทียบ / เรียง', () => {
  it('สถานะของต้นแบบ: ไม่ตรง · รออนุมัติ · รอส่งซ้ำ (อนุมัติแล้ว) · ปิดแล้ว (ยอมรับ/ปิด) + ตัวกรองแท็บ', () => {
    expect(rowStatus(base())).toBe('mm');
    expect(rowStatus(base({ overwrite: { status: 'REJECTED' } as never }))).toBe('mm');
    expect(rowStatus(base({ overwrite: { status: 'REQUESTED' } as never }))).toBe('appr');
    expect(rowStatus(base({ overwrite: { status: 'APPROVED' } as never }))).toBe('resend');
    expect(rowStatus(base({ status: 'ACKNOWLEDGED' }))).toBe('closed');
    expect(rowStatus(base({ status: 'RESOLVED' }))).toBe('closed');
    expect(TAB_QUERY.mm).toEqual({ status: 'OPEN', overwriteStatus: 'NONE' });
    expect(TAB_QUERY.appr).toEqual({ status: 'OPEN', overwriteStatus: 'REQUESTED' });
  });

  it('ตารางเทียบ: จำนวนรายการ + หัว + ยอด (ค่า sell*) + รายการที่หาย (เลขรายการ + DO) + ช่องของรายการ · ฟิลด์ที่ต่างไม่ซ้ำ', () => {
    const rows = compareRows(t, base(), 'KRS');
    expect(rows.map((r) => [r.f, r.tms, r.erp, r.diff])).toEqual([
      ['จำนวนรายการ', '3', '1', true],
      ['วันครบกำหนด', '2026-12-01', '2026-12-31', true],
      ['ยอดรวม', '3,000.00', '1,000.00', true],
      ['รายการที่ 2 (DO-2)', 'มีรายการ', 'ไม่มี', true],
      ['รายการที่ 3 (DO-3)', 'มีรายการ', 'ไม่มี', true],
      ['รายการที่ 1 (DO-1) · ทะเบียนรถ', '70-1234', '—', true],
    ]);
    expect(diffFields(t, base(), 'KRS')).toBe('จำนวนรายการ, วันครบกำหนด, ยอดรวม, ทะเบียนรถ');
    // จำนวนรายการเท่ากัน = แถว "ตรง"
    const same = base({
      severity: 'FIELD',
      documentDiff: {
        ...base().documentDiff!,
        lineCount: { local: 1, remote: 1 },
        missingLines: [],
        total: [],
      },
    });
    expect(compareRows(t, same, 'KRS')[0]).toMatchObject({ f: 'จำนวนรายการ', diff: false });
    // ไม่พบเอกสารในระบบบัญชี
    const miss = base({ code: 'remote_missing', result: 'REMOTE_MISSING', documentDiff: null });
    expect(compareRows(t, miss, 'KRS')).toEqual([
      expect.objectContaining({ f: 'เอกสารใน KRS', erp: 'ไม่พบเอกสาร', diff: true }),
    ]);
  });

  it('เรียง MONEY ก่อน FIELD แล้วใหม่สุดก่อน · ข้อความแถบแดงตามสถานะ (พักไว้ = ระบบบัญชียังไม่รองรับ)', () => {
    const a = base({ id: 'a', severity: 'FIELD', lastSeenAt: '2026-11-23T05:00:00Z' });
    const b = base({ id: 'b', severity: 'MONEY', lastSeenAt: '2026-11-22T05:00:00Z' });
    const c = base({ id: 'c', severity: 'MONEY', lastSeenAt: '2026-11-23T05:00:00Z' });
    expect([a, b, c].sort(bySeverity).map((x) => x.id)).toEqual(['c', 'b', 'a']);
    expect(messageOf(t, base(), 'KRS')).toBe('จำนวนรายการหรือยอดเงินใน KRS ไม่ตรงกับ TMS');
    expect(
      messageOf(
        t,
        base({
          overwrite: {
            status: 'APPROVED',
            commandErrorCode: 'capability_not_implemented',
          } as never,
        }),
        'KRS',
      ),
    ).toContain('ยังไม่รองรับการแทนที่เอกสาร');
    expect(messageOf(t, base({ status: 'RESOLVED' }), 'KRS')).toBeNull();
  });

  it('ข้อความ error เฉพาะของ 409 (เช่น ใบยังไม่ยกเลิก)', () => {
    const e = new ApiError({
      type: '',
      title: '',
      status: 409,
      code: 'invalid_state_transition',
      reason: 'invoice_not_voided',
    } as never);
    expect(closeErrorText(e, t)).toBe(th['erpq.err.invoice_not_voided']);
  });
});

describe('drawer + dialog ปิด 3 ทาง', () => {
  it('drawer: แถบแดง + ตาราง "เทียบข้อมูล TMS กับ KRS" · ปุ่ม รับค่า/ขออนุมัติแก้ · "ใช้ค่า TMS ส่งซ้ำ" ปิดจนกว่ามีคำขอของคนอื่น', () => {
    state.one = base();
    const onUseTms = vi.fn();
    const props = {
      id: 'rec_1',
      tab: 'sum',
      onTab: () => undefined,
      erpName: () => 'KRS',
      onClose: () => undefined,
      onAccept: () => undefined,
      onAskFix: () => undefined,
      onUseTms,
    };
    const { unmount } = wrap(<ErpDrawer {...props} can={{ act: true, approve: true }} />);
    expect(screen.getByText('เทียบข้อมูล TMS กับ KRS')).toBeTruthy();
    expect(screen.getByText('ต่าง 6 ฟิลด์')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('ไม่ตรงกับ TMS');
    expect(screen.getByRole('button', { name: 'รับค่า KRS' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ขออนุมัติแก้' })).toBeTruthy();
    const use = screen.getByRole('button', { name: /ใช้ค่า TMS ส่งซ้ำ/ }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    expect(use.title).toBe(th['erpq.hint.askFirst']);
    unmount();
    // มีคำขอของผู้อื่น + มีสิทธิ์อนุมัติ → กดได้
    state.one = base({
      overwrite: { status: 'REQUESTED', requestedByMe: false, reason: 'ค่า TMS ถูก' } as never,
    });
    wrap(<ErpDrawer {...props} can={{ act: true, approve: true }} />);
    const use2 = screen.getByRole('button', { name: /ใช้ค่า TMS ส่งซ้ำ/ }) as HTMLButtonElement;
    expect(use2.disabled).toBe(false);
    fireEvent.click(use2);
    expect(onUseTms).toHaveBeenCalled();
  });

  it('รับค่า ERP: ยอมรับความต่าง (ค่าเริ่ม) ส่ง acknowledge + เหตุผล · แก้ที่ TMS ทำได้เมื่อใบยกเลิกแล้ว → resolve', () => {
    mutate.mockClear();
    state.one = base();
    const done = vi.fn();
    const { unmount } = wrap(
      <CloseDialog kind="accept" x={base()} erp="KRS" onClose={() => undefined} onDone={done} />,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'ยืนยันกับบัญชีแล้วถูกต้อง' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ปิดรายการ' }));
    expect(mutate).toHaveBeenCalledWith({
      action: 'acknowledge',
      id: 'rec_1',
      reason: 'ยืนยันกับบัญชีแล้วถูกต้อง',
    });
    expect(done).toHaveBeenCalledWith('ปิดรายการ INV-00000-6911-0001 แล้ว (ยอมรับความต่าง)');
    unmount();
    // ใบยังไม่ยกเลิก: เลือก "แก้ที่ TMS" → ปุ่มปิด + ลิงก์ไปใบแจ้งหนี้
    wrap(
      <CloseDialog kind="accept" x={base()} erp="KRS" onClose={() => undefined} onDone={done} />,
    );
    fireEvent.click(screen.getByRole('radio', { name: /แก้ที่ TMS แล้ว/ }));
    expect(screen.getByRole('link', { name: 'เปิดใบแจ้งหนี้' }).getAttribute('href')).toBe(
      '/bill?invoice=ivc_1',
    );
  });

  it('ใบยกเลิกแล้ว → ค่าเริ่ม "แก้ที่ TMS" ส่ง resolve · ขออนุมัติแก้ = ตาราง ค่า ERP | ค่า TMS แล้วส่ง request', () => {
    mutate.mockClear();
    const v = base({ invoiceStatus: 'CANCELLED' });
    const { unmount } = wrap(
      <CloseDialog
        kind="accept"
        x={v}
        erp="KRS"
        onClose={() => undefined}
        onDone={() => undefined}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ยกเลิกและออกใบใหม่แล้ว' } });
    fireEvent.click(screen.getByRole('button', { name: 'ปิดรายการ' }));
    expect(mutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'resolve' }));
    unmount();
    wrap(
      <CloseDialog
        kind="askFix"
        x={base()}
        erp="KRS"
        onClose={() => undefined}
        onDone={() => undefined}
      />,
    );
    expect(screen.getByText('ขออนุมัติแก้ INV-00000-6911-0001')).toBeTruthy();
    expect(screen.getByText('ค่า KRS')).toBeTruthy();
    expect(screen.getByText('ค่า TMS')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'ค่าใน TMS ถูกต้องตามใบส่งของ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ส่งขออนุมัติ' }));
    expect(mutate).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'request' }));
  });
});
