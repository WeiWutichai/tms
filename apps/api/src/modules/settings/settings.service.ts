import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { SETTING_KEYS, SETTINGS, validateSetting, type SettingKey } from './registry';

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
        value,
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
      const msg = validateSetting(key as SettingKey, v);
      return msg ? [{ field: `values.${key}`, code: 'invalid_setting', message: msg }] : [];
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
    for (const [k, v] of Object.entries(values)) if (typeof v === 'string') values[k] = v.trim();
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
    if (!steppedUp && weakensSecurity(before, values))
      throw new ProblemException('step_up_required');
    const actor = requestContext.require().actorId ?? null;
    // กดบันทึกโดยไม่เปลี่ยนค่า = ยืนยันว่าตรวจแล้ว (ST1-T21 checklist นับขั้น "องค์กร"/"ภาษี" จากบันทึกนี้)
    if (keys.length && keys.every((k) => JSON.stringify(before[k]) === JSON.stringify(values[k])))
      await this.audit.record({
        action: 'tenant_setting.reviewed',
        entityType: 'tenant_setting',
        entityId: keys[0]!,
        after: { keys },
      });
    for (const [k, v] of Object.entries(values)) {
      const key = k as SettingKey;
      if (JSON.stringify(before[key]) === JSON.stringify(v)) continue;
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
 * การแก้ที่ลดความปลอดภัย (ปิดบังคับ 2FA ทั้งองค์กร, ปิดออกจากระบบอัตโนมัติ, ยืด idle timeout) ต้อง step-up 2FA
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
  return false;
}
