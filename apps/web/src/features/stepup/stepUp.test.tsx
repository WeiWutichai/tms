import { ReasonDialog } from '@tms/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import { I18nProvider } from '../../i18n';
import { th } from '../../i18n/th';

/**
 * D-67 (PO 22 พ.ย. 2569) step-up 2FA ก่อนรายการเสี่ยง — กล่องยืนยันกลาง (`withStepUp` + `StepUpHost`)
 * และแบบในกล่องเหตุผล (`useInlineStepUp` — ยกเลิกใบแจ้งหนี้/ใบวางบิลที่ออกแล้ว แบบ ApproveDialog /settle)
 */
const otpResult: { current: 'ok' | 'bad' } = { current: 'ok' };
const POST = vi.fn((p: string, _o: unknown) =>
  p === '/v1/auth/step-up' && otpResult.current === 'ok'
    ? Promise.resolve({
        data: { stepUpToken: 'su-1', expiresIn: 300 },
        response: { ok: true, status: 200 },
      })
    : Promise.resolve({
        error: { code: 'invalid_otp', status: 401, title: '', type: '' },
        response: { ok: false, status: 401 },
      }),
);
const GET = vi.fn();
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: {
    GET: (p: string, o: unknown) => GET(p, o),
    POST: (p: string, o: unknown) => POST(p, o),
  },
}));

const { withStepUp, StepUpHost, StepUpCancelled, clearStepUp, useInlineStepUp, cachedStepUp } =
  await import('./stepUp');
const { downloadFile } = await import('../master/download');

const stepUpErr = () =>
  new ApiError({ code: 'step_up_required', status: 403, title: '', type: '' } as never);
const group = () => screen.queryByRole('group', { name: th['stepUp.title'] });
async function typeOtp(otp = '123456') {
  const g = await screen.findByRole('group', { name: th['stepUp.title'] });
  fireEvent.change(g.querySelector('input')!, { target: { value: otp } });
  fireEvent.click(screen.getByRole('button', { name: th['mfa.submit'] }));
}
const host = () =>
  render(
    <I18nProvider>
      <StepUpHost />
    </I18nProvider>,
  );

beforeEach(() => {
  clearStepUp();
  otpResult.current = 'ok';
  POST.mockClear();
  GET.mockReset();
});

describe('withStepUp + StepUpHost (กล่องยืนยันกลาง)', () => {
  it('API ตอบ step_up_required → กล่องยืนยัน (ข้อความรายการเสี่ยง) → ยืนยันรหัส → ส่งซ้ำพร้อม token · ครั้งต่อไปใช้ token เดิม', async () => {
    host();
    const send = vi.fn((su?: string) =>
      su ? Promise.resolve(`ok:${su}`) : Promise.reject(stepUpErr()),
    );
    const p = withStepUp(send);
    expect(await screen.findByText(th['stepUp.descAction'])).toBeInTheDocument();
    await typeOtp();
    await expect(p).resolves.toBe('ok:su-1');
    expect(POST).toHaveBeenCalledWith('/v1/auth/step-up', { body: { otp: '123456' } });
    expect(send.mock.calls.map((c) => c[0])).toEqual([undefined, 'su-1']);
    await waitFor(() => expect(group()).toBeNull());
    // ภายในอายุ token: ส่งพร้อม token ตั้งแต่ครั้งแรก ไม่ถามซ้ำ
    expect(cachedStepUp()).toBe('su-1');
    const again = vi.fn((su?: string) => Promise.resolve(su));
    await expect(withStepUp(again)).resolves.toBe('su-1');
    expect(group()).toBeNull();
  });

  it('รหัสผิด → ข้อความ error ในกล่อง (ยังไม่ส่งซ้ำ) · กดยกเลิก → StepUpCancelled', async () => {
    host();
    otpResult.current = 'bad';
    const send = vi.fn(() => Promise.reject(stepUpErr()));
    const p = withStepUp(send);
    await typeOtp('000000');
    expect(await screen.findByText(th['problem.invalid_otp'])).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: th['common.cancel'] }));
    await expect(p).rejects.toBeInstanceOf(StepUpCancelled);
    await waitFor(() => expect(group()).toBeNull());
  });

  it('error อื่นโยนต่อตามเดิม (ไม่เปิดกล่อง)', async () => {
    host();
    const other = new ApiError({ code: 'conflict', status: 409, title: '', type: '' } as never);
    await expect(withStepUp(() => Promise.reject(other))).rejects.toBe(other);
    expect(group()).toBeNull();
  });

  it('ส่งออกทั้งตาราง (downloadFile): 403 step_up_required → ยืนยัน → ดาวน์โหลดซ้ำพร้อม X-Step-Up', async () => {
    host();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    GET.mockImplementation((_p: string, o: { headers: Record<string, string> }) =>
      Promise.resolve(
        o.headers['X-Step-Up']
          ? {
              data: new Blob(['x']),
              response: new Response(null, {
                status: 200,
                headers: { 'content-disposition': 'attachment; filename="customers.xlsx"' },
              }),
            }
          : {
              error: { code: 'step_up_required', status: 403, title: '', type: '' },
              response: new Response(null, { status: 403 }),
            },
      ),
    );
    const p = downloadFile('/v1/customers/export', { format: 'xlsx' });
    await typeOtp();
    await act(() => p);
    expect(GET.mock.calls.map((c) => (c[1] as { headers: object }).headers)).toEqual([
      {},
      { 'X-Step-Up': 'su-1' },
    ]);
  });
});

/** harness แบบเดียวกับ dialog ยกเลิกใบแจ้งหนี้ (InvoiceDrawer) / ใบวางบิล (BillingNoteDrawer) */
function VoidDialog({ send }: { send: (reason: string, su?: string) => Promise<void> }) {
  const su = useInlineStepUp();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = (r: string, tok?: string) => {
    setBusy(true);
    return send(r, tok).then(
      () => setDone(true),
      (e) => {
        setBusy(false);
        setErr(e);
        su.onError(e);
      },
    );
  };
  if (done) return <p>done</p>;
  return (
    <ReasonDialog
      open
      title="ยกเลิกใบ"
      label="เหตุผล"
      okLabel="ยกเลิกใบ"
      cancelLabel="ปิด"
      closeLabel="ปิด"
      busy={busy}
      error={su.error ?? (err && !su.hide(err) ? 'ผิดพลาด' : null)}
      extra={su.box((tok) => void run(reason, tok))}
      onClose={() => {}}
      onOk={(r) => {
        setReason(r);
        void run(r, cachedStepUp());
      }}
    />
  );
}

describe('useInlineStepUp (กล่องยืนยันใน dialog เหตุผล — ยกเลิกใบที่ออกแล้ว)', () => {
  it('ยกเลิก → step_up_required → กล่องยืนยันใต้ช่องเหตุผล (ไม่ขึ้นข้อความ error) → ยืนยัน → ส่งซ้ำด้วยเหตุผลเดิม + token', async () => {
    const send = vi.fn((_r: string, su?: string) =>
      su ? Promise.resolve() : Promise.reject(stepUpErr()),
    );
    render(
      <I18nProvider>
        <VoidDialog send={send} />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ลูกค้าขอยกเลิกใบนี้' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกใบ' }));
    const g = await screen.findByRole('group', { name: th['stepUp.title'] });
    expect(screen.getByRole('dialog')).toContainElement(g);
    expect(screen.queryByText('ผิดพลาด')).toBeNull();
    await typeOtp();
    expect(await screen.findByText('done')).toBeInTheDocument();
    expect(send.mock.calls).toEqual([
      ['ลูกค้าขอยกเลิกใบนี้', undefined],
      ['ลูกค้าขอยกเลิกใบนี้', 'su-1'],
    ]);
  });

  it('ยกเลิกกล่องยืนยัน → กล่องหาย dialog ยังเปิด · error อื่นแสดงตามปกติ', async () => {
    const send = vi
      .fn<(r: string, su?: string) => Promise<void>>()
      .mockRejectedValueOnce(stepUpErr())
      .mockRejectedValueOnce(new ApiError({ code: 'conflict', status: 409 } as never));
    render(
      <I18nProvider>
        <VoidDialog send={send} />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ลูกค้าขอยกเลิกใบนี้' } });
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกใบ' }));
    await screen.findByRole('group', { name: th['stepUp.title'] });
    fireEvent.click(screen.getByRole('button', { name: th['common.cancel'] }));
    await waitFor(() => expect(group()).toBeNull());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกใบ' }));
    expect(await screen.findByText('ผิดพลาด')).toBeInTheDocument();
    expect(group()).toBeNull();
  });
});
