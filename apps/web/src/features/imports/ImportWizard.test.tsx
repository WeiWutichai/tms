import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

/** wizard นำเข้า: ตัวเลือกวิธีนำเข้า (spec/02 §11.4 — PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ) */
const POST = vi.fn();
vi.mock('../../api', async (orig) => ({
  ...(await orig<typeof import('../../api')>()),
  api: { POST: (...a: unknown[]) => POST(...a), GET: vi.fn(), PATCH: vi.fn() },
  unwrap: (p: Promise<unknown>) => p,
}));
const { ImportWizard } = await import('./ImportWizard');

const kind = (modes: string[]) =>
  ({
    kind: 'route',
    label: 'เส้นทาง',
    columns: [],
    modes,
    defaultMode: 'create_only',
    maxRows: 5000,
  }) as never;

describe('ImportWizard โหมดนำเข้า', () => {
  beforeEach(() => {
    POST.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })),
    );
  });

  it('ค่าเริ่ม = defaultMode · เลือก "เพิ่มใหม่ หรือแก้ตามรหัส" แล้วอัปโหลด → POST /imports mode upsert_by_code', async () => {
    POST.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/v1/documents'
          ? { id: 'doc_1', uploadUrl: '/v1/documents/doc_1/content?s=1' }
          : {
              id: 'imp_1',
              status: 'validating',
              totalRows: 0,
              okRows: 0,
              issues: [],
              mapping: {},
              sample: [],
            },
      ),
    );
    render(
      <I18nProvider>
        <ImportWizard
          kind={kind(['create_only', 'upsert_by_code', 'update_only'])}
          onClose={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('radio', { name: /เพิ่มรายการใหม่เท่านั้น/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /เพิ่มใหม่ หรือแก้รายการเดิมตามรหัส/ }));
    const f = new File(['code,name\n'], 'routes.csv', { type: 'text/csv' });
    await act(async () => {
      fireEvent.change(screen.getByTestId('imp-file'), { target: { files: [f] } });
    });
    const call = POST.mock.calls.find((c) => c[0] === '/v1/imports')!;
    expect(call[1].body).toMatchObject({
      kind: 'route',
      documentId: 'doc_1',
      mode: 'upsert_by_code',
    });
  });

  it('ชนิดที่มีโหมดเดียว → ไม่แสดงตัวเลือก', () => {
    render(
      <I18nProvider>
        <ImportWizard kind={kind(['create_only'])} onClose={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.queryByRole('radiogroup', { name: 'วิธีนำเข้า' })).toBeNull();
  });
});
