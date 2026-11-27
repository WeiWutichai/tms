import type { NestExpressApplication } from '@nestjs/platform-express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbService } from '../src/db/db.service';
import { matchKey } from '@tms/domain';
import { OrderMatchingService } from '../src/modules/orders/order-matching.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bootApp, platform, truncateAll, validTaxId } from './helpers';

/**
 * P1-ST5-T12 (plan/05a D68-29) customer_alias รวมเข้า external_mapping (migration 0180)
 * เกณฑ์ตรวจรับ (plan/13 P1-ST5-T12): ลูกค้าคนเดียวที่มี alias + mapping เดิม → หลัง migrate ค้นได้ทั้งสองทาง ไม่มี mapping หาย
 * + รูปแถว alias ถูกบังคับด้วย CHECK · แยก tenant (RLS ของ external_mapping)
 */
const MIGRATION = join(
  __dirname,
  '../prisma/migrations/0180_customer_alias_into_external_mapping/migration.sql',
);

describe('customer_alias → external_mapping (P1-ST5-T12 · D68-29)', () => {
  let app: NestExpressApplication;
  const plat = platform();
  let db: DbService;
  let matching: OrderMatchingService;
  let tenantId: string;
  let otherId: string;
  let cust: string;
  let connectorId: string;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    db = app.get(DbService);
    matching = app.get(OrderMatchingService);
    tenantId = (await createTenantWithDefaults(plat, { name: 'บริษัท รวม alias' })).id;
    otherId = (await createTenantWithDefaults(plat, { name: 'บริษัท อื่น' })).id;
    cust = (
      await plat.customer.create({
        data: {
          tenantId,
          code: 'C-T12',
          legalName: 'บริษัท ลูกค้าเดียว จำกัด',
          taxId: validTaxId(1201),
        },
      })
    ).id;
    connectorId = (
      await plat.connector.create({
        data: { tenantId, adapterKey: 'krs', status: 'ACTIVE', taxDocumentOwner: 'TMS' },
      })
    ).id;
  });
  afterAll(async () => {
    await app.close();
    await plat.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: ข้อมูล customer_alias เดิม + mapping เดิมของลูกค้าเดียวกัน → หลัง migrate ค้นได้ทั้งสองทาง ไม่มี mapping หาย', async () => {
    // mapping เดิมของ connector (ST8-T05): รหัสต้นทาง NSF-0 + รหัสในระบบบัญชี PP-1
    await plat.externalMapping.create({
      data: {
        tenantId,
        connectorId,
        entityType: 'CUSTOMER',
        localId: cust,
        sourceCode: 'NSF-0',
        externalId: 'PP-1',
        status: 'SYNCED',
      },
    });
    const name = 'บจก. ลูกค้าเดียว (สาขาบางนา)';
    // จำลองตาราง customer_alias ก่อน migrate (ตาราง temp ชื่อเดิม — คอลัมน์ตาม migration 0067) แล้วรันส่วนย้ายข้อมูลของ 0180 จริง
    const sql = readFileSync(MIGRATION, 'utf8');
    const move = sql.slice(sql.indexOf('INSERT INTO "external_mapping"'));
    expect(move).toContain('DROP TABLE "customer_alias"');
    await plat.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE customer_alias (
          id uuid NOT NULL, tenant_id uuid NOT NULL, customer_id uuid NOT NULL, kind text NOT NULL,
          source text NOT NULL DEFAULT '', value text NOT NULL, value_key text NOT NULL, created_by text,
          created_at timestamptz(6) NOT NULL DEFAULT now(), updated_at timestamptz(6) NOT NULL DEFAULT now())`);
      await tx.$executeRaw`
        INSERT INTO customer_alias (id, tenant_id, customer_id, kind, source, value, value_key, created_by) VALUES
          (gen_random_uuid(), ${tenantId}::uuid, ${cust}::uuid, 'EXTERNAL_ID', 'ERP:krs', 'NSF-9', 'NSF-9', 'u-1'),
          (gen_random_uuid(), ${tenantId}::uuid, ${cust}::uuid, 'EXTERNAL_ID', 'API', 'X-77', 'X-77', 'u-1'),
          (gen_random_uuid(), ${tenantId}::uuid, ${cust}::uuid, 'NAME', '', ${name}, ${matchKey(name)}, 'u-2')`;
      for (const stmt of move.split(/;\s*\n/).filter((s) => s.replace(/--.*$/gm, '').trim()))
        await tx.$executeRawUnsafe(stmt);
    });

    const rows = await plat.externalMapping.findMany({
      where: { tenantId, localId: cust },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(4);
    // mapping เดิมไม่เปลี่ยน
    expect(rows.find((r) => r.connectorId === connectorId)).toMatchObject({
      sourceCode: 'NSF-0',
      externalId: 'PP-1',
      matchKind: null,
      channel: null,
    });
    // alias = แถวไม่มี connector
    expect(
      rows
        .filter((r) => r.matchKind)
        .map((r) => [r.matchKind, r.channel, r.sourceCode, r.matchValue, r.connectorId, r.status])
        .sort(),
    ).toEqual(
      [
        ['EXTERNAL_ID', 'API', 'X-77', 'X-77', null, 'SYNCED'],
        ['EXTERNAL_ID', 'ERP:krs', 'NSF-9', 'NSF-9', null, 'SYNCED'],
        ['NAME', '', matchKey(name), name, null, 'SYNCED'],
      ].sort(),
    );

    // ค้นได้ทั้งสองทาง (ผ่าน OrderMatchingService ตัวจริง ใน tenant ของตัวเอง)
    const match = (q: { externalId: string | null; text: string | null; source: string }) =>
      db.withTenant(tenantId, (tx) => matching.matchCustomer(tx, q));
    expect(await match({ externalId: 'NSF-0', text: null, source: 'ERP:krs' })).toMatchObject({
      customerId: cust,
      method: 'ALIAS',
    });
    expect(await match({ externalId: 'NSF-9', text: null, source: 'ERP:krs' })).toMatchObject({
      customerId: cust,
      method: 'ALIAS',
    });
    expect(await match({ externalId: 'X-77', text: null, source: 'API' })).toMatchObject({
      customerId: cust,
      method: 'ALIAS',
    });
    expect(await match({ externalId: null, text: name, source: 'EXCEL' })).toMatchObject({
      customerId: cust,
      method: 'ALIAS',
    });
    // alias ผูกช่องทาง: รหัสเดียวกันจากช่องทางอื่นไม่จับคู่
    expect(
      (await match({ externalId: 'X-77', text: null, source: 'EXCEL' })).customerId,
    ).toBeNull();

    // แยก tenant: role แอปของ tenant อื่นไม่เห็นแถวใด และจับคู่ไม่ได้
    expect(await db.withTenant(otherId, (tx) => tx.externalMapping.count())).toBe(0);
    expect(
      (
        await db.withTenant(otherId, (tx) =>
          matching.matchCustomer(tx, { externalId: 'X-77', text: null, source: 'API' }),
        )
      ).customerId,
    ).toBeNull();
  });

  it('CHECK: แถว alias ต้องไม่มี connector/รหัส ERP และเป็นของลูกค้า · แถว mapping ต้องมี connector · คีย์ alias ซ้ำในช่องทางเดียวกันไม่ได้', async () => {
    const base = { tenantId, localId: cust, status: 'SYNCED' as const };
    const bad = [
      // alias ที่มี connector
      {
        ...base,
        connectorId,
        entityType: 'CUSTOMER' as const,
        matchKind: 'NAME',
        channel: '',
        sourceCode: 'k1',
        matchValue: 'v',
      },
      // mapping ที่ไม่มี connector และไม่ใช่ alias
      { ...base, entityType: 'CUSTOMER' as const, sourceCode: 'k2' },
      // alias ของเอกสาร
      {
        ...base,
        entityType: 'INVOICE' as const,
        matchKind: 'EXTERNAL_ID',
        channel: 'API',
        sourceCode: 'k3',
        matchValue: 'v',
      },
      // NAME ต้องช่องทางว่าง · EXTERNAL_ID ต้องมีช่องทาง
      {
        ...base,
        entityType: 'CUSTOMER' as const,
        matchKind: 'NAME',
        channel: 'API',
        sourceCode: 'k4',
        matchValue: 'v',
      },
      {
        ...base,
        entityType: 'CUSTOMER' as const,
        matchKind: 'EXTERNAL_ID',
        channel: '',
        sourceCode: 'k5',
        matchValue: 'v',
      },
      // alias ที่มีรหัสฝั่ง ERP
      {
        ...base,
        entityType: 'CUSTOMER' as const,
        matchKind: 'EXTERNAL_ID',
        channel: 'API',
        sourceCode: 'k6',
        matchValue: 'v',
        externalId: 'E',
      },
      // ชนิดที่ไม่รู้จัก
      {
        ...base,
        entityType: 'CUSTOMER' as const,
        matchKind: 'FUZZY',
        channel: 'API',
        sourceCode: 'k7',
        matchValue: 'v',
      },
      // คอลัมน์ alias บนแถว mapping
      { ...base, connectorId, entityType: 'CARRIER' as const, sourceCode: 'k8', channel: 'API' },
    ];
    for (const data of bad)
      await expect(plat.externalMapping.create({ data }), JSON.stringify(data)).rejects.toThrow();
    const ok = {
      ...base,
      entityType: 'CUSTOMER' as const,
      matchKind: 'EXTERNAL_ID',
      channel: 'PORTAL',
      sourceCode: 'DUP-1',
      matchValue: 'DUP-1',
    };
    await plat.externalMapping.create({ data: ok });
    await expect(plat.externalMapping.create({ data: ok })).rejects.toThrow();
    // คีย์เดียวกันคนละช่องทาง = ได้
    await plat.externalMapping.create({ data: { ...ok, channel: 'EXCEL' } });
  });
});
