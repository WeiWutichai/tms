import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api';
import { I18nProvider } from '../i18n';
import { th } from '../i18n/th';

/**
 * P1-ST2-T06 คิวอนุมัติการสมัคร (Console `q`): ตารางเรียงตามเวลารอ + แถวเกิน SLA สีรอ · drawer เทียบ ที่กรอก | RD | DBD
 * ไฮไลต์ช่องที่ต่าง (เกณฑ์ตรวจรับ: ชื่อต่างจาก RD → ช่องชื่อถูกไฮไลต์) · ปุ่มตัดสินเฉพาะ owner/support (§11.4)
 */
let role = 'SUPPORT';
const get = vi.fn();
const post = vi.fn((_p: string, _o: unknown) => Promise.resolve({ data: undefined }));
vi.mock('./session', async (orig) => ({
  ...(await orig<typeof import('./session')>()),
  useStaff: () => ({ data: { name: 'มาลี', role } }),
  consoleApi: {
    GET: (p: string, o: unknown) => get(p, o),
    POST: (p: string, o: unknown) => post(p, o),
    PUT: (p: string, o: unknown) => post(p, o),
  },
  cunwrap: (p: Promise<{ data: unknown }>) => p.then((r) => r.data),
  // hook ใน session ปิดทับ consoleApi ตัวจริง — ใช้ตัว mock แทน
  useSignupQueue: () =>
    useQuery({
      queryKey: ['console', 'signup-queue'],
      queryFn: () =>
        get('/v1/platform/signup-queue', undefined).then((r: { data: unknown }) => r.data),
    }),
}));
const { QueuePage } = await import('./Queue');

const item = {
  id: 'ten_aaaa',
  kind: 'signup',
  name: 'บจก. ศรีไทยขนส่ง',
  taxId: '0105567153766',
  branchCode: '00000',
  applicantName: 'พรทิพย์ ศรีวงศ์',
  applicantEmail: 'porntip@srithai.co.th',
  fleetSizeOwn: 20,
  fleetSizeSubcon: 8,
  check: 'mismatch',
  status: 'pending',
  flags: ['no_accounting_software'],
  submittedAt: '2026-11-24T02:12:00.000Z',
  waitingSince: '2026-11-24T02:12:00.000Z',
  overSla: true,
};
const join = {
  ...item,
  id: 'jrq_bbbb',
  kind: 'join',
  name: 'บริษัท ศรีไทยขนส่ง จำกัด',
  check: 'duplicate',
  flags: [],
  overSla: false,
  fleetSizeOwn: null,
  fleetSizeSubcon: null,
};
const detail = {
  ...item,
  rdStatus: 'found',
  compare: [
    {
      field: 'name',
      entered: 'บจก. ศรีไทยขนส่ง',
      rd: 'ศรีไทย ทรานสปอร์ต จำกัด',
      dbd: null,
      differs: true,
    },
    { field: 'address', entered: '99/1 แสมดำ', rd: '99/1 แสมดำ', dbd: null, differs: false },
    { field: 'branch', entered: 'สำนักงานใหญ่', rd: 'สำนักงานใหญ่', dbd: null, differs: false },
    { field: 'businessStatus', entered: null, rd: null, dbd: null, differs: false },
    { field: 'vatRegisteredSince', entered: null, rd: '2024-05-02', dbd: null, differs: false },
    { field: 'tsic', entered: null, rd: null, dbd: null, differs: false },
  ],
  certificate: { filename: 'cert.pdf', mimeType: 'application/pdf', sizeBytes: 2048 },
  duplicate: null,
  history: [
    {
      kind: 'tenant',
      name: 'บริษัท อื่นขนส่ง จำกัด',
      status: 'trialing',
      match: 'ip',
      at: '2026-11-20T02:00:00.000Z',
    },
  ],
  accountingSoftware: 'none',
  planCode: 'std',
  ownerDueAt: null,
  verification: null,
};

function show(path = '/console/queue') {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/console/queue" element={<QueuePage />} />
            <Route path="/console/queue/:id" element={<QueuePage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  role = 'SUPPORT';
  queryClient.clear();
  get.mockImplementation((p: string) =>
    Promise.resolve({
      data:
        p === '/v1/platform/signup-queue'
          ? { policy: 'auto_when_verified', data: [item, join] }
          : detail,
    }),
  );
  post.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('คิวอนุมัติการสมัคร (P1-ST2-T06)', () => {
  it('ตาราง: คอลัมน์ตามต้นแบบ · คำขอเข้าร่วม "(ขอเข้าร่วม)" · ผลตรวจ · แถวเกิน SLA สีรอ · ธง R-02', async () => {
    show();
    const row = (await screen.findByText('บจก. ศรีไทยขนส่ง')).closest('tr')!;
    expect(row).toHaveStyle({ background: '#FCF0DC' });
    expect(within(row).getByText(th['con.q.check.mismatch'])).toBeInTheDocument();
    expect(within(row).getByText('20 + 8 รถร่วม')).toBeInTheDocument();
    expect(within(row).getByText(th['con.q.flag.no_accounting_software'])).toBeInTheDocument();
    const jr = screen.getByText(`บริษัท ศรีไทยขนส่ง จำกัด ${th['con.q.joinTag']}`).closest('tr')!;
    expect(jr).not.toHaveAttribute('data-over-sla');
    expect(within(jr).getByText(th['con.q.check.duplicate'])).toBeInTheDocument();
    for (const k of ['co', 'tax', 'who', 'veh', 'check', 'status', 'at'] as const)
      expect(screen.getByRole('columnheader', { name: th[`con.q.col.${k}`] })).toBeInTheDocument();
    expect(
      screen.getByText(th['con.q.policy'].replace('{p}', th['con.q.policyAuto'])),
    ).toBeInTheDocument();
  });

  it('drawer: ชื่อที่กรอกต่างจาก RD → ช่องชื่อถูกไฮไลต์ · DBD = ไม่พบ/เรียกไม่สำเร็จ · ประวัติ IP · ไฟล์หนังสือรับรอง', async () => {
    show('/console/queue/ten_aaaa');
    const dlg = await screen.findByRole('dialog');
    const nameRow = await waitFor(() => {
      const r = dlg.querySelector('[data-field="name"]');
      if (!r) throw new Error('no row');
      return r as HTMLElement;
    });
    const cell = within(nameRow).getByText('บจก. ศรีไทยขนส่ง');
    expect(cell).toHaveAttribute('data-differs', 'true');
    expect(cell).toHaveStyle({ background: '#FBE9E7' });
    const addr = dlg.querySelector('[data-field="address"]') as HTMLElement;
    expect(within(addr).getAllByText('99/1 แสมดำ')[0]).not.toHaveAttribute('data-differs');
    expect(within(nameRow).getByText(th['con.q.notFound'])).toBeInTheDocument();
    expect(within(dlg).getByText('บริษัท อื่นขนส่ง จำกัด')).toBeInTheDocument();
    expect(within(dlg).getByText('cert.pdf')).toBeInTheDocument();
    expect(within(dlg).getByRole('link', { name: th['con.q.colDbd'] })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });

  it('support อนุมัติ: เหตุผล ≥ 10 + เลือกแก้ชื่อตาม RD (PLT-106) → POST approve', async () => {
    show('/console/queue/ten_aaaa');
    fireEvent.click(await screen.findByRole('button', { name: th['con.q.approve'] }));
    const dlg = await screen.findByRole('dialog', {
      name: th['con.q.approveT'].replace('{n}', 'บจก. ศรีไทยขนส่ง'),
    });
    const ok = within(dlg).getByRole('button', { name: th['con.q.approve'] });
    expect(ok).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText(th['con.q.official']), { target: { value: 'rd' } });
    fireEvent.change(within(dlg).getByLabelText(th['con.reason']), {
      target: { value: 'โทรยืนยันกับผู้สมัครแล้ว' },
    });
    fireEvent.click(ok);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]![0]).toBe('/v1/platform/signup-queue/{id}/approve');
    expect(post.mock.calls[0]![1]).toMatchObject({
      params: { path: { id: 'ten_aaaa' } },
      body: { reason: 'โทรยืนยันกับผู้สมัครแล้ว', applyOfficialData: true },
    });
  });

  it('ปฏิเสธ: ปุ่มใช้ไม่ได้จนกว่าเหตุผลครบ 10 ตัว → POST reject', async () => {
    show('/console/queue/ten_aaaa');
    fireEvent.click(await screen.findByRole('button', { name: th['con.q.reject'] }));
    const dlg = await screen.findByRole('dialog', {
      name: th['con.q.rejectT'].replace('{n}', 'บจก. ศรีไทยขนส่ง'),
    });
    const ok = within(dlg).getByRole('button', { name: th['con.q.reject'] });
    fireEvent.change(within(dlg).getByLabelText(th['con.reason']), { target: { value: 'สั้น' } });
    expect(ok).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText(th['con.reason']), {
      target: { value: 'เอกสารไม่ตรงกับเลขผู้เสียภาษี' },
    });
    fireEvent.click(ok);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/platform/signup-queue/{id}/reject', {
        params: { path: { id: 'ten_aaaa' } },
        body: { reason: 'เอกสารไม่ตรงกับเลขผู้เสียภาษี' },
      }),
    );
  });

  it('finance (BILLING) ดูได้แต่ไม่มีปุ่มตัดสิน (§11.4)', async () => {
    role = 'BILLING';
    show('/console/queue/ten_aaaa');
    await screen.findByText('cert.pdf');
    expect(screen.queryByRole('button', { name: th['con.q.approve'] })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: th['con.q.reject'] })).not.toBeInTheDocument();
  });
});
