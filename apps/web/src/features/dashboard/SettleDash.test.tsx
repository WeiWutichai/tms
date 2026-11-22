import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/**
 * ST9-T03 Dashboard AP รถร่วม: 5 ช่อง (รอตรวจ / มีรายการโต้แย้ง / รออนุมัติ / รอจ่าย / จ่ายแล้ว) จาก `GET /settlements/summary`
 * · คลิก = หน้า settle ที่แท็บ/ตัวกรองเดียวกัน และหน้านั้นเรียก `GET /settlements` ด้วยสถานะชุดเดียวกัน + แสดงยอดรวม = ตัวเลขบนช่อง
 * · ไม่มีสิทธิ์/แพ็กเกจไม่เปิด = ไม่ render ไม่เรียก API · ยอดจ่ายเดือนนี้ต้องมี `prices.buy:read` · ไม่มี "50 ทวิ" (D-54)
 */
let scopes: string[] = [];
let features: string[] | undefined;
let failSummary = false;
let summary: Record<string, unknown> = {};
const calls: { path: string; query?: Record<string, unknown> }[] = [];
const ok = (data: unknown) =>
  Promise.resolve({ data, response: new Response(null, { status: 200 }) });
/** แถวของรายการ (สถานะตามที่ขอ) — จำนวนแถว = ตัวนับ summary ของสถานะนั้น (คำนวณแยก ไม่ใช้ helper ของหน้า) */
const STATUS_N: Record<string, number> = {
  DRAFT: 3,
  SENT_TO_CARRIER: 2,
  DISPUTED: 1,
  APPROVED: 4,
  PAID: 6,
  CANCELLED: 1,
};
const rowsFor = (status: string | undefined) =>
  (status ? status.split(',') : Object.keys(STATUS_N)).flatMap((s) =>
    Array.from({ length: STATUS_N[s] ?? 0 }, (_, i) => ({
      id: `stl_${s}_${i}`,
      settlementNo: null,
      status: s,
      carrier: { id: 'car_1', legalName: 'หจก. ทดสอบ' },
      periodFrom: null,
      periodTo: null,
      tripCount: 1,
    })),
  );

vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  return {
    ...real,
    api: {
      GET: (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
        calls.push({ path, query: opts?.params?.query });
        if (path === '/v1/me')
          return ok({
            scopes,
            ...(features ? { features } : {}),
            user: { roles: ['x'] },
            tenant: { yearStyle: 'BE', name: 'x' },
          });
        if (path === '/v1/settlements/summary')
          return failSummary
            ? Promise.resolve({
                error: { code: 'internal_error', status: 500, title: '', type: '' },
                response: new Response(null, { status: 500 }),
              })
            : ok(summary);
        if (path === '/v1/settlements') {
          const st = opts?.params?.query?.status as string | undefined;
          return ok({ data: rowsFor(st), nextCursor: null, hasMore: false });
        }
        return ok({ data: [], nextCursor: null, hasMore: false });
      },
    },
  };
});

const { SettleDash } = await import('./SettleDash');
const { SettlePage } = await import('../settlements/SettlePage');
const { AP_TILES } = await import('./apCards');

function Loc() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
function mount(url = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/" element={<SettleDash />} />
            <Route path="/settle" element={<SettlePage />} />
          </Routes>
          <Loc />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const SUMMARY = {
  total: Object.values(STATUS_N).reduce((a, b) => a + b, 0),
  draft: STATUS_N.DRAFT,
  sentToCarrier: STATUS_N.SENT_TO_CARRIER,
  disputed: STATUS_N.DISPUTED,
  approved: STATUS_N.APPROVED,
  paid: STATUS_N.PAID,
  cancelled: STATUS_N.CANCELLED,
  buyPaidThisMonth: '12345.60',
};

describe('Dashboard AP รถร่วม (ST9-T03)', () => {
  beforeEach(() => {
    calls.length = 0;
    failSummary = false;
    features = undefined;
    summary = { ...SUMMARY };
    scopes = ['settlements:read', 'prices.buy:read'];
    sessionStorage.clear();
  });

  it('5 ช่องตามลำดับ docs/04 H + ตัวเลขต่อสถานะ (รอตรวจ = ร่าง + โต้แย้ง ตามแท็บหน้า settle) + ยอดจ่ายเดือนนี้ · ไม่มี 50 ทวิ', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('ap-chk-n')).toHaveTextContent('4'));
    expect(screen.getByTestId('ap-disputed-n')).toHaveTextContent('1');
    expect(screen.getByTestId('ap-appr-n')).toHaveTextContent('2');
    expect(screen.getByTestId('ap-unpaid-n')).toHaveTextContent('4');
    expect(screen.getByTestId('ap-paid-n')).toHaveTextContent('6');
    const labels = AP_TILES.map((x) => screen.getByTestId(`ap-${x.key}`).textContent);
    expect(labels).toEqual(['4รอตรวจ', '1มีรายการโต้แย้ง', '2รออนุมัติ', '4รอจ่าย', '6จ่ายแล้ว']);
    expect(screen.getByTestId('ap-paid-month')).toHaveTextContent('12,345.60');
    expect(screen.getByTestId('dash-ap')).not.toHaveTextContent('50 ทวิ');
    expect(screen.getByText('Settlement รถร่วม')).toBeInTheDocument();
  });

  it.each(AP_TILES.map((x) => [x.key, x] as const))(
    'คลิกช่อง %s → หน้า settle ที่แท็บเดียวกัน · GET /settlements ด้วยสถานะชุดเดียวกัน · ยอดรวม = ตัวเลขบนช่อง',
    async (_k, x) => {
      mount();
      await waitFor(() => expect(screen.getByTestId(`ap-${x.key}-n`)).not.toHaveTextContent('—'));
      const shown = Number(screen.getByTestId(`ap-${x.key}-n`).textContent);
      fireEvent.click(screen.getByTestId(`ap-${x.key}`));
      // ลิงก์ใช้ครั้งเดียว — หน้า settle ลบ ?tab=&st= ออกจาก URL หลังตั้งแท็บ/ตัวกรอง
      await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/settle$/));
      await waitFor(() =>
        expect(
          calls.some((c) => c.path === '/v1/settlements' && c.query?.status === x.statuses),
        ).toBe(true),
      );
      // ตัวนับอิสระ: จำนวนแถวที่รายการตอบสำหรับสถานะชุดนั้น
      expect(rowsFor(x.statuses)).toHaveLength(shown);
      await waitFor(() => expect(screen.getByText(`${shown} รายการ`)).toBeInTheDocument());
      // ทุกคำขอรายการหลังเปิดหน้า ใช้สถานะของช่อง (ไม่ยิงชุดอื่นก่อน)
      const listCalls = calls.filter((c) => c.path === '/v1/settlements');
      expect(listCalls.every((c) => c.query?.status === x.statuses)).toBe(true);
    },
  );

  it('ไม่มี settlements:read → ไม่ render และไม่เรียก summary', async () => {
    scopes = ['orders:read', 'prices.buy:read'];
    mount();
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/me')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('dash-ap')).toBeNull();
    expect(calls.some((c) => c.path === '/v1/settlements/summary')).toBe(false);
  });

  it('แพ็กเกจไม่เปิดโมดูล settle → ไม่ render และไม่เรียก summary', async () => {
    features = ['sub'];
    mount();
    await waitFor(() => expect(calls.some((c) => c.path === '/v1/me')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('dash-ap')).toBeNull();
    expect(calls.some((c) => c.path === '/v1/settlements/summary')).toBe(false);
  });

  it('ไม่มี prices.buy:read → เห็นจำนวนแต่ไม่เห็นยอดจ่ายเดือนนี้ (API ไม่ส่งฟิลด์ + หน้าไม่แสดงแม้ได้มา)', async () => {
    scopes = ['settlements:read'];
    mount();
    await waitFor(() => expect(screen.getByTestId('ap-paid-n')).toHaveTextContent('6'));
    expect(screen.queryByTestId('ap-paid-month')).toBeNull();
    expect(screen.getByTestId('dash-ap')).not.toHaveTextContent('12,345.60');
  });

  it('summary โหลดไม่สำเร็จ → ปุ่มเดียว "โหลดไม่สำเร็จ · ลองใหม่" แทนช่อง (แบบการ์ดรถบริษัท) · คลิก = โหลดใหม่ ไม่เปลี่ยนหน้า', async () => {
    failSummary = true;
    mount();
    await waitFor(() => expect(screen.getByTestId('ap-retry')).toHaveTextContent('โหลดไม่สำเร็จ'));
    expect(screen.queryByTestId('ap-chk')).toBeNull();
    expect(screen.getAllByText('โหลดไม่สำเร็จ · ลองใหม่')).toHaveLength(1);
    const before = calls.filter((c) => c.path === '/v1/settlements/summary').length;
    failSummary = false;
    fireEvent.click(screen.getByTestId('ap-retry'));
    await waitFor(() => expect(screen.getByTestId('ap-chk-n')).toHaveTextContent('4'));
    expect(calls.filter((c) => c.path === '/v1/settlements/summary').length).toBeGreaterThan(
      before,
    );
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/$/);
  });

  it('หน้า settle: แท็บรอตรวจ + ตัวกรองสถานะที่ไม่อยู่ในแท็บ (จ่ายแล้ว) → ไม่ยิงรายการ ยอดรวม 0', async () => {
    mount('/settle?tab=chk&st=PAID');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/settle$/));
    await waitFor(() => expect(screen.getAllByText('0 รายการ').length).toBeGreaterThan(0));
    expect(calls.some((c) => c.path === '/v1/settlements')).toBe(false);
  });

  it('หน้า settle: มาจากช่องโต้แย้ง แล้วเปลี่ยนไปแท็บจ่ายแล้ว → ล้างตัวกรองสถานะ (รายการ = PAID ไม่ใช่ว่าง)', async () => {
    mount('/settle?tab=chk&st=DISPUTED');
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === '/v1/settlements' && c.query?.status === 'DISPUTED'),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('tab', { name: /จ่ายแล้ว/ }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/v1/settlements' && c.query?.status === 'PAID')).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.getAllByText('6 รายการ').length).toBeGreaterThan(0));
  });
});
