import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** D-81 · D68-14: โควตารถนับรถ active ในเดือน (docs/02) — ฟอร์มเพิ่มรถแสดง "รถในทะเบียน N / โควตา M" ไม่เตือนเกินโควตา */
vi.mock('../../api', async (orig) => {
  const real = await orig<typeof import('../../api')>();
  const ok = (data: unknown) =>
    Promise.resolve({ data, response: new Response(null, { status: 200 }) });
  return {
    ...real,
    api: { GET: () => ok({ data: [], nextCursor: null, hasMore: false }) },
  };
});

const { VehicleFormDrawer } = await import('./VehicleFormDrawer');

const mount = (quota: { limit: number | null; used: number } | undefined) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <VehicleFormDrawer
          open
          finance={false}
          tenantName="x"
          quota={quota}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe('ฟอร์มเพิ่มรถ: โควตา (D68-14)', () => {
  it('รถในทะเบียนเกินโควตา → แสดงตัวเลขเฉย ๆ ไม่มีคำว่า "เกินโควตา"', () => {
    mount({ limit: 10, used: 12 });
    expect(screen.getByTestId('veh-quota')).toHaveTextContent('รถในทะเบียน 12 คัน / โควตา 10 คัน');
    expect(screen.queryByText(/เกินโควตา/)).toBeNull();
  });
  it('ไม่จำกัดโควตา → ไม่แสดง', () => {
    mount({ limit: null, used: 3 });
    expect(screen.queryByTestId('veh-quota')).toBeNull();
  });
});
