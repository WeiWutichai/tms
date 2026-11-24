import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { Vehicle } from './useVehicles';

/** กรอบรูปรถในโปรไฟล์รถ (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) */
const GET = vi.fn();
const POST = vi.fn();
const mutateAsync = vi.fn();
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: { GET: (...a: unknown[]) => GET(...a), POST: (...a: unknown[]) => POST(...a) },
  unwrap: (p: Promise<unknown>) => p,
}));
vi.mock('./useVehicles', async (orig) => ({
  ...(await orig<typeof import('./useVehicles')>()),
  useUpdateVehicle: () => ({ mutateAsync }),
}));
const { VehiclePhoto } = await import('./VehiclePhoto');

const veh = (o: Partial<Vehicle> = {}) =>
  ({
    id: 'veh_1',
    version: 4,
    status: 'ready',
    unitRole: 'SINGLE',
    photoDocumentIds: [],
    ...o,
  }) as Vehicle;
const show = (v: Vehicle, canWrite = true) => {
  const onToast = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <VehiclePhoto v={v} canWrite={canWrite} onToast={onToast} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return onToast;
};

describe('VehiclePhoto', () => {
  beforeEach(() => {
    GET.mockReset();
    POST.mockReset();
    mutateAsync.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    );
  });

  it('ยังไม่มีรูป + มีสิทธิ์ → กดกรอบเลือกรูป → อัปโหลด + PATCH รูปใหม่เป็นรูปแรก (If-Match version)', async () => {
    POST.mockResolvedValueOnce({ id: 'doc_9', uploadUrl: '/v1/documents/doc_9/content?sig=x' });
    mutateAsync.mockResolvedValueOnce({});
    const onToast = show(veh({ photoDocumentIds: ['doc_1'] }));
    GET.mockResolvedValue({ downloadUrl: null });
    expect(screen.getByRole('button', { name: 'เปลี่ยนรูปรถ' })).toBeTruthy();
    const f = new File([new Uint8Array([1])], 'truck.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('vprof-photo-input'), { target: { files: [f] } });
    });
    expect(POST).toHaveBeenCalledWith('/v1/documents', {
      body: { kind: 'OTHER', mime: 'image/png', bytes: 1, filename: 'truck.png' },
    });
    expect(mutateAsync).toHaveBeenCalledWith({
      id: 'veh_1',
      version: 4,
      body: { unitRole: 'SINGLE', photoDocumentIds: ['doc_9', 'doc_1'] },
    });
    expect(onToast).toHaveBeenCalledWith('บันทึกรูปรถแล้ว');
  });

  it('ไฟล์ไม่ใช่รูป → แจ้ง ไม่อัปโหลด', async () => {
    const onToast = show(veh());
    const f = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('vprof-photo-input'), { target: { files: [f] } });
    });
    expect(POST).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith('ไฟล์ต้องเป็นรูป JPEG / PNG / WebP ไม่เกิน 10 MB');
  });

  it('ไม่มีสิทธิ์ / รถปลดระวาง → กรอบอ่านอย่างเดียว (ไม่มีปุ่ม)', () => {
    show(veh(), false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('รูปรถ')).toBeTruthy();
  });
});
