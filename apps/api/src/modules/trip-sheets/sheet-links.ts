import { Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { requestContext } from '../../common/request-context';
import type { Tx } from '../../db/db.service';
import { MagicLinkService } from '../links/magic-link.service';

export const SHEET_LINK_PURPOSE = 'trip_sheet' as const;

/** เหตุที่เพิกถอนลิงก์ใบคุมรถของคนขับ (docs/04 A1 "เพิกถอนได้" · PDPA — review/QA ST3-T20) */
export type SheetLinkRevokeCause = 'REISSUED' | 'MANUAL' | 'TRIP_CANCELLED' | 'DRIVER_CHANGED';

export const SYSTEM_REVOKE_REASON: Record<Exclude<SheetLinkRevokeCause, 'MANUAL'>, string> = {
  REISSUED: 'ออกลิงก์ใหม่',
  TRIP_CANCELLED: 'ยกเลิกเที่ยว — ลิงก์ใบคุมรถใช้ไม่ได้แล้ว',
  DRIVER_CHANGED: 'เปลี่ยนคนขับ — ลิงก์ใบคุมรถของคนขับเดิมใช้ไม่ได้แล้ว',
};

/**
 * ลิงก์ใบคุมรถของเที่ยว (magic link `trip_sheet` → stored_document ของเที่ยว) — หา/เพิกถอนทั้งหมดที่ยังใช้ได้
 * เรียกจาก: ออกลิงก์ใหม่ (แทนของเดิม), เพิกถอนเอง, ยกเลิกเที่ยว และเปลี่ยนคนขับ (TripService)
 * เพิกถอนแต่ละลิงก์ = audit `magic_link.revoked` (MagicLinkService) + สรุป `trip_sheet.links_revoked` ที่เที่ยว
 */
@Injectable()
export class TripSheetLinks {
  constructor(
    private readonly links: MagicLinkService,
    private readonly audit: AuditService,
  ) {}

  async active(tx: Tx, tripId: string) {
    const docs = await tx.storedDocument.findMany({
      where: { entityType: 'trip', entityId: tripId, kind: 'PDF' },
      select: { id: true },
    });
    if (!docs.length) return [];
    return tx.magicLink.findMany({
      where: {
        purpose: SHEET_LINK_PURPOSE,
        entityType: 'stored_document',
        entityId: { in: docs.map((d) => d.id) },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** คืนจำนวนลิงก์ที่เพิกถอน (ไม่มี = 0 ไม่ลง audit) */
  async revokeForTrip(
    tx: Tx,
    tripId: string,
    cause: SheetLinkRevokeCause,
    reason: string = cause === 'MANUAL' ? '' : SYSTEM_REVOKE_REASON[cause],
  ): Promise<number> {
    const ls = await this.active(tx, tripId);
    if (!ls.length) return 0;
    const actor = requestContext.get()?.actorId ?? undefined;
    const done: string[] = [];
    for (const l of ls) if (await this.links.revoke(tx, l.id, reason, actor)) done.push(l.id);
    if (done.length)
      await this.audit.record({
        action: 'trip_sheet.links_revoked',
        entityType: 'trip',
        entityId: tripId,
        after: { cause, linkIds: done.map((id) => encodeId('magicLink', id)) },
        reason,
      });
    return done.length;
  }
}
