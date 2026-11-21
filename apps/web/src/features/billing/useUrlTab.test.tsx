import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { useUrlTab } from './useUrlTab';

/** ST9-T02 drill-down `?tab=` จาก Dashboard บิล → หน้าตั้งแท็บแล้วลบ `tab` ออกจาก URL */
function Probe({ apply }: { apply: (t: string) => void }) {
  useUrlTab(['all', 'over', 'part'] as const, apply);
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
const mount = (url: string, apply: (t: string) => void) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Probe apply={apply} />
    </MemoryRouter>,
  );

describe('useUrlTab (ST9-T02)', () => {
  it('แท็บที่รู้จัก → apply แล้วลบ tab ออกจาก URL (คงพารามิเตอร์อื่น)', async () => {
    const apply = vi.fn();
    mount('/pay?tab=over&x=1', apply);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/pay?x=1'));
    expect(apply).toHaveBeenCalledWith('over');
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('แท็บที่ไม่รู้จัก → ไม่ apply แต่ลบทิ้ง · ไม่มี tab → ไม่ทำอะไร', async () => {
    const apply = vi.fn();
    mount('/pay?tab=bogus', apply);
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent(/^\/pay$/));
    expect(apply).not.toHaveBeenCalled();
    const none = vi.fn();
    mount('/bill', none);
    expect(none).not.toHaveBeenCalled();
  });
});
