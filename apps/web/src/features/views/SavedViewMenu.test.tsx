import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const view = (o: Record<string, unknown>) => ({
  page: 'orders',
  hiddenColumns: null,
  isDefault: false,
  version: 1,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  ...o,
});
let rows: ReturnType<typeof view>[] = [];
const ok = (data: unknown, status = 200) =>
  Promise.resolve({ data, response: { ok: true, status } });
const GET = vi.fn(() => ok({ data: rows, nextCursor: null, hasMore: false }));
const POST = vi.fn((_p: string, o: { body: Record<string, unknown> }) =>
  ok(view({ id: 'svw_new', ...o.body }), 201),
);
const PATCH = vi.fn(
  (_p: string, o: { params: { path: { id: string } }; body: Record<string, unknown> }) =>
    ok(view({ ...rows.find((r) => r.id === o.params.path.id), ...o.body, version: 2 })),
);
const DELETE = vi.fn(() => Promise.resolve({ response: { ok: true, status: 204 } }));
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: {
    GET: () => GET(),
    POST: (p: string, o: { body: Record<string, unknown> }) => POST(p, o),
    PATCH: (p: string, o: { params: { path: { id: string } }; body: Record<string, unknown> }) =>
      PATCH(p, o),
    DELETE: () => DELETE(),
  },
}));

const { SavedViewMenu } = await import('./SavedViewMenu');
const { useSavedViews, sameView, pick } = await import('./useSavedViews');

const EMPTY = { tab: 'all', q: '', overdue: false };
const toast = vi.fn();
let applied: unknown[] = [];

/** หน้าทดสอบ: state + hidden เหมือนหน้ารายการจริง */
function Page() {
  const [state, setState] = useState(EMPTY);
  const [hidden, setHidden] = useState<string[] | null>(null);
  const b = useSavedViews({
    page: 'orders',
    state,
    hidden,
    empty: EMPTY,
    apply: (v) => {
      applied.push(v);
      setState(pick(v.state, EMPTY));
      setHidden(v.hidden);
    },
  });
  return (
    <>
      <SavedViewMenu b={b} onToast={toast} />
      <input
        aria-label="q"
        value={state.q}
        onChange={(e) => setState({ ...state, q: e.target.value })}
      />
      <button type="button" onClick={() => setHidden(['source'])}>
        hide
      </button>
      <output data-testid="cur">{JSON.stringify({ state, hidden })}</output>
    </>
  );
}

const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider lang="th">
        <Page />
      </I18nProvider>
    </QueryClientProvider>,
  );
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /^มุมมอง:/ }));

beforeEach(() => {
  sessionStorage.clear();
  rows = [];
  applied = [];
  for (const f of [GET, POST, PATCH, DELETE, toast]) f.mockClear();
});

describe('sameView / pick', () => {
  it('ลำดับ key ไม่มีผล · hidden null ≠ []', () => {
    expect(
      sameView(
        { state: { a: 1, b: 'x' }, hidden: ['c', 'd'] },
        { state: { b: 'x', a: 1 }, hidden: ['d', 'c'] },
      ),
    ).toBe(true);
    expect(sameView({ state: {}, hidden: null }, { state: {}, hidden: [] })).toBe(false);
  });
  it('pick: key ไม่รู้จัก/ชนิดผิด → ค่าเริ่มต้น', () => {
    expect(pick({ tab: 'route', q: 5, junk: 'x', overdue: true }, EMPTY)).toEqual({
      tab: 'route',
      q: '',
      overdue: true,
    });
  });
});

describe('SavedViewMenu (ST9-T11)', () => {
  it('ยังไม่มีตัวกรอง = "มุมมอง: ทั้งหมด" · บันทึกมุมมองใหม่ส่ง state + คอลัมน์ที่ซ่อน แล้วเลือกมุมมองนั้น', async () => {
    mount();
    expect(screen.getByRole('button', { name: 'มุมมอง: ทั้งหมด' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('q'), { target: { value: 'SO-1' } });
    fireEvent.click(screen.getByText('hide'));
    expect(screen.getByRole('button', { name: 'มุมมอง: กำหนดเอง' })).toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'บันทึกเป็นมุมมองใหม่…' }));
    fireEvent.change(screen.getByLabelText(/ชื่อมุมมอง/), { target: { value: ' ของฉันวันนี้ ' } });
    fireEvent.click(screen.getByLabelText('เปิดหน้านี้ด้วยมุมมองนี้ (ค่าเริ่มต้น)'));
    rows = [
      view({
        id: 'svw_new',
        name: 'ของฉันวันนี้',
        state: { tab: 'all', q: 'SO-1', overdue: false },
        hiddenColumns: ['source'],
        isDefault: true,
      }),
    ];
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกมุมมอง' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('บันทึกมุมมอง "ของฉันวันนี้" แล้ว'));
    expect(POST.mock.calls[0]![1].body).toEqual({
      page: 'orders',
      name: 'ของฉันวันนี้',
      state: { tab: 'all', q: 'SO-1', overdue: false },
      hiddenColumns: ['source'],
      isDefault: true,
    });
    expect(await screen.findByRole('button', { name: 'มุมมอง: ของฉันวันนี้' })).toBeInTheDocument();
  });

  it('เลือกมุมมอง → ตั้งตัวกรอง/คอลัมน์เดิม · แก้แล้ว "(แก้ไขแล้ว)" + บันทึกทับด้วย If-Match version · "ทั้งหมด" ล้าง', async () => {
    rows = [
      view({
        id: 'svw_a',
        name: 'งานค้าง',
        state: { tab: 'route', q: 'x' },
        hiddenColumns: ['cust'],
      }),
    ];
    mount();
    await waitFor(() => expect(GET).toHaveBeenCalled());
    openMenu();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'งานค้าง' }));
    expect(JSON.parse(screen.getByTestId('cur').textContent!)).toEqual({
      state: { tab: 'route', q: 'x', overdue: false },
      hidden: ['cust'],
    });
    // state ของมุมมองไม่มี overdue → เติมค่าเริ่มต้น (ยังไม่ถือว่าแก้ไข) · พิมพ์ตัวกรองใหม่ = แก้ไขแล้ว
    expect(screen.getByRole('button', { name: 'มุมมอง: งานค้าง' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('q'), { target: { value: 'y' } });
    expect(screen.getByRole('button', { name: 'มุมมอง: งานค้าง (แก้ไขแล้ว)' })).toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'บันทึกทับมุมมองนี้' }));
    await waitFor(() => expect(PATCH).toHaveBeenCalled());
    expect(PATCH.mock.calls[0]![1]).toMatchObject({
      params: { path: { id: 'svw_a' } },
      body: { state: { tab: 'route', q: 'y', overdue: false }, hiddenColumns: ['cust'] },
    });
    openMenu();
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'ทั้งหมด' }));
    expect(JSON.parse(screen.getByTestId('cur').textContent!)).toEqual({
      state: EMPTY,
      hidden: null,
    });
    expect(screen.getByRole('button', { name: 'มุมมอง: ทั้งหมด' })).toBeInTheDocument();
  });

  it('เปิดหน้าครั้งแรกของแท็บ + มีค่าเริ่มต้น → ใช้มุมมองค่าเริ่มต้น (ครั้งเดียว)', async () => {
    rows = [
      view({ id: 'svw_a', name: 'ก', state: { q: 'a' } }),
      view({ id: 'svw_b', name: 'ข', state: { q: 'b' }, isDefault: true }),
    ];
    const r = mount();
    expect(await screen.findByRole('button', { name: 'มุมมอง: ข' })).toBeInTheDocument();
    expect(applied).toHaveLength(1);
    r.unmount();
    mount();
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(applied).toHaveLength(1);
  });

  it('ลบมุมมอง → ยืนยันใน dialog แล้วกลับเป็นไม่ได้เลือก (ตัวกรองคงเดิม)', async () => {
    rows = [view({ id: 'svw_a', name: 'ลบฉัน', state: { q: 'z' } })];
    mount();
    openMenu();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'ลบฉัน' }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'ลบมุมมองนี้' }));
    expect(screen.getByRole('alertdialog', { name: 'ลบมุมมอง "ลบฉัน"' })).toBeInTheDocument();
    rows = [];
    fireEvent.click(screen.getByRole('button', { name: 'ลบมุมมอง' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('ลบมุมมอง "ลบฉัน" แล้ว'));
    expect(DELETE).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'มุมมอง: กำหนดเอง' })).toBeInTheDocument();
  });
});
