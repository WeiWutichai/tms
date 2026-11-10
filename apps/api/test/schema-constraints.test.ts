import { describe, expect, it } from 'vitest';
import { platform } from './helpers';

/**
 * constraint ที่ Prisma schema แสดงไม่ได้ (อยู่ใน migration เท่านั้น) — ถ้า migration ใหม่ที่สร้างจาก `prisma migrate diff`
 * ลบ/สร้างทับ test นี้จะแดง (review 10 พ.ย. 2569 ข้อ 10)
 */
describe('constraint นอก Prisma schema', () => {
  it('ตัวนับเลขเอกสาร unique แบบ NULLS NOT DISTINCT; สาขา default 1 ต่อนิติบุคคล; trigger audit', async () => {
    const db = platform();
    const idx = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('document_sequence_tenant_id_doc_type_branch_id_period_key_key', 'branch_one_default_issuer_per_company')`;
    const def = Object.fromEntries(idx.map((i) => [i.indexname, i.indexdef]));
    expect(def['document_sequence_tenant_id_doc_type_branch_id_period_key_key']).toMatch(
      /NULLS NOT DISTINCT/,
    );
    expect(def['branch_one_default_issuer_per_company']).toMatch(/UNIQUE.*WHERE is_default_issuer/);
    const trg = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'audit_log_append_only'`;
    expect(Number(trg[0]!.n)).toBe(1);
    await db.$disconnect();
  });
});
