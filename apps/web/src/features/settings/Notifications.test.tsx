import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const EVENTS = [
  'order.on_hold',
  'subcon.no_response',
  'dispute',
  'approval.requested',
  'document.expiring',
  'connector.down',
  'delivery_order.unbilled',
  'payment.due',
];
const prefs = () => ({
  events: EVENTS.map((event) => ({
    event,
    inApp: true,
    email: event !== 'order.on_hold',
    line: false,
    pendingTask: event === 'dispute' ? 'ST6-T06' : null,
  })),
  dailyDigest: true,
  version: 2,
});
const GET = vi.fn();
const PATCH = vi.fn();
vi.mock('../../api', () => ({
  api: { GET: (...a: unknown[]) => GET(...a), PATCH: (...a: unknown[]) => PATCH(...a) },
  unwrap: async (p: Promise<{ data: unknown }>) => (await p).data,
  ApiError: class ApiError extends Error {
    constructor(public problem: { code: string }) {
      super(problem.code);
    }
  },
}));

const { NotificationsSection } = await import('./Notifications');

const wrap = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider lang="th">
        <NotificationsSection />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('ตั้งค่า → การแจ้งเตือน (ST9-T08)', () => {
  beforeEach(() => {
    GET.mockReset().mockResolvedValue({ data: prefs() });
    PATCH.mockReset().mockImplementation(async () => ({ data: { ...prefs(), version: 3 } }));
  });

  it('ตารางเหตุการณ์ × ในระบบ/อีเมล/LINE ตามค่าของผู้ใช้ · LINE ติ๊กไม่ได้ · มีแถวสรุปรายวัน', async () => {
    wrap();
    expect(await screen.findByLabelText('อีเมล — ใบค้างใหม่')).not.toBeChecked();
    expect(screen.getByRole('heading', { name: 'การแจ้งเตือน' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'ทีมภายใน' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('ในระบบ — ใบค้างใหม่')).toBeChecked();
    expect(screen.getByLabelText('อีเมล — รถร่วมปฏิเสธหรือหมดเวลา')).toBeChecked();
    expect(screen.getByLabelText('LINE — ใบค้างใหม่')).toBeDisabled();
    expect(screen.getByLabelText('อีเมล — สรุปรายวัน 08:00 น.')).toBeChecked();
    expect(screen.getByLabelText('ในระบบ — สรุปรายวัน 08:00 น.')).toBeDisabled();
    expect(screen.getByText('รถร่วมโต้แย้งยอด (dispute)')).toHaveAttribute(
      'title',
      'ระบบจะเริ่มส่งเมื่อเปิดใช้งาน ST6-T06',
    );
    expect(screen.getAllByRole('row')).toHaveLength(1 + EVENTS.length + 1);
  });

  it('ปิดอีเมลของเหตุการณ์หนึ่ง + ปิดสรุปรายวัน แล้วกดบันทึก → PATCH เฉพาะที่เปลี่ยน พร้อม If-Match', async () => {
    wrap();
    fireEvent.click(await screen.findByLabelText('อีเมล — รถร่วมปฏิเสธหรือหมดเวลา'));
    fireEvent.click(screen.getByLabelText('อีเมล — สรุปรายวัน 08:00 น.'));
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    await waitFor(() => expect(PATCH).toHaveBeenCalledTimes(1));
    const [path, opts] = PATCH.mock.calls[0]! as [
      string,
      { params: { header: Record<string, string> }; body: unknown },
    ];
    expect(path).toBe('/v1/me/notification-preferences');
    expect(opts.params.header['If-Match']).toBe('"2"');
    expect(opts.body).toEqual({
      events: [{ event: 'subcon.no_response', email: false }],
      dailyDigest: false,
    });
    expect(await screen.findByText('บันทึกการตั้งค่าการแจ้งเตือนแล้ว')).toBeInTheDocument();
  });

  it('แท็บแจ้งลูกค้าปลายทาง = ยังไม่เปิดใช้ (P1)', async () => {
    wrap();
    fireEvent.click(await screen.findByRole('tab', { name: 'แจ้งลูกค้าปลายทาง' }));
    expect(screen.getByText('หน้านี้ยังไม่เปิดใช้')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'บันทึก' })).toBeNull();
  });
});
