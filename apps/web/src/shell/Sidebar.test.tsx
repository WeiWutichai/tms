import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { Sidebar } from './Sidebar';

/** D-81 · D68-89 badge งานค้างบน sidebar — ต้นแบบ TMS v4 `vNav()` (pill ขาวขอบเทา / เร่ง = พื้นชมพูตัวแดง, กลุ่มปิด = ผลรวม, ย่อ = จุด) */
const ok = (data: unknown) => Promise.resolve({ data, response: { ok: true, status: 200 } });
let BADGES: { key: string; count: number }[] = [];
const GET = vi.fn((p: string) =>
  p === '/v1/me/badges' ? ok({ data: BADGES, asOf: '2026-11-23T00:00:00Z' }) : ok({ data: [] }),
);
vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  api: { GET: (p: string) => GET(p) },
}));

function show(
  mini = false,
  scopes: string[] = ['*'],
  locks?: Record<string, unknown>,
  features: string[] = ['sub', 'settle', 'fleet', 'report', 'api'],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider lang="th">
        <MemoryRouter initialEntries={['/']}>
          <Sidebar
            mini={mini}
            onToggle={() => {}}
            tenantName="ศรีไทยขนส่ง"
            actor="พรทิพย์ ศรีวงศ์"
            scopes={scopes}
            features={features}
            locks={locks}
            onLogout={() => {}}
          />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
/** ปุ่มเมนูมี title = ชื่อเมนู (ต้นแบบ `title="{{ g.l }}"`) */
const item = (name: string) => screen.getByTitle(name);

describe('Sidebar badge งานค้าง (D68-89)', () => {
  beforeEach(() => {
    GET.mockClear();
    BADGES = [
      { key: 'plan', count: 4 },
      { key: 'exc', count: 2 },
      { key: 'so', count: 0 },
      { key: 'bill', count: 7 },
      { key: 'pay', count: 0 },
      { key: 'fdoc', count: 3 },
      { key: 'rate', count: 1 },
    ];
  });

  it('เมนูลูกแสดงตัวนับ (0 = ไม่แสดง) · งานเร่ง (ศูนย์ข้อยกเว้น) สีแดงตามต้นแบบ · กลุ่มที่ปิดแสดงผลรวม', async () => {
    show();
    await waitFor(() => expect(within(item('กระดานวางแผน')).getByText('4')).toBeInTheDocument());
    expect(GET).toHaveBeenCalledWith('/v1/me/badges');
    const plan = within(item('กระดานวางแผน')).getByTestId('nav-badge');
    expect(plan).toHaveStyle({ background: '#FFFFFF', color: '#3B424C', height: '20px' });
    const exc = within(item('ศูนย์ข้อยกเว้น')).getByTestId('nav-badge');
    expect(exc).toHaveTextContent('2');
    expect(exc).toHaveStyle({ background: '#FBE9E7', color: '#B3322A' });
    expect(within(item('ใบสั่งขนส่ง (SO)')).queryByTestId('nav-badge')).toBeNull();
    expect(within(item('วางบิลและใบแจ้งหนี้')).getByTestId('nav-badge')).toHaveTextContent('7');
    // กลุ่ม "รถ" ปิดอยู่ (ค่าเริ่ม) → ผลรวมของเมนูลูก (เอกสารรถ 3 = เร่ง → แดง)
    const fleet = within(item('รถ')).getByTestId('nav-badge');
    expect(fleet).toHaveTextContent('3');
    expect(fleet).toHaveStyle({ color: '#B3322A' });
    // กลุ่มข้อมูลหลักปิด → Rate card 1 (ไม่เร่ง)
    expect(within(item('ข้อมูลหลัก')).getByTestId('nav-badge')).toHaveStyle({
      color: '#3B424C',
    });
  });

  it('แถบย่อ: จุดบนไอคอนกลุ่มที่มีงานค้าง (เร่ง = แดง)', async () => {
    show(true);
    await waitFor(() => expect(screen.getAllByTestId('nav-dot').length).toBeGreaterThan(0));
    const dot = within(item('ปฏิบัติการ')).getByTestId('nav-dot');
    expect(dot).toHaveStyle({ background: '#B3322A' });
    expect(screen.queryAllByTestId('nav-badge')).toHaveLength(0);
  });
});

/** P1-ST1-T02 / PLT-076–077: 🔒 มาจาก `locks` ของ /me — ฟีเจอร์พื้นฐานไม่ขึ้น 🔒 แม้ปิดอยู่ (เช่น tenant ถูกระงับ) */
describe('Sidebar 🔒 ตาม locks (P1-ST1-T02)', () => {
  it('เมนูที่อยู่ใน locks ขึ้น 🔒 · เมนูพื้นฐานที่ปิดเพราะสถานะไม่ขึ้น', () => {
    show(false, ['*'], { report: {}, fleet: {} }, []);
    expect(within(item('รายงาน')).getByLabelText('ไม่รวมในแพ็กเกจ')).toBeInTheDocument();
    for (const name of ['จ่ายงานรถร่วม', 'Settlement รถร่วม'])
      expect(within(item(name)).queryByLabelText('ไม่รวมในแพ็กเกจ')).toBeNull();
  });
});
