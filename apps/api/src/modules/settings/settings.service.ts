import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
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
  const [rows, tenant] = await Promise.all([
    db.tenantSetting.findMany({ where: { tenantId, key: { in: [...keys] } } }),
    db.tenant.findUnique({ where: { id: tenantId } }),
  ]);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const def = SETTINGS[k];
    if ('store' in def && def.store && tenant) out[k] = tenant[def.store.column];
    else out[k] = rows.find((r) => r.key === k)?.value ?? def.default;
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
      const value = stored !== undefined ? stored : (row?.value ?? def.default);
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
  async update(values: Record<string, unknown>): Promise<SettingValue[]> {
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
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
    const before = await readSettings(tx, tenantId, Object.keys(values) as SettingKey[]);
    const actor = requestContext.require().actorId ?? null;
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
