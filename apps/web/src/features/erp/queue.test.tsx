import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { I18nProvider } from '../../i18n';
import { th } from '../../i18n/th';
import type { QueueItem } from './queue';

/**
 * PO #86 (24 พ.ย. 2569) แท็บคิว รอคิว / ล้มเหลว / สำเร็จ ของหน้า "คิวเชื่อมระบบบัญชี" (docs/04 G3, docs/01 §6.4):
 * ป้ายสถานะตามต้นแบบ · ฟิลด์ที่ต่าง · แถบแดง/คู่มือ · ปุ่ม ส่งซ้ำ / ข้ามพร้อมเหตุผล / กรอกเลขเอง / อนุมัติแทนที่ ตาม `actions` + สิทธิ์ ·
 * dialog ส่งเหตุผล (+ เลขเอกสาร) ไป API · ข้อความ 409 ตาม `why`
 */
const mutate = vi.fn();
vi.mock('./useQueue', async (orig) => {
  const real = await orig<typeof import('./useQueue')>();
  return {
    ...real,
    useCommandSyncLog: () => ({ data: { data: [] } }),
    useQueueAction: () => ({
      isPending: false,
      error: null,
      mutate: (v: unknown, o?: { onSuccess?: (r: unknown) => void }) => {
        mutate(v);
        o?.onSuccess?.({});
      },
    }),
  };
});
const { queueStatusKey, queueFields, queueMessage, queueErrorText, queueType } =
  await import('./queue');
const { QueueDrawer } = await import('./QueueDrawer');
const { QueueDialog } = await import('./QueueDialogs');
const { asTab, isQueueTab, TABS } = await import('./erpq');

const t = ((k: string, p?: Record<string, unknown>) =>
  String((th as Record<string, string>)[k] ?? k).replace(/\{(\w+)\}/g, (_, n) =>
    String(p?.[n] ?? ''),
  )) as never;

const item = (over: Partial<QueueItem> = {}): QueueItem =>
  ({
    id: 'obx_1',
    operation: 'PUSH_INVOICE',
    entityType: 'invoice',
    localId: 'u1',
    status: 'FAILED_FINAL',
    attempt: 2,
    errorClass: 'PERIOD_CLOSED',
    errorCode: 'period_closed',
    createdAt: '2026-11-23T02:00:00Z',
    doneAt: null,
    updatedAt: '2026-11-23T03:00:00Z',
    tab: 'failed',
    documentNo: 'INV-00000-6911-0001',
    partyName: 'บริษัท ลูกค้า จำกัด',
    nextRunAt: null,
    errorMessage: 'period closed',
    link: null,
    missing: [],
    fields: [],
    manualExternalIdRequired: false,
    guide: { key: 'PERIOD_CLOSED', title: 'งวดบัญชีปิดแล้ว', action: 'เปิดงวดแล้วส่งซ้ำ' },
    resolution: null,
    actions: { retry: true, skip: true, externalId: true, approve: false },
    bodiesHidden: false,
    ...over,
  }) as QueueItem;

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('แท็บและสถานะของคิว', () => {
  it('แท็บตาม docs (รอคิว/ล้มเหลว/สำเร็จ) + แท็บ MISMATCH ของต้นแบบ · แท็บเก่า "ทั้งหมด" → ล้มเหลว', () => {
    expect([...TABS]).toEqual(['queued', 'failed', 'done', 'mm', 'appr']);
    expect(asTab('all')).toBe('failed');
    expect(asTab('mm')).toBe('mm');
    expect(isQueueTab('done')).toBe(true);
    expect(isQueueTab('appr')).toBe(false);
  });

  it('ป้ายสถานะของต้นแบบ: รอส่ง / รอส่งซ้ำ / ส่งไม่สำเร็จ / ถูกปฏิเสธ / รออนุมัติ / ซิงก์แล้ว / ข้าม', () => {
    const k = (o: Partial<QueueItem>) => th[queueStatusKey(item(o)) as keyof typeof th];
    expect(k({ tab: 'queued', status: 'PENDING' })).toBe('รอส่ง');
    expect(k({ tab: 'queued', status: 'FAILED_RETRYABLE' })).toBe('รอส่งซ้ำ');
    expect(k({})).toBe('ส่งไม่สำเร็จ');
    expect(k({ errorClass: 'VALIDATION' })).toBe('ถูกปฏิเสธ');
    expect(k({ status: 'SKIPPED', errorCode: 'replace_requires_approval' })).toBe('รออนุมัติ');
    expect(k({ tab: 'done', status: 'DONE' })).toBe('ซิงก์แล้ว');
    expect(
      k({
        tab: 'done',
        resolution: {
          kind: 'SKIPPED',
          reason: 'บันทึกเองแล้ว',
          supersededBy: null,
          externalId: null,
          resolvedBy: 'u',
          resolvedAt: '2026-11-23T03:00:00Z',
        },
      }),
    ).toBe('ข้าม');
    expect(queueType(t, item({ entityType: 'settlement' }))).toBe('Settlement');
    expect(queueType(t, item({ entityType: 'other' }))).toBe('other');
  });

  it('ฟิลด์ที่ต่าง = ช่องที่ระบบบัญชีแจ้ง + รหัสที่ยังไม่จับคู่ · ไม่มี = "—" · แถบแดงใช้หัวข้อคู่มือ · รอคิวบอกเวลาลองใหม่', () => {
    expect(queueFields(item())).toBe('—');
    expect(
      queueFields(
        item({
          fields: [{ field: 'customer.taxId', code: 'invalid', message: 'ผิด' }],
          missing: [{ status: 'UNMAPPED', nameTh: 'ค่าขนส่ง', fields: [] } as never],
        }),
      ),
    ).toBe('customer.taxId, ค่าขนส่ง');
    expect(queueMessage(t, item(), (s) => s)).toBe('งวดบัญชีปิดแล้ว');
    expect(
      queueMessage(
        t,
        item({ tab: 'queued', guide: null, errorCode: null, errorMessage: null, nextRunAt: 'X' }),
        (s) => `@${s}`,
      ),
    ).toBe('ระบบจะลองใหม่ @X');
    expect(queueMessage(t, item({ tab: 'done' }), (s) => s)).toBeNull();
  });

  it('ข้อความ 409 ตาม why + เลขซ้ำ', () => {
    const e = (p: object) => new ApiError({ type: '', title: '', status: 409, ...p } as never);
    expect(queueErrorText(e({ code: 'queue_action_not_allowed', why: 'mapping_exists' }), t)).toBe(
      th['erpq.qerr.mapping_exists'],
    );
    expect(queueErrorText(e({ code: 'external_id_conflict' }), t)).toBe(
      th['erpq.qerr.external_id_conflict'],
    );
  });
});

describe('drawer + dialog ของคิว', () => {
  const props = {
    erp: 'KRS',
    connectorId: 'con_1',
    tab: 'sum',
    onTab: () => undefined,
    onClose: () => undefined,
  };

  it('ล้มเหลว: คู่มือ + ปุ่ม ข้ามพร้อมเหตุผล / กรอกเลขเอง / ส่งซ้ำ · ไม่มีสิทธิ์ = ปุ่มหลักปิดพร้อมเหตุ', () => {
    const onRetry = vi.fn();
    const onAsk = vi.fn();
    const r = wrap(
      <QueueDrawer {...props} x={item()} canAct canApprove onRetry={onRetry} onAsk={onAsk} />,
    );
    expect(screen.getByRole('alert').textContent).toContain('งวดบัญชีปิดแล้ว');
    expect(screen.getByText('เปิดงวดแล้วส่งซ้ำ')).toBeTruthy();
    expect(screen.getAllByText('บริษัท ลูกค้า จำกัด').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'ข้ามพร้อมเหตุผล' }));
    expect(onAsk).toHaveBeenLastCalledWith('skip', expect.objectContaining({ id: 'obx_1' }));
    fireEvent.click(screen.getByRole('button', { name: 'กรอกเลขเอง' }));
    expect(onAsk).toHaveBeenLastCalledWith('externalId', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: /ส่งซ้ำ/ }));
    expect(onRetry).toHaveBeenCalled();
    r.unmount();
    // ส่งซ้ำไม่ได้ (ต้องทำในระบบบัญชีเอง) → ปุ่มปิดพร้อมคำแนะนำ · ไม่มีสิทธิ์ = ไม่มีปุ่มรอง
    const r2 = wrap(
      <QueueDrawer
        {...props}
        x={item({ actions: { retry: false, skip: true, externalId: false, approve: false } })}
        canAct
        canApprove
        onRetry={onRetry}
        onAsk={onAsk}
      />,
    );
    const b = screen.getByRole('button', { name: /ส่งซ้ำ/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toBe(th['erpq.hint.noRetry']);
    expect(screen.queryByRole('button', { name: 'กรอกเลขเอง' })).toBeNull();
    r2.unmount();
    wrap(
      <QueueDrawer
        {...props}
        x={item()}
        canAct={false}
        canApprove={false}
        onRetry={onRetry}
        onAsk={onAsk}
      />,
    );
    expect(screen.queryByRole('button', { name: 'ข้ามพร้อมเหตุผล' })).toBeNull();
    expect((screen.getByRole('button', { name: /ส่งซ้ำ/ }) as HTMLButtonElement).title).toBe(
      th['erpq.hint.noAct'],
    );
  });

  it('รออนุมัติแทนที่ (ST8-T13) → ปุ่มหลัก "อนุมัติแทนที่" · รอคิว/สำเร็จ = ปิดหน้าต่าง', () => {
    const onAsk = vi.fn();
    const r = wrap(
      <QueueDrawer
        {...props}
        x={item({
          status: 'SKIPPED',
          operation: 'REPLACE_DOCUMENT',
          errorCode: 'replace_requires_approval',
          actions: { retry: false, skip: true, externalId: false, approve: true },
        })}
        canAct
        canApprove
        onRetry={() => undefined}
        onAsk={onAsk}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /อนุมัติแทนที่/ }));
    expect(onAsk).toHaveBeenLastCalledWith('approve', expect.anything());
    r.unmount();
    wrap(
      <QueueDrawer
        {...props}
        x={item({ tab: 'done', status: 'DONE', errorClass: null, errorCode: null, guide: null })}
        canAct
        canApprove
        onRetry={() => undefined}
        onAsk={onAsk}
      />,
    );
    expect(screen.getByRole('button', { name: /ปิดหน้าต่าง/ })).toBeTruthy();
    expect(screen.getByText('ส่งเข้า KRS สำเร็จ')).toBeTruthy();
  });

  it('ข้ามพร้อมเหตุผล → skip + เหตุผล · กรอกเลขเอง ต้องมีเลขก่อน → externalId + เลข + เหตุผล', () => {
    mutate.mockClear();
    const done = vi.fn();
    const r = wrap(
      <QueueDialog
        kind="skip"
        x={item()}
        erp="KRS"
        connectorId="con_1"
        onClose={() => undefined}
        onDone={done}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'บัญชีบันทึกใน KRS เองแล้ว' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ข้ามรายการ' }));
    expect(mutate).toHaveBeenLastCalledWith({
      action: 'skip',
      id: 'obx_1',
      reason: 'บัญชีบันทึกใน KRS เองแล้ว',
    });
    expect(done).toHaveBeenCalledWith('ข้าม INV-00000-6911-0001 แล้ว');
    r.unmount();
    wrap(
      <QueueDialog
        kind="externalId"
        x={item()}
        erp="KRS"
        connectorId="con_1"
        onClose={() => undefined}
        onDone={done}
      />,
    );
    const [reasonBox, extBox] = screen.getAllByRole('textbox');
    fireEvent.change(reasonBox!, { target: { value: 'เอกสารอยู่ใน KRS แล้ว ตรวจแล้ว' } });
    const ok = screen.getByRole('button', { name: 'บันทึกเลข' }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.change(extBox!, { target: { value: ' 100042 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกเลข' }));
    expect(mutate).toHaveBeenLastCalledWith({
      action: 'externalId',
      id: 'obx_1',
      reason: 'เอกสารอยู่ใน KRS แล้ว ตรวจแล้ว',
      externalId: '100042',
    });
  });
});
