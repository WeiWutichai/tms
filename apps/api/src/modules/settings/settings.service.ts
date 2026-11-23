import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { stableStringify } from '../master/master-kit';
import {
  normalizeSetting,
  presentSetting,
  settingFieldErrors,
  SETTING_KEYS,
  SETTINGS,
  validateSetting,
  type SettingKey,
} from './registry';

/**
 * ค่าตั้งที่เปลี่ยนได้เฉพาะ owner (docs/04 A3 "ปิดได้สำหรับ tenant เล็กโดย owner ยอมรับความเสี่ยง") — กฎแบ่งหน้าที่ที่ปิดได้
 * D-60 `settlement.allowApproverMarkPaid` (ST5-T09 `billing.allowSelfFinalize` ใช้กติกาเดียวกัน — รวมเข้ารายการนี้เมื่อ merge)
 */
export const OWNER_ONLY_SETTINGS: readonly SettingKey[] = [
  'settlement.allowApproverMarkPaid',
  'billing.allowSelfFinalize', // ST5-T09 review L3
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ผู้เรียกมีบทบาท owner ใน tenant นี้ไหม (RLS กรอง tenant) — actor ที่ไม่ใช่ผู้ใช้ (API key/ระบบ) = ไม่ใช่ owner */
async function isOwner(tx: Tx, actorId: string | null | undefined): Promise<boolean> {
  // ไม่ query ด้วย id ที่ไม่ใช่ uuid (query ผิด type ใน transaction = transaction ใช้ต่อไม่ได้)
  if (!actorId || !UUID_RE.test(actorId)) return false;
  const owner = await tx.role.findFirst({ where: { code: 'owner' }, select: { id: true } });
  if (!owner) return false;
  return !!(await tx.userRole.findFirst({
    where: { userId: actorId, roleId: owner.id },
    select: { id: true },
  }));
}

export interface SettingValue {
  key: SettingKey;
  value: unknown;
  default: unknown;
  isDefault: boolean;
  version: number;
  updatedAt: string | null;
}

/** อ่านค่าตั้งหลาย key ของ tenant (ใช้ได้ทั้งใน request และนอก request เช่น auth ที่ใช้ client platform) */
export async function readSettings(
  db: Pick<PrismaClient, 'tenantSetting' | 'tenant'> | Tx,
  tenantId: string,
  keys: readonly SettingKey[] = SETTING_KEYS,
): Promise<Record<string, unknown>> {
  const needTenant = keys.some((k) => 'store' in SETTINGS[k]);
  const [rows, tenant] = await Promise.all([
    db.tenantSetting.findMany({ where: { tenantId, key: { in: [...keys] } } }),
    needTenant ? db.tenant.findUnique({ where: { id: tenantId } }) : null,
  ]);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const def = SETTINGS[k];
    const row = rows.find((r) => r.key === k);
    if ('store' in def && def.store && tenant) out[k] = tenant[def.store.column];
    else out[k] = row ? row.value : def.default;
  }
  return out;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private tenantId() {
    return requestContext.require().tenantId!;
  }

  async list(): Promise<SettingValue[]> {
    const tx = this.db.tx;
    const tenantId = this.tenantId();
    const [rows, tenant] = await Promise.all([
      tx.tenantSetting.findMany(),
      tx.tenant.findUnique({ where: { id: tenantId } }),
    ]);
    return SETTING_KEYS.map((key) => {
      const def = SETTINGS[key];
      const row = rows.find((r) => r.key === key);
      const stored = 'store' in def && def.store && tenant ? tenant[def.store.column] : undefined;
      const value = stored !== undefined ? stored : row ? row.value : def.default;
      return {
        key,
        value: presentSetting(key, value),
        default: def.default,
        isDefault: stored !== undefined ? false : !row,
        version: row?.version ?? 0,
        updatedAt:
          (row?.updatedAt ?? (stored !== undefined ? tenant?.updatedAt : null))?.toISOString() ??
          null,
      };
    });
  }

  /** แก้หลาย key ใน transaction เดียว — key ไม่รู้จัก/ค่าผิด type → 422 ทั้งก้อน; ลง audit ต่อ key ที่เปลี่ยน */
  /**
   * @param versions version ที่ client เห็นตอน GET ต่อ key (optimistic lock — ไม่ตรง → 412; key ที่เก็บในตาราง tenant ไม่มี version)
   * @param steppedUp ผ่าน step-up 2FA แล้วหรือยัง — การลดความปลอดภัยต้อง step-up (review T17)
   */
  async update(
    values: Record<string, unknown>,
    versions: Record<string, number> = {},
    steppedUp = false,
  ): Promise<SettingValue[]> {
    const tx = this.db.tx;
    const tenantId = this.tenantId();
    const errors = Object.entries(values).flatMap(([key, v]) => {
      if (!(SETTING_KEYS as string[]).includes(key))
        return [
          { field: `values.${key}`, code: 'unknown_setting', message: 'unknown setting key' },
        ];
      const detail = settingFieldErrors(key as SettingKey, v);
      if (detail.length)
        return detail.map((e) => ({
          field: e.path ? `values.${key}.${e.path}` : `values.${key}`,
          code: e.code,
          message: e.message,
        }));
      const msg = validateSetting(key as SettingKey, v);
      if (!msg) return [];
      // ST9-T14 ระยะเก็บต่ำกว่าขั้นต่ำ (docs/04 J) — แยก code ให้ client บอกผู้ใช้ได้ตรง
      const t = SETTINGS[key as SettingKey].type;
      const below =
        key.startsWith('retention.') &&
        t.kind === 'int' &&
        Number.isInteger(v) &&
        (v as number) < t.min;
      return [
        {
          field: `values.${key}`,
          code: below ? 'below_minimum' : 'invalid_setting',
          message: below ? `must be at least ${t.min} (minimum retention)` : msg,
        },
      ];
    });
    // ref ต้องชี้ entity ที่มีอยู่และใช้งานใน tenant นี้ (RLS กรองให้)
    for (const [key, v] of Object.entries(values)) {
      const def = SETTINGS[key as SettingKey];
      if (
        !def ||
        def.type.kind !== 'ref' ||
        typeof v !== 'string' ||
        errors.some((e) => e.field === `values.${key}`)
      )
        continue;
      const id = tryDecodeId('company', v);
      const c = id ? await tx.company.findUnique({ where: { id } }) : null;
      if (!c || c.status !== 'ACTIVE')
        errors.push({
          field: `values.${key}`,
          code: 'invalid_setting',
          message: 'company not found or inactive',
        });
    }
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
    for (const [k, v] of Object.entries(values)) values[k] = normalizeSetting(k as SettingKey, v);
    const keys = Object.keys(values) as SettingKey[];
    // ล็อกแถวของ key ที่จะแก้ก่อนตรวจ version (กันสองคนบันทึกพร้อมกัน)
    await tx.$queryRaw`SELECT key FROM tenant_setting WHERE key = ANY(${keys}::text[]) FOR UPDATE`;
    const rows = await tx.tenantSetting.findMany({ where: { key: { in: keys } } });
    for (const [k, expected] of Object.entries(versions)) {
      if (!(k in values) || 'store' in (SETTINGS[k as SettingKey] ?? {})) continue;
      if ((rows.find((r) => r.key === k)?.version ?? 0) !== expected)
        throw new ProblemException('precondition_failed');
    }
    const before = await readSettings(tx, tenantId, keys);
    // D-60 (docs/04 A3 "ปิดได้สำหรับ tenant เล็กโดย owner ยอมรับความเสี่ยง"): กฎแบ่งหน้าที่บางข้อเปลี่ยนได้เฉพาะ owner
    for (const key of OWNER_ONLY_SETTINGS) {
      if (!(key in values) || stableStringify(values[key]) === stableStringify(before[key]))
        continue;
      if (!(await isOwner(tx, requestContext.require().actorId)))
        throw new ProblemException('permission_denied', undefined, undefined, {
          module: 'settings',
          action: key,
          required: ['owner'],
        });
    }
    if (!steppedUp && weakensSecurity(before, values))
      throw new ProblemException('step_up_required');
    const actor = requestContext.require().actorId ?? null;
    for (const [k, v] of Object.entries(values)) {
      const key = k as SettingKey;
      // เทียบแบบไม่สนลำดับ key (jsonb คืน key เรียงใหม่ — QA T05: บันทึกค่าเดิมต้องไม่เพิ่ม version/ไม่ลง audit)
      if (stableStringify(before[key]) === stableStringify(v)) continue;
      const def = SETTINGS[key];
      if ('store' in def && def.store) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: {
            [def.store.column]: typeof v === 'string' ? v.trim() : v,
          } as Prisma.TenantUpdateInput,
        });
      } else {
        await tx.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key } },
          create: { tenantId, key, value: v as Prisma.InputJsonValue, updatedBy: actor },
          update: {
            value: v as Prisma.InputJsonValue,
            updatedBy: actor,
            version: { increment: 1 },
          },
        });
      }
      await this.audit.record({
        action: 'tenant_setting.updated',
        entityType: 'tenant_setting',
        entityId: key,
        before: { [key]: before[key] },
        after: { [key]: v },
      });
    }
    return this.list();
  }
}

/**
 * การแก้ที่ลดความปลอดภัย (ปิดบังคับ 2FA ทั้งองค์กร, ปิดออกจากระบบอัตโนมัติ, ยืด idle timeout, ลดระยะเก็บ — ST9-T14) ต้อง step-up 2FA
 * — สอดคล้องกับ A3 "เปลี่ยน role ต้อง step-up" (review T17; [OPEN] ยืนยันกับ PO)
 */
export function weakensSecurity(before: Record<string, unknown>, after: Record<string, unknown>) {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(after, k);
  if (
    has('security.require2faAll') &&
    before['security.require2faAll'] === true &&
    after['security.require2faAll'] === false
  )
    return true;
  if (
    has('security.autoLogout') &&
    before['security.autoLogout'] !== false &&
    after['security.autoLogout'] === false
  )
    return true;
  if (
    has('security.idleTimeoutMinutes') &&
    Number(after['security.idleTimeoutMinutes']) > Number(before['security.idleTimeoutMinutes'])
  )
    return true;
  // ST6-T07 ยกวงเงิน step-up การอนุมัติใบสำคัญจ่าย (หรือปิด = null) = คุมการจ่ายเงินหลวมขึ้น — ต้อง step-up
  if (has('settlement.approvalStepUpAmount')) {
    const b = before['settlement.approvalStepUpAmount'];
    const a = after['settlement.approvalStepUpAmount'];
    if (b !== null && (a === null || Number(a) > Number(b))) return true;
  }
  // ST6-T05 ปิดขั้นให้รถร่วมตรวจก่อนอนุมัติ = คุมการจ่ายเงินหลวมขึ้น — ต้อง step-up
  if (
    has('settlement.carrierReviewRequired') &&
    before['settlement.carrierReviewRequired'] === true &&
    after['settlement.carrierReviewRequired'] === false
  )
    return true;
  // D-60 ปิดกฎแบ่งหน้าที่การจ่าย (ผู้อนุมัติบันทึกจ่ายเองได้) = คุมการจ่ายเงินหลวมขึ้น — ต้อง step-up
  if (
    has('settlement.allowApproverMarkPaid') &&
    before['settlement.allowApproverMarkPaid'] !== true &&
    after['settlement.allowApproverMarkPaid'] === true
  )
    return true;
  // ST5-T09 ปิดกฎแบ่งหน้าที่ของใบแจ้งหนี้ (ผู้สร้างออกเอกสารเองได้) = คุมหลวมขึ้น — ต้อง step-up (A3 "owner ยอมรับความเสี่ยง")
  if (
    has('billing.allowSelfFinalize') &&
    before['billing.allowSelfFinalize'] !== true &&
    after['billing.allowSelfFinalize'] === true
  )
    return true;
  // ST5-T13 ยกวงเงินส่วนต่างที่บัญชีตัดยอดเองได้ = คุมหลวมขึ้น — ต้อง step-up
  if (
    has('payments.maxDifferenceAmount') &&
    Number(after['payments.maxDifferenceAmount']) > Number(before['payments.maxDifferenceAmount'])
  )
    return true;
  // ST8-T13 เลื่อนเกณฑ์อายุใบที่ต้องอนุมัติก่อนแทนที่ในระบบบัญชี = คุมหลวมขึ้น — ต้อง step-up
  if (
    has('billing.erpReplaceApprovalDays') &&
    Number(after['billing.erpReplaceApprovalDays']) >
      Number(before['billing.erpReplaceApprovalDays'])
  )
    return true;
  // ST9-T14 ลดระยะเก็บ = ข้อมูลเก่าถูกลบเร็วขึ้น (ย้อนคืนไม่ได้) — ต้อง step-up เหมือนลดความปลอดภัย
  for (const k of Object.keys(after))
    if (k.startsWith('retention.') && Number(after[k]) < Number(before[k])) return true;
  return false;
}
