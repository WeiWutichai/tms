import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** แท็บเอกสารแนบของคนขับ/ผู้รับเหมา (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) */
const GET = vi.fn();
const POST = vi.fn();
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
  unwrap: (p: Promise<unknown>) => p,
}));
vi.mock('../../shell/AppShell', () => ({
  useMe: () => ({ data: { tenant: { yearStyle: 'BE' }, scopes: [] } }),
}));
const { EntityAttachments } = await import('./EntityAttachments');

const ROW = {
  id: 'doc_1',
  attachType: 'VAT_REG',
  filename: 'pp20.pdf',
  mime: 'application/pdf',
  bytes: 100,
  createdAt: '2026-11-24T03:00:00Z',
  createdBy: 'u1',
};
const show = (canWrite = true) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <EntityAttachments owner="carrier" id="car_1" canWrite={canWrite} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('EntityAttachments', () => {
  beforeEach(() => {
    GET.mockReset();
    POST.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    );
  });

  it('ว่าง → เลือกประเภท สัญญาจ้าง + แนบ PDF → อัปโหลด (entityType carrier) + ผูก → แถวใหม่', async () => {
    GET.mockResolvedValue({ data: [] });
    POST.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/documents'
          ? { id: 'doc_9', uploadUrl: '/v1/documents/doc_9/content?s=1' }
          : { data: [{ ...ROW, id: 'doc_9', attachType: 'CONTRACT', filename: 'c.pdf' }] },
      ),
    );
    show();
    expect(await screen.findByText('ยังไม่มี ภ.พ.20 / สัญญาจ้าง')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ประเภทไฟล์'), { target: { value: 'CONTRACT' } });
    const f = new File(['%PDF'], 'c.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('att-file-carrier'), { target: { files: [f] } });
    });
    expect(POST).toHaveBeenCalledWith('/v1/documents', {
      body: {
        kind: 'CONTRACT',
        mime: 'application/pdf',
        bytes: 4,
        filename: 'c.pdf',
        entityType: 'carrier',
      },
    });
    expect(POST).toHaveBeenCalledWith('/v1/carriers/{id}/attachments', {
      params: { path: { id: 'car_1' } },
      body: { documentId: 'doc_9', attachType: 'CONTRACT' },
    });
    expect(await screen.findByText('สัญญาจ้าง · c.pdf')).toBeTruthy();
  });

  it('เอาออกต้องกรอกเหตุผล ≥ 10 · ไม่มีสิทธิ์ = ไม่มีปุ่มแนบ/เอาออก', async () => {
    GET.mockResolvedValue({ data: [ROW] });
    POST.mockResolvedValueOnce({ data: [] });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'เอาไฟล์ออก ภ.พ.20' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'แนบผิดไฟล์ ใช้ฉบับใหม่' } });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'เอาไฟล์ออก' }).at(-1)!);
    });
    expect(POST).toHaveBeenCalledWith('/v1/carriers/{id}/attachments/remove', {
      params: { path: { id: 'car_1' } },
      body: { documentId: 'doc_1', reason: 'แนบผิดไฟล์ ใช้ฉบับใหม่' },
    });
  });

  it('ไม่มีสิทธิ์แก้: เห็นรายการ ไม่มีปุ่มแนบ/เอาออก', async () => {
    GET.mockResolvedValue({ data: [ROW] });
    show(false);
    expect(await screen.findByText('ภ.พ.20 · pp20.pdf')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'แนบไฟล์' })).toBeNull();
    expect(screen.queryByRole('button', { name: /เอาไฟล์ออก/ })).toBeNull();
  });

  it('ไฟล์ข้อมูลส่วนบุคคล (หน้าสมุดบัญชี / บัตร) ผู้ไม่มีสิทธิ์ดูค่าเต็ม → เห็นในรายการ แต่เปิดไม่ได้ (ไอคอนล็อก)', async () => {
    GET.mockResolvedValue({
      data: [
        { ...ROW, id: 'doc_b', attachType: 'BANK_BOOK', filename: 'bank.pdf' },
        { ...ROW, id: 'doc_c', attachType: 'ID_CARD', filename: 'id.jpg' },
      ],
    });
    show(false);
    expect(await screen.findByText('หน้าสมุดบัญชี · bank.pdf')).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'ไม่มีสิทธิ์เปิดไฟล์ข้อมูลส่วนบุคคลนี้ หน้าสมุดบัญชี' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ดาวน์โหลด/ })).toBeNull();
  });
});
