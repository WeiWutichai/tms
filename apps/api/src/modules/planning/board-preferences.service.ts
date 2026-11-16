import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import {
  BOARD_CARD_FIELDS,
  BOARD_VIEWS,
  type BoardCardField,
  type BoardPreferencesDto,
  type BoardView,
  type UpdateBoardPreferencesDto,
} from './planning.dto';

/** key ของ user_preference สำหรับกระดานวางแผน */
export const BOARD_PREF_KEY = 'planning.board';
const DEFAULT: { view: BoardView; cardFields: BoardCardField[] } = {
  view: 'FLEET',
  cardFields: [...BOARD_CARD_FIELDS],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * มุมมอง + field บนการ์ดของกระดานวางแผน จำต่อผู้ใช้ฝั่ง server (ST3-T13; docs/04 D2 "View")
 * เก็บใน `user_preference` (RLS ต่อ tenant + แถวของผู้ใช้เอง) — ค่าที่เสีย/รู้จักไม่ได้ → ค่าเริ่มต้น (อ่านได้เสมอ)
 * credential ที่ไม่ใช่ผู้ใช้ (API key) ไม่มีค่าส่วนตัว → 404
 */
@Injectable()
export class BoardPreferencesService {
  constructor(private readonly db: DbService) {}

  async get(): Promise<BoardPreferencesDto> {
    const userId = await this.userId();
    const row = await this.db.tx.userPreference.findUnique({
      where: { userId_key: { userId, key: BOARD_PREF_KEY } },
    });
    return row ? { ...normalize(row.value), version: row.version } : { ...DEFAULT, version: 0 };
  }

  /** แทนค่าทั้งชุด · `expected` (If-Match) ไม่ตรง → 412 */
  async put(body: UpdateBoardPreferencesDto, expected?: number): Promise<BoardPreferencesDto> {
    const ctx = requestContext.require();
    const userId = await this.userId();
    const value = normalize(body);
    const tx = this.db.tx;
    const cur = await tx.userPreference.findUnique({
      where: { userId_key: { userId, key: BOARD_PREF_KEY } },
    });
    if (expected !== undefined && expected !== (cur?.version ?? 0))
      throw new ProblemException('precondition_failed');
    const json = value as unknown as Prisma.InputJsonObject;
    if (!cur) {
      try {
        const row = await tx.userPreference.create({
          data: { tenantId: ctx.tenantId!, userId, key: BOARD_PREF_KEY, value: json },
        });
        return { ...value, version: row.version };
      } catch (e) {
        // บันทึกพร้อมกันสองแท็บ — แถวเพิ่งถูกสร้าง = ชนกัน
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ProblemException('precondition_failed');
        throw e;
      }
    }
    const r = await tx.userPreference.updateMany({
      where: { id: cur.id, version: cur.version },
      data: { value: json, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return { ...value, version: cur.version + 1 };
  }

  private async userId(): Promise<string> {
    const ctx = requestContext.require();
    const u =
      ctx.actorId && UUID.test(ctx.actorId)
        ? await this.db.tx.appUser.findFirst({
            where: { id: ctx.actorId, status: 'ACTIVE' },
            select: { id: true },
          })
        : null;
    if (!u) throw new ProblemException('not_found');
    return u.id;
  }
}

/** ตรวจ/จัดรูปค่า: view ที่ไม่รู้จัก → FLEET · field เรียงตามลำดับมาตรฐาน ไม่ซ้ำ ว่าง → ทุก field */
export function normalize(v: unknown): { view: BoardView; cardFields: BoardCardField[] } {
  const o = (v && typeof v === 'object' ? v : {}) as { view?: unknown; cardFields?: unknown };
  const view = BOARD_VIEWS.includes(o.view as BoardView) ? (o.view as BoardView) : DEFAULT.view;
  const set = new Set(Array.isArray(o.cardFields) ? o.cardFields : []);
  const cardFields = BOARD_CARD_FIELDS.filter((f) => set.has(f));
  return { view, cardFields: cardFields.length ? cardFields : [...DEFAULT.cardFields] };
}
