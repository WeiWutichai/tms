import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import {
  parsePlatformSetting,
  PLATFORM_SETTING_KEYS,
  PLATFORM_SETTINGS,
  type PlatformSettingDef,
  type PlatformSettingKey,
} from './platform-settings.registry';

type Db = PrismaService['platform'] | Prisma.TransactionClient;

/** ค่าที่มีผลของค่าตั้งแพลตฟอร์ม — อ่านสดทุกครั้ง (ค่าใหม่มีผลกับเหตุการณ์ถัดไปทันที ไม่มี cache ข้าม instance) */
@Injectable()
export class PlatformSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: PlatformSettingKey, db: Db = this.prisma.platform): Promise<T> {
    const row = await db.platformSetting.findUnique({ where: { key } });
    const def: PlatformSettingDef = PLATFORM_SETTINGS[key];
    // แถวเก่าที่ type ไม่ตรง registry ปัจจุบัน (เปลี่ยน type ภายหลัง) → ค่าเริ่มต้น
    const p = row ? parsePlatformSetting(def, row.value) : null;
    return (p?.ok ? p.value : def.default) as T;
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
