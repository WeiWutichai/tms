import { ROLE_CODES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapSteps,
  bootstrapTenant,
  createTenantWithDefaults,
} from '../src/modules/tenants/bootstrap';
import { readSettings } from '../src/modules/settings/settings.service';
import { platform, truncateAll } from './helpers';

/** ST1-T20: สร้าง tenant ใหม่แล้วมีชุดเลขและค่าภาษี default ครบโดยไม่ต้องตั้ง (+ ประเภทรถ ST2-T04) */
describe('tenant bootstrap', () => {
  const db = platform();
  beforeAll(() => truncateAll());
  afterAll(() => db.$disconnect());

  it('tenant ใหม่: role ระบบครบ, ชุดเลข 11 ประเภท, ค่าภาษี/วางบิลเป็นแถวจริง', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท ใหม่' });
    const roles = await db.role.findMany({ where: { tenantId: t.id } });
    expect(roles.map((r) => r.code).sort()).toEqual([...ROLE_CODES].sort());
    const series = await db.documentSeries.findMany({ where: { tenantId: t.id } });
    expect(series.map((s) => s.docType).sort()).toEqual(
      ['BN', 'CN', 'DN', 'DO', 'INV', 'RCP', 'SO', 'STL', 'TRIP', 'TXINV', 'WHT'].sort(),
    );
    const rows = await db.tenantSetting.findMany({ where: { tenantId: t.id } });
    expect(rows.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        'tax.vatDefault',
        'tax.invoiceModePolicy',
        'tax.wht1Enabled',
        'tax.wht3Enabled',
        'billing.cycleDefault',
      ]),
    );
    const v = await readSettings(db, t.id, ['tax.vatDefault', 'tax.invoiceModePolicy']);
    expect(v).toEqual({ 'tax.vatDefault': 'VAT_7', 'tax.invoiceModePolicy': 'PER_CUSTOMER' });
    // ST2-T04: ประเภทรถภาษาไทยพร้อมใช้
    const types = await db.vehicleType.findMany({ where: { tenantId: t.id } });
    expect(types.map((x) => x.code).sort()).toEqual(['10W', '4W', '6W', 'REF6', 'TRC', 'TRL']);
  });

  it('รันซ้ำไม่ทับค่าที่ tenant แก้แล้ว', async () => {
    const t = await createTenantWithDefaults(db, { name: 'บริษัท แก้แล้ว' });
    await db.tenantSetting.update({
      where: { tenantId_key: { tenantId: t.id, key: 'tax.wht3Enabled' } },
      data: { value: false },
    });
    await db.documentSeries.update({
      where: { tenantId_docType: { tenantId: t.id, docType: 'SO' } },
      data: { prefix: 'MY-SO-' },
    });
    await bootstrapTenant(db, t.id);
    expect((await readSettings(db, t.id, ['tax.wht3Enabled']))['tax.wht3Enabled']).toBe(false);
    expect(
      (
        await db.documentSeries.findUniqueOrThrow({
          where: { tenantId_docType: { tenantId: t.id, docType: 'SO' } },
        })
      ).prefix,
    ).toBe('MY-SO-');
  });

  it('ขั้นไหนล้ม = ไม่มี tenant ครึ่ง ๆ (rollback ทั้งก้อน)', async () => {
    const steps = [
      ...bootstrapSteps(),
      { name: 'test-fail', run: async () => Promise.reject(new Error('boom')) },
    ];
    await expect(createTenantWithDefaults(db, { name: 'บริษัท ล้ม' }, steps)).rejects.toThrow(
      'boom',
    );
    expect(await db.tenant.count({ where: { name: 'บริษัท ล้ม' } })).toBe(0);
  });

  it('รายการขั้นครบและเรียงตามที่ตั้งใจ (เพิ่มขั้นใหม่ = แก้ test นี้ด้วย)', () => {
    expect(bootstrapSteps().map((s) => s.name)).toEqual([
      'system-roles',
      'document-series',
      'tax-billing-defaults',
      'vehicle-types',
    ]);
  });
});
