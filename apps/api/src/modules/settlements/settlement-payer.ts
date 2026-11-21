import type { Tx } from '../../db/db.service';

/** ผู้จ่ายบนใบสำคัญจ่าย (ตรึงใน `carrier_settlement.payer_snapshot` ตอนอนุมัติ — ST6-T04 review L1) */
export interface PayerSnapshot {
  companyId: string | null;
  name: string;
  taxId: string | null;
  /** "00000" = สำนักงานใหญ่ · null = ไม่มีสาขา */
  branchCode: string | null;
  address: string;
}

function addressText(a: unknown): string {
  if (!a || typeof a !== 'object') return '';
  const o = a as Record<string, unknown>;
  return ['line1', 'line2', 'subdistrict', 'district', 'province', 'postcode']
    .map((k) => o[k])
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .join(' ');
}

/**
 * ผู้จ่าย = "จ้างในนาม" ของใบ (ไม่ตั้ง = บริษัทแรกของ tenant) · สาขา = สาขาผู้ออกตั้งต้น → สำนักงานใหญ่
 * (กติกาเดียวกับผู้ออกใบแจ้งหนี้) · ไม่มีนิติบุคคลเลย = ชื่อ tenant (ไม่มีเลขผู้เสียภาษี)
 */
export async function resolvePayer(tx: Tx, companyId: string | null): Promise<PayerSnapshot> {
  const co = await tx.company.findFirst({
    where: companyId ? { id: companyId } : { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
  if (!co) {
    const tenant = await tx.tenant.findFirst({ select: { name: true } });
    return {
      companyId: null,
      name: tenant?.name ?? '',
      taxId: null,
      branchCode: null,
      address: '',
    };
  }
  const branches = await tx.branch.findMany({
    where: { companyId: co.id },
    orderBy: { branchCode: 'asc' },
  });
  const b =
    branches.find((x) => x.isDefaultIssuer) ?? branches.find((x) => x.branchCode === '00000');
  return {
    companyId: co.id,
    name: co.legalName,
    taxId: co.taxId,
    branchCode: b?.branchCode ?? null,
    address: b ? addressText(b.address) : '',
  };
}
