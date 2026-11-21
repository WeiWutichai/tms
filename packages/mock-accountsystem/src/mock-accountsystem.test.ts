import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type MockAccountSystem,
  signAccountSystemWebhook,
  startMockAccountSystem,
} from './mock-accountsystem';

describe('mock AccountSystem ext/v1 (ST8-T16 contract)', () => {
  let m: MockAccountSystem;
  const call = (method: string, path: string, body?: unknown, key = m.apiKey) =>
    fetch(`${m.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const draft = (ref = 'INV-1') => ({
    doc_type: 'IV',
    issue_date: '2026-11-21',
    contact_code: 'C-0001',
    lines: [
      {
        description: 'ค่าขนส่ง',
        qty: '1',
        unit_price: '100',
        amount: '100.00',
        vat_rate: '7',
        extra: 'x',
      },
    ],
    external_source: 'tms.invoice',
    external_ref: ref,
  });
  beforeAll(async () => {
    m = await startMockAccountSystem({
      contacts: [{ code: 'C-0001', tax_id: '0105555000001', branch_code: '00000' }],
    });
  });
  afterAll(() => m.stop());

  it('สร้างร่าง + กันซ้ำด้วย external_source/external_ref · vat_rate ถูกทิ้ง · ฟิลด์เกินในบรรทัดถูกตัด', async () => {
    const a = await call('POST', '/ext/v1/documents', draft());
    expect(a.status).toBe(201);
    const ra = (await a.json()) as { id: string; created: boolean };
    expect(ra.created).toBe(true);
    const b = (await (await call('POST', '/ext/v1/documents', draft())).json()) as {
      id: string;
      created: boolean;
    };
    expect(b).toEqual({ id: ra.id, created: false });
    expect(m.documents.get(ra.id)!.lines[0]!.vat_rate).toBeNull();
    expect(m.byRef('INV-1')).toHaveLength(1);
  });

  it('401 / 403 / 400 / 422 แบบตัวจริง', async () => {
    expect((await call('POST', '/ext/v1/documents', draft('X'), 'inn_wrong')).status).toBe(401);
    expect((await call('POST', '/ext/v1/documents', { ...draft('Y'), foo: 1 })).status).toBe(400);
    const r = await call('POST', '/ext/v1/documents', { ...draft('Z'), contact_code: 'NOPE' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toContain('ไม่พบคู่ค้า');
    m.setScopes(['documents:read']);
    expect((await call('POST', '/ext/v1/documents', draft('W'))).status).toBe(403);
    m.setScopes(['documents:read', 'documents:draft', 'contacts:draft']);
  });

  it('PUT contacts จับคู่เลขภาษี+สาขา / สร้าง EXT-####', async () => {
    const r = (await (
      await call('PUT', '/ext/v1/contacts', [
        { tax_id: '0105555000001', branch_code: '00000', name: 'ก', kind: 'customer' },
        { external_source: 'tms.carrier', external_ref: 'SUB-1', name: 'ข', kind: 'vendor' },
      ])
    ).json()) as { code: string; created: boolean }[];
    expect(r[0]).toMatchObject({ code: 'C-0001', created: false });
    expect(r[1]).toMatchObject({ code: 'EXT-0001', created: true });
  });

  it('webhook เซ็น HMAC-SHA256(secret, ts.body)', () => {
    const id = m.byRef('INV-1')[0]!.id;
    const w = m.post(id);
    expect(w.event.data).toMatchObject({ doc_type: 'IV', external_ref: 'INV-1' });
    const ts = w.headers['x-innovera-timestamp']!;
    expect(w.headers['x-innovera-signature']).toBe(
      `sha256=${signAccountSystemWebhook(m.webhookSecret, ts, w.body)}`,
    );
    const p = m.receive([{ documentId: id, applied: '99.00', wht: '1.00' }]);
    expect(p.event.data).toMatchObject({ cash_in: '99.00', wht: '1.00' });
  });
});
