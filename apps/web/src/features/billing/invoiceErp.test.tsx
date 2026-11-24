import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, type T } from '../../i18n';
import { th, type MessageKey } from '../../i18n/th';

/**
 * PO 24 พ.ย. 2569 (ประกอบจากโครงสร้างต้นแบบ) drawer ใบแจ้งหนี้:
 * Q-D64 กล่องเตือน `erpWarnings` (ชื่อบริษัทรถร่วมแทนชื่อคนขับ) ตั้งแต่ร่าง ·
 * kv "สถานะใน {ERP}" ของต้นแบบ + Q-SPLIT เลขเอกสารฝั่งระบบบัญชีทุกใบ
 */
let inv: Record<string, unknown> = {};
vi.mock('./useInvoices', () => ({
  useInvoice: () => ({ data: inv }),
  useCustomerTerms: () => ({ data: { defaultVatType: 'EXEMPT_TRANSPORT' } }),
  useCancelDraft: () => ({ mutate: vi.fn(), isPending: false }),
  useFinalize: () => ({ mutate: vi.fn(), isPending: false }),
  useVoidInvoice: () => ({ mutate: vi.fn(), isPending: false, reset: vi.fn() }),
  openIssuedPdf: vi.fn(),
  openProforma: vi.fn(),
}));
vi.mock('./usePayments', () => ({ useInvoicePayments: () => ({ data: { data: [] } }) }));
vi.mock('../erp/useQueue', () => ({
  useErpConnectors: () => ({
    list: [{ id: 'con_1', adapterKey: 'krs', displayName: 'KRS' }],
    current: null,
    pick: vi.fn(),
  }),
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { scopes: ['*'], tenant: { yearStyle: 'BE' } } }),
}));

const { InvoiceDrawer, syncKv } = await import('./InvoiceDrawer');

const t = ((k: MessageKey, v?: Record<string, unknown>) =>
  Object.entries(v ?? {}).reduce(
    (s, [a, b]) => s.replace(`{${a}}`, String(b)),
    (th as Record<string, string>)[k] ?? k,
  )) as unknown as T;

const sync = (over: Record<string, unknown> = {}) =>
  ({
    connectorId: 'con_1',
    state: 'SYNCED',
    externalId: '100001',
    externalDocNo: 'SA-1',
    externalStatus: null,
    lastSyncedAt: null,
    reconcileState: null,
    reconciledAt: null,
    postedAt: null,
    externalDocuments: [],
    ...over,
  }) as never;

const base = {
  id: 'ivc_1',
  version: 1,
  status: 'DRAFT',
  invoiceNo: null,
  customer: { id: 'cus_1', legalName: 'บริษัท ลูกค้า จำกัด', code: 'C001', taxId: null },
  periodFrom: null,
  periodTo: null,
  deliveryOrderCount: 0,
  deliveryOrders: [],
  lines: [],
  sellSubtotalExempt: '0.00',
  sellSubtotalVatable: '0.00',
  sellVatAmount: '0.00',
  sellTotal: '0.00',
  sellPaidAmount: '0.00',
  sellOutstanding: '0.00',
  createdAt: '2026-11-20T03:00:00Z',
  replacesInvoice: null,
  replacedByInvoice: null,
};

const draw = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <I18nProvider lang="th">
          <InvoiceDrawer
            id="ivc_1"
            canDraft
            canFinalize
            onClose={() => undefined}
            onToast={() => undefined}
          />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('drawer ใบแจ้งหนี้ — ระบบบัญชี', () => {
  it('syncKv: สถานะซิงก์ (แยกจากสถานะเอกสาร) + เลขเดียว / หลายใบ (Q-SPLIT) · ไม่มีผลการส่ง = ไม่แสดง', () => {
    expect(syncKv(t, null, 'KRS')).toEqual([]);
    expect(syncKv(t, sync(), 'KRS')).toEqual([
      { k: 'สถานะใน KRS', v: 'ซิงก์แล้ว' },
      { k: 'เลขที่ใน KRS', v: 'SA-1' },
    ]);
    expect(
      syncKv(
        t,
        sync({
          state: 'MISMATCH',
          externalDocuments: [
            {
              ref: 'INV-1',
              externalId: '100001',
              externalDocNo: 'SA-1',
              group: 'EXEMPT_TRANSPORT',
            },
            { ref: 'INV-1-V7', externalId: '100002', externalDocNo: null, group: 'VAT_7' },
          ],
        }),
        'KRS',
      ),
    ).toEqual([
      { k: 'สถานะใน KRS', v: 'ไม่ตรง' },
      { k: 'เลขที่ใน KRS (2 ใบ)', v: 'SA-1, 100002' },
    ]);
    expect(
      syncKv(t, sync({ state: 'PENDING', externalId: null, externalDocNo: null }), 'KRS'),
    ).toEqual([{ k: 'สถานะใน KRS', v: 'รอส่ง' }]);
  });

  it('Q-D64: ร่างมีคำเตือน → กล่องเตือนของต้นแบบ (ข้อความจาก API + เลข DO) · ไม่บล็อกปุ่มออกเอกสาร', () => {
    inv = {
      ...base,
      erpWarnings: [
        {
          code: 'erp_driver_name_substituted',
          message: 'ใบนี้จะส่งชื่อบริษัทรถร่วมแทนชื่อคนขับเข้าระบบบัญชี (2 DO)',
          connectorId: 'con_1',
          deliveryOrderNos: ['DO-1', 'DO-2'],
        },
      ],
    };
    draw();
    const w = screen.getByTestId('erp-warning');
    expect(w.textContent).toContain('ใบนี้จะส่งชื่อบริษัทรถร่วมแทนชื่อคนขับเข้าระบบบัญชี (2 DO)');
    expect(w.textContent).toContain('DO-1, DO-2');
    expect((screen.getByRole('button', { name: /ออกเอกสาร/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('ใบที่ส่งแล้วแยก 2 เอกสาร → kv สถานะ + เลขทุกใบ · ไม่มีคำเตือน = ไม่มีกล่อง', () => {
    inv = {
      ...base,
      status: 'ISSUED',
      invoiceNo: 'INV-1',
      issueDate: '2026-11-21',
      dueDate: '2026-12-21',
      erpWarnings: [],
      sync: sync({
        externalDocuments: [
          { ref: 'INV-1', externalId: '100001', externalDocNo: 'SA-1', group: 'EXEMPT_TRANSPORT' },
          { ref: 'INV-1-V7', externalId: '100002', externalDocNo: 'SA-2', group: 'VAT_7' },
        ],
      }),
    };
    draw();
    expect(screen.queryByTestId('erp-warning')).toBeNull();
    expect(screen.getByText('สถานะใน KRS')).toBeTruthy();
    expect(screen.getByText('เลขที่ใน KRS (2 ใบ)')).toBeTruthy();
    expect(screen.getByText('SA-1, SA-2')).toBeTruthy();
  });
});
