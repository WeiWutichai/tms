import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import {
  parsePlatformSetting,
  PLATFORM_SETTING_KEYS,
  PLATFORM_SETTINGS,
  type PlatformSettingDef,
  type PlatformSettingKey,
} from './platform-settings.registry';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * ค่าที่มีผลของค่าตั้ง 1 ตัว (registry parse + ค่าเริ่มต้น) — ใช้ได้นอก Nest (bootstrapTenant, CLI, seed)
 * แถวเก่าที่ type ไม่ตรง registry ปัจจุบัน (เปลี่ยน type ภายหลัง) → ค่าเริ่มต้น
 */
export async function readPlatformSetting<T = unknown>(
  db: Db,
  key: PlatformSettingKey,
): Promise<T> {
  const row = await db.platformSetting.findUnique({ where: { key } });
  const def: PlatformSettingDef = PLATFORM_SETTINGS[key];
  const p = row ? parsePlatformSetting(def, row.value) : null;
  return (p?.ok ? p.value : def.default) as T;
}

/** ค่าที่มีผลของค่าตั้งแพลตฟอร์ม — อ่านสดทุกครั้ง (ค่าใหม่มีผลกับเหตุการณ์ถัดไปทันที ไม่มี cache ข้าม instance) */
@Injectable()
export class PlatformSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  get<T = unknown>(key: PlatformSettingKey, db: Db = this.prisma.platform): Promise<T> {
    return readPlatformSetting<T>(db, key);
  }

  async all(db: Db = this.prisma.platform): Promise<Record<PlatformSettingKey, unknown>> {
    const rows = await db.platformSetting.findMany();
    const by = new Map(rows.map((r) => [r.key, r.value]));
    const out = {} as Record<PlatformSettingKey, unknown>;
    for (const k of PLATFORM_SETTING_KEYS) {
      const def: PlatformSettingDef = PLATFORM_SETTINGS[k];
      const p = by.has(k) ? parsePlatformSetting(def, by.get(k)) : null;
      out[k] = p?.ok ? p.value : def.default;
    }
    return out;
  }
}
