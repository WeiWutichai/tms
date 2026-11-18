import { Injectable } from '@nestjs/common';
import { Prisma, type SavedView } from '@prisma/client';
import { encodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { lockKey } from '../master/master-kit';
import {
  FIELD_KEY,
  type CreateSavedViewDto,
  type SavedViewDto,
  type SavedViewListQuery,
  type UpdateSavedViewDto,
} from './saved-views.dto';

/** จำนวนมุมมองสูงสุดต่อผู้ใช้ต่อหน้า — กันข้อมูลบวม (ไม่ใช่ข้อกำหนดธุรกิจ) */
export const VIEW_LIMIT = 50;
const MAX_KEYS = 40;
const MAX_VALUE = 200;
const MAX_STATE = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type State = Record<string, string | number | boolean | null>;

/**
 * มุมมองที่บันทึกไว้ของตาราง/รายงาน (ST9-T11; docs/04 I "saved views", H "บันทึก filter ชุดเป็นชื่อ")
 * - ต่อผู้ใช้ที่ login: เห็น/แก้/ลบได้เฉพาะของตัวเอง (ของผู้ใช้อื่นใน tenant เดียวกัน = 404 เหมือนบริษัทอื่น)
 * - แชร์ในทีม = P1 (docs/04 H) · credential ที่ไม่ใช่ผู้ใช้ (API key) ไม่มีมุมมอง → 404
 * - ค่าส่วนตัว ไม่ใช่เอกสาร → ไม่ลง audit (เหมือน user_preference ST3-T13) · ลบ = soft
 */
@Injectable()
export class SavedViewsService {
  constructor(private readonly db: DbService) {}

  async list(q: SavedViewListQuery) {
    const userId = await this.userId();
    const k = keysetArgs(q);
    const rows = await this.db.tx.savedView.findMany({
      where: {
        AND: [{ userId, page: q.page, deletedAt: null }, k.where as Prisma.SavedViewWhereInput],
      },
      orderBy: k.orderBy as unknown as Prisma.SavedViewOrderByWithRelationInput[],
      take: k.take,
    });
    return toPage(rows, k, toSavedViewDto, q.fields);
  }

  async get(id: string): Promise<SavedView> {
    const userId = await this.userId();
    const v = await this.db.tx.savedView.findFirst({ where: { id, userId, deletedAt: null } });
    if (!v) throw new ProblemException('not_found');
    return v;
  }

  async create(body: CreateSavedViewDto): Promise<SavedView> {
    const ctx = requestContext.require();
    const userId = await this.userId();
    const tx = this.db.tx;
    const state = checkState(body.state);
    const hidden = checkHidden(body.hiddenColumns);
    await this.lock(userId, body.page);
    const n = await tx.savedView.count({ where: { userId, page: body.page, deletedAt: null } });
    if (n >= VIEW_LIMIT)
      throw new ProblemException('saved_view_limit', undefined, undefined, { limit: VIEW_LIMIT });
    await this.assertNameFree(userId, body.page, body.name);
    if (body.isDefault) await this.clearDefault(userId, body.page);
    return tx.savedView.create({
      data: {
        tenantId: ctx.tenantId!,
        userId,
        page: body.page,
        name: body.name,
        state: state as Prisma.InputJsonObject,
        hiddenColumns: hidden === null ? Prisma.DbNull : hidden,
        isDefault: body.isDefault ?? false,
      },
    });
  }

  /** แก้บางช่อง · `expected` (If-Match) ไม่ตรง → 412 */
  async update(id: string, body: UpdateSavedViewDto, expected?: number): Promise<SavedView> {
    const tx = this.db.tx;
    const cur = await this.get(id);
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    const state = body.state !== undefined ? checkState(body.state) : undefined;
    const hidden = body.hiddenColumns !== undefined ? checkHidden(body.hiddenColumns) : undefined;
    await this.lock(cur.userId, cur.page);
    if (body.name !== undefined && body.name.toLowerCase() !== cur.name.toLowerCase())
      await this.assertNameFree(cur.userId, cur.page, body.name, id);
    if (body.isDefault && !cur.isDefault) await this.clearDefault(cur.userId, cur.page);
    const r = await tx.savedView.updateMany({
      where: { id, version: cur.version, deletedAt: null },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(state !== undefined ? { state: state as Prisma.InputJsonObject } : {}),
        ...(hidden !== undefined
          ? { hiddenColumns: hidden === null ? Prisma.DbNull : hidden }
          : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.savedView.findUnique({ where: { id } }))!;
  }

  /** ลบ (soft) — ไม่ต้องใส่เหตุผล (ค่าส่วนตัว ไม่ใช่การยกเลิกเอกสาร) */
  async remove(id: string, expected?: number): Promise<void> {
    const cur = await this.get(id);
    if (expected !== undefined && expected !== cur.version)
      throw new ProblemException('precondition_failed');
    const r = await this.db.tx.savedView.updateMany({
      where: { id, version: cur.version, deletedAt: null },
      data: { deletedAt: new Date(), isDefault: false, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
  }

  /** ล็อกต่อ (ผู้ใช้, หน้า) ใน transaction — กันสร้างชื่อซ้ำ/ค่าเริ่มต้นซ้อนจากสองแท็บพร้อมกัน */
  private async lock(userId: string, page: string) {
    await lockKey(this.db.tx, `saved_view:${userId}:${page}`);
  }

  private async clearDefault(userId: string, page: string) {
    await this.db.tx.savedView.updateMany({
      where: { userId, page, isDefault: true, deletedAt: null },
      data: { isDefault: false, version: { increment: 1 } },
    });
  }

  private async assertNameFree(userId: string, page: string, name: string, exceptId?: string) {
    const dup = await this.db.tx.savedView.findFirst({
      where: {
        userId,
        page,
        deletedAt: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'name', code: 'duplicate', message: 'view name already exists on this page' },
      ]);
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

/** ตรวจ state: object แบน key ตามรูป ค่า string ≤ 200 / number จำกัด / boolean / null ขนาดรวม ≤ 4,000 → 422 รายช่อง */
export function checkState(v: unknown): State {
  const errors: FieldError[] = [];
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new ProblemException('validation_failed', undefined, [
      { field: 'state', code: 'invalid', message: 'must be an object' },
    ]);
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_KEYS)
    errors.push({ field: 'state', code: 'too_many_keys', message: `at most ${MAX_KEYS} keys` });
  for (const [k, x] of entries) {
    if (!FIELD_KEY.test(k))
      errors.push({ field: `state.${k}`, code: 'invalid_key', message: 'invalid key' });
    else if (typeof x === 'string') {
      if (x.length > MAX_VALUE)
        errors.push({ field: `state.${k}`, code: 'too_long', message: `max ${MAX_VALUE} chars` });
    } else if (typeof x === 'number') {
      if (!Number.isFinite(x))
        errors.push({ field: `state.${k}`, code: 'invalid', message: 'must be finite' });
    } else if (x !== null && typeof x !== 'boolean')
      errors.push({
        field: `state.${k}`,
        code: 'invalid_type',
        message: 'must be string, number, boolean or null',
      });
  }
  if (!errors.length && JSON.stringify(v).length > MAX_STATE)
    errors.push({ field: 'state', code: 'too_large', message: `max ${MAX_STATE} chars` });
  if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
  return Object.fromEntries(entries) as State;
}

/** คอลัมน์ที่ซ่อน: ไม่ซ้ำ คงลำดับ · null = ค่าเริ่มต้น */
export function checkHidden(v: string[] | null | undefined): string[] | null {
  if (v === null || v === undefined) return null;
  return [...new Set(v)];
}

export function toSavedViewDto(v: SavedView): SavedViewDto {
  return {
    id: encodeId('savedView', v.id),
    page: v.page,
    name: v.name,
    state: v.state as State,
    hiddenColumns: Array.isArray(v.hiddenColumns) ? (v.hiddenColumns as string[]) : null,
    isDefault: v.isDefault,
    version: v.version,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}
