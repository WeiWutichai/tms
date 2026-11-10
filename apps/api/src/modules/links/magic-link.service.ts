import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isLocalEnv } from '../../auth/tokens';
import { PrismaService } from '../../db/prisma.service';
import type { Tx } from '../../db/db.service';

/**
 * Magic link (ST1-T06; docs/04 A1 "เข้าถึงโดยไม่ login", J "Magic link"; docs/01 §5.5 M10)
 * token = `ml1.<id>.<exp>.<sig>` — sig = HMAC-SHA256(id|exp) · action ที่ทำได้ + การเพิกถอนอยู่ในแถว magic_link
 * ใช้กับ: ข้อเสนองานรถร่วม (48 ชม.), POD ผ่านลิงก์ (จนปิด trip + 7 วัน), ดูใบจ่าย, ติดตามพัสดุ
 */
export const LINK_PURPOSES = ['trip_offer', 'pod', 'settlement_view', 'tracking'] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];

function key(): Buffer {
  const s =
    process.env.MAGIC_LINK_SECRET ??
    process.env.AUTH_JWT_SECRET ??
    (isLocalEnv() ? process.env.AUTH_DEV_SECRET : undefined);
  if (!s || s.length < 32) throw new Error('MAGIC_LINK_SECRET (>= 32 chars) required');
  return createHmac('sha256', s).update('tms-magic-link-v1').digest();
}

const sign = (id: string, exp: number) =>
  createHmac('sha256', key()).update(`${id}|${exp}`).digest('base64url');

export function encodeLinkToken(id: string, exp: number): string {
  return `ml1.${id.replace(/-/g, '')}.${exp}.${sign(id, exp)}`;
}

/** คืน { id, exp } ถ้ารูปแบบและลายเซ็นถูก (ยังไม่ตรวจหมดอายุ/เพิกถอน/action — ทำที่ resolve) */
export function decodeLinkToken(token: string): { id: string; exp: number } | null {
  const m = /^ml1\.([0-9a-f]{32})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const hex = m[1]!;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const exp = Number(m[2]);
  let want: Buffer;
  try {
    want = Buffer.from(sign(id, exp));
  } catch {
    return null;
  }
  const got = Buffer.from(m[3]!);
  return want.length === got.length && timingSafeEqual(want, got) ? { id, exp } : null;
}

export interface IssueLinkInput {
  purpose: LinkPurpose;
  entityType: string;
  entityId: string;
  actions: string[];
  /** scope เพิ่มของลิงก์ เช่น ['prices.buy:read'] ให้รถร่วมเห็นค่าจ้างของตัวเอง — ราคาขายใส่ไม่ได้ */
  scopes?: string[];
  ttlSeconds: number;
  createdBy?: string;
}

export interface ResolvedLink {
  id: string;
  tenantId: string;
  purpose: string;
  entityType: string;
  entityId: string;
  actions: string[];
  scopes: string[];
}

@Injectable()
export class MagicLinkService {
  constructor(private readonly prisma: PrismaService) {}

  /** ออกลิงก์ใน transaction ของผู้เรียก (โมดูลเจ้าของ เช่น ST3-T23 ข้อเสนองาน) */
  async issue(tx: Tx, tenantId: string, input: IssueLinkInput) {
    if (input.actions.length === 0) throw new Error('magic link needs at least one action');
    if ((input.scopes ?? []).some((s) => s.startsWith('prices.sell')))
      throw new Error('magic link can never carry selling-price scopes');
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
    const row = await tx.magicLink.create({
      data: {
        tenantId,
        purpose: input.purpose,
        entityType: input.entityType,
        entityId: input.entityId,
        actions: input.actions,
        scopes: input.scopes ?? [],
        expiresAt,
        createdBy: input.createdBy ?? null,
      },
    });
    return {
      id: row.id,
      token: encodeLinkToken(row.id, Math.floor(expiresAt.getTime() / 1000)),
      expiresAt,
    };
  }

  async revoke(tx: Tx, id: string, reason: string) {
    await tx.magicLink.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** ตรวจลิงก์สำหรับ action หนึ่ง — ไม่ผ่านด้วยเหตุใดก็คืน null (route ตอบ 404 เหมือนไม่มี — ไม่บอกใบ้) */
  async resolve(token: string, action: string): Promise<ResolvedLink | null> {
    const t = decodeLinkToken(token);
    if (!t || t.exp * 1000 <= Date.now()) return null;
    // ยังไม่รู้ tenant → ใช้ client platform ค้นด้วย id (uuid สุ่ม 122 bit ที่ลายเซ็นยืนยันแล้ว)
    const row = await this.prisma.platform.magicLink.findUnique({ where: { id: t.id } });
    if (
      !row ||
      row.revokedAt ||
      row.expiresAt.getTime() <= Date.now() ||
      !row.actions.includes(action)
    )
      return null;
    // token ต้องตรงกับอายุในแถว (กันเอาลายเซ็นของอายุอื่นมาใช้)
    if (Math.floor(row.expiresAt.getTime() / 1000) !== t.exp) return null;
    void this.prisma.platform.magicLink
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    return {
      id: row.id,
      tenantId: row.tenantId,
      purpose: row.purpose,
      entityType: row.entityType,
      entityId: row.entityId,
      actions: row.actions,
      scopes: row.scopes.filter((s) => !s.startsWith('prices.sell')),
    };
  }
}
