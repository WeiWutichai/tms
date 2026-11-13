import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * แท็บเอกสารแนบของผู้รับเหมา: เหตุผลที่พิมพ์ใน dialog ยกเลิกลิงก์/ไม่อนุมัติ ต้องไม่หายเมื่อรายการโหลดใหม่ (refetch,
 * แคชแทนแถวด้วย object ใหม่) และเปิดยกเลิกลิงก์ถัดไปต้องเริ่มจากช่องว่าง — บั๊ก E2E carrier-upload ค้าง 90 วิ
 */
const link = (id: string) => ({
  id,
  carrierId: 'car_1',
  status: 'active',
  expiresAt: '2026-12-13T00:00:00.000Z',
  createdAt: '2026-11-13T00:00:00.000Z',
  revokedAt: null,
});
const sub = {
  id: 'cds_1',
  status: 'pending_review',
  docType: 'INSURANCE',
  title: null,
  docNo: 'POL-1',
  vehicle: { id: 'veh_1', plate: '76-0001' },
  driver: null,
  files: [],
  submittedAt: '2026-11-13T00:00:00.000Z',
  expiresOn: '2027-11-13',
  reviewReason: null,
};

const gets: Record<string, () => unknown> = {};
const ok = (data: unknown) => Promise.resolve({ data, response: { ok: true, status: 200 } });
const GET = vi.fn((path: string) => ok(gets[path]?.() ?? { data: [] }));
const POST = vi.fn((path: string, o: { params: { path: { id: string } } }) =>
  ok(path.endsWith('/revoke') ? { ...link(o.params.path.id), status: 'revoked' } : {}),
);
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: {
    GET: (p: string) => GET(p),
    POST: (p: string, o: { params: { path: { id: string } } }) => POST(p, o),
  },
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' } } }),
}));

const { CarrierDocsTab } = await import('./CarrierDocsTab');

let qc: QueryClient;
beforeEach(() => {
  GET.mockClear();
  POST.mockClear();
  // ทุกครั้งที่โหลดได้ object ใหม่ (เหมือน API จริง)
  gets['/v1/carriers/{id}/upload-links'] = () => ({ data: [link('cul_1'), link('cul_2')] });
  gets['/v1/carrier-doc-submissions'] = () => ({ data: [{ ...sub }] });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider lang="th">
        <CarrierDocsTab carrierId="car_1" canWrite />
      </I18nProvider>
    </QueryClientProvider>,
  );
});

const REASON = 'ทดสอบยกเลิกลิงก์ยาวพอ';
const TITLE = 'ยกเลิกลิงก์อัปโหลดเอกสาร';
const refetchAll = () => act(() => qc.refetchQueries());

describe('CarrierDocsTab — เหตุผลใน dialog ไม่หายระหว่างโหลดใหม่', () => {
  it('ยกเลิกลิงก์: refetch ระหว่าง dialog เปิด → เหตุผลยังอยู่ · ลิงก์ถัดไปเริ่มว่าง', async () => {
    const revokeBtns = await screen.findAllByRole('button', { name: 'ยกเลิกลิงก์' });
    fireEvent.click(revokeBtns[0]!);
    let dlg = screen.getByRole('dialog', { name: TITLE });
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: REASON } });
    await refetchAll();
    dlg = screen.getByRole('dialog', { name: TITLE });
    expect(within(dlg).getByRole('textbox')).toHaveValue(REASON);
    // server หลังยกเลิก
    gets['/v1/carriers/{id}/upload-links'] = () => ({
      data: [{ ...link('cul_1'), status: 'revoked' }, link('cul_2')],
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'ยกเลิกลิงก์' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(POST).toHaveBeenCalledWith('/v1/carrier-upload-links/{id}/revoke', {
      params: { path: { id: 'cul_1' } },
      body: { reason: REASON },
    });

    // ลิงก์ที่ 2 — ช่องเหตุผลว่าง พิมพ์แล้วโหลดใหม่ (แคชแทนแถว) ก็ยังอยู่
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'ยกเลิกลิงก์' })).toHaveLength(1),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกลิงก์' }));
    dlg = screen.getByRole('dialog', { name: TITLE });
    expect(within(dlg).getByRole('textbox')).toHaveValue('');
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: `${REASON} 2` } });
    await refetchAll();
    dlg = screen.getByRole('dialog', { name: TITLE });
    expect(within(dlg).getByRole('textbox')).toHaveValue(`${REASON} 2`);
    expect(within(dlg).getByRole('button', { name: 'ยกเลิกลิงก์' })).toBeEnabled();
  });

  it('ไม่อนุมัติ: refetch รายการเอกสารระหว่าง dialog เปิด → เหตุผลยังอยู่', async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'ไม่อนุมัติ' }));
    let dlg = screen.getByRole('dialog', { name: /^ไม่อนุมัติ / });
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: REASON } });
    await refetchAll();
    dlg = screen.getByRole('dialog', { name: /^ไม่อนุมัติ / });
    expect(within(dlg).getByRole('textbox')).toHaveValue(REASON);
    expect(within(dlg).getByRole('button', { name: 'ไม่อนุมัติ' })).toBeEnabled();
  });
});
