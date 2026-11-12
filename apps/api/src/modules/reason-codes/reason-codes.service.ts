import { Injectable } from '@nestjs/common';
import { Prisma, type ActiveStatus, type ReasonCode } from '@prisma/client';
import type { TransitionTable } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { StateService } from '../../state/state.service';
import { EXPORT_MAX_ROWS } from '../master/export';
import {
  assertNotReferenced,
  deletedFilter,
  emitMasterEvent,
  isNoopUpdate,
  likeEscape,
  lockForRemoval,
  lockKey,
  lockReferenced,
  masterKeyset,
  nextCode,
  statusFilter,
  upsertByExternalId,
} from '../master/master-kit';
import {
  AUTO_RESCHEDULE_CATEGORIES,
  REASON_CATEGORIES,
  TRACKING_CATEGORIES,
  type CreateReasonCodeDto,
  type ReasonCategoryApi,
  type ReasonCodeDto,
  type ReasonCodeListQuery,
  type UpdateReasonCodeDto,
  type UpsertReasonCodeDto,
} from './reason-code.dto';
import { snapshotReason, type ReasonSnapshot } from './snapshot';

export const REASON_CODE_PREFIX = 'RSN';
/** รายการ "อื่น ๆ" ของทุกหมวด (MD-221) — รหัสระบบ บังคับโน้ตเสมอ */
export const OTHER_CODE = 'OTHER';
type RcEvent = 'activate' | 'deactivate';
export const REASON_CODE_TRANSITIONS: TransitionTable<ActiveStatus, RcEvent> = {
  ACTIVE: { deactivate: 'INACTIVE' },
  INACTIVE: { activate: 'ACTIVE' },
};

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

export function toReasonCodeDto(r: ReasonCode): ReasonCodeDto {
  return {
    id: encodeId('reasonCode', r.id),
    category: r.category as ReasonCategoryApi,
    code: r.code,
    label: r.labelTh,
    labelEn: r.labelEn,
    requiresPhoto: r.requiresPhoto,
    requiresNote: r.requiresNote,
    autoReschedule: r.autoReschedule,
    showOnTracking: r.showOnTracking,
    sortOrder: r.sortOrder,
    system: r.isSystem,
    externalId: r.externalId,
    status: r.status.toLowerCase() as ReasonCodeDto['status'],
    ...(r.deletedAt ? { deletedAt: r.deletedAt.toISOString() } : {}),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** snapshot สำหรับ audit — ไม่มี updatedAt/version */
export function auditView(r: ReasonCode): Record<string, unknown> {
  const { updatedAt: _u, version: _v, ...rest } = toReasonCodeDto(r);
  return rest;
}

/** หมวดที่ API เปิด (CREDIT_NOTE/DEBIT_NOTE อยู่ใน enum ของฐานแต่ยังไม่เปิด — ST5) */
const API_CATEGORIES = REASON_CATEGORIES as readonly string[];

/**
 * เหตุผลมาตรฐาน (ST2-T12; docs/04 B Reason master, docs/01 §3.2, spec/02 §9) — master kit ของ ST2-T01
 * - หมวดเปลี่ยนไม่ได้หลังสร้าง (รหัส unique ต่อหมวด และ snapshot ในงานอ้างหมวด)
 * - ธง: นัดส่งใหม่อัตโนมัติเฉพาะ DELIVERY_FAILED · แสดงบน tracking เฉพาะเหตุผลหน้างาน (TRACKING_CATEGORIES) → 422 `not_applicable`
 * - รหัสระบบ (`is_system`: 12 รหัสใบค้างของ docs/04 C ตาม plan/11 ข้อ 4 + "อื่น ๆ" ทุกหมวด MD-221):
 *   แก้ข้อความ/ธงได้ · เปลี่ยนรหัส → 422 `system_code` · ลบ/ปิดใช้ → 409 `system_reason` · "อื่น ๆ" ปิดบังคับโน้ตไม่ได้ → 422
 * - แถวค่าเริ่มต้นอื่น (system_key แต่ไม่ใช่ is_system) แก้/ปิดใช้/ลบได้เหมือนแถวทั่วไป
 * - ลบ (soft) ได้เฉพาะที่ไม่เคยถูกอ้างอิง (MD-004) → 409 `in_use`; ปิดใช้ได้แม้ถูกอ้างอิง (งานเก็บ snapshot)
 */
@Injectable()
export class ReasonCodesService {
  constructor(
    private readonly db: DbService,
    private readonly state: StateService,
    private readonly audit: AuditService,
  ) {}

  // ---------- read ----------

  private where(q: ReasonCodeListQuery): Prisma.ReasonCodeWhereInput {
    const and: Prisma.ReasonCodeWhereInput[] = [
      deletedFilter(q),
      { category: { in: REASON_CATEGORIES as unknown as ReasonCode['category'][] } },
    ];
    const status = statusFilter(q.status);
    if (status) and.push({ status });
    if (q.externalId) and.push({ externalId: q.externalId });
    if (q.category)
      and.push({ category: { in: q.category.split(',') as ReasonCode['category'][] } });
    if (q.system) and.push({ isSystem: q.system === 'true' });
    const like = (v: string) => ({ contains: likeEscape(v), mode: 'insensitive' as const });
    if (q.label) and.push({ labelTh: like(q.label) });
    if (q.q)
      and.push({
        OR: [{ code: like(q.q) }, { labelTh: like(q.q) }, { externalId: like(q.q) }],
      });
    return { AND: and };
  }

  async list(q: ReasonCodeListQuery) {
    const k = masterKeyset(q);
    const rows = await this.db.tx.reasonCode.findMany({
      where: { AND: [this.where(q), k.where] },
      orderBy: k.orderBy,
      take: k.take,
    });
    return k.page(rows, toReasonCodeDto);
  }

  async exportRows(q: ReasonCodeListQuery) {
    const rows = await this.db.tx.reasonCode.findMany({
      where: this.where(q),
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
      take: EXPORT_MAX_ROWS + 1,
    });
    if (rows.length > EXPORT_MAX_ROWS)
      throw field422(
        'query',
        'too_many_rows',
        `export is limited to ${EXPORT_MAX_ROWS} rows — narrow the filter`,
      );
    return rows.map(toReasonCodeDto);
  }

  async nextCode(): Promise<string> {
    return nextCode(this.db.tx, 'reason_code', REASON_CODE_PREFIX);
  }

  async get(id: string): Promise<ReasonCode> {
    const r = await this.db.tx.reasonCode.findFirst({ where: { id, deletedAt: null } });
    if (!r || !API_CATEGORIES.includes(r.category)) throw new ProblemException('not_found');
    return r;
  }

  async getByExternalId(externalId: string): Promise<ReasonCode> {
    const r = await this.db.tx.reasonCode.findFirst({ where: { externalId, deletedAt: null } });
    if (!r || !API_CATEGORIES.includes(r.category)) throw new ProblemException('not_found');
    return r;
  }

  /**
   * ตัวช่วยของโมดูลงาน (ST3/ST4/ST6): ล็อกแถว (FOR SHARE — กันถูกลบระหว่างบันทึก) ตรวจว่าใช้งานอยู่และอยู่ในหมวดที่คาด
   * แล้วคืน snapshot ที่ต้องคัดลอกลงงาน (ดู snapshot.ts)
   * - ไม่พบ/ลบแล้ว → 422 `reason_not_found` · ปิดใช้ → 422 `reason_inactive` · หมวดไม่ตรง → 422 `reason_category`
   */
  async snapshotFor(
    id: string,
    category: ReasonCategoryApi | readonly ReasonCategoryApi[],
    field = 'reasonCodeId',
  ): Promise<Readonly<ReasonSnapshot>> {
    const tx = this.db.tx;
    const [locked] = await lockReferenced(tx, 'reason_code', [id]);
    if (!locked) throw field422(field, 'reason_not_found', 'reason code not found');
    const r = await tx.reasonCode.findUniqueOrThrow({ where: { id } });
    const allowed: readonly string[] = typeof category === 'string' ? [category] : category;
    if (!allowed.includes(r.category))
      throw field422(
        field,
        'reason_category',
        `reason ${r.code} is ${r.category}, expected ${allowed.join('/')}`,
      );
    if (r.status !== 'ACTIVE')
      throw field422(field, 'reason_inactive', `reason ${r.code} is inactive`);
    return snapshotReason(r);
  }

  // ---------- write ----------

  /** ตรวจธงตามหมวด (ค่าเดิม + ค่าที่ส่งมา) และกฎ "อื่น ๆ" ของระบบ */
  private toData(
    input: UpdateReasonCodeDto | CreateReasonCodeDto,
    category: ReasonCategoryApi,
    current?: ReasonCode,
  ): Prisma.ReasonCodeUncheckedUpdateInput {
    const data: Prisma.ReasonCodeUncheckedUpdateInput = {};
    if (input.label !== undefined) data.labelTh = input.label;
    if (input.labelEn !== undefined) data.labelEn = input.labelEn || null;
    if (input.requiresPhoto !== undefined) data.requiresPhoto = input.requiresPhoto;
    if (input.requiresNote !== undefined) data.requiresNote = input.requiresNote;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.autoReschedule !== undefined) {
      if (input.autoReschedule && !AUTO_RESCHEDULE_CATEGORIES.includes(category))
        throw field422(
          'autoReschedule',
          'not_applicable',
          'autoReschedule applies to DELIVERY_FAILED reasons only',
        );
      data.autoReschedule = input.autoReschedule;
    }
    if (input.showOnTracking !== undefined) {
      if (input.showOnTracking && !TRACKING_CATEGORIES.includes(category))
        throw field422(
          'showOnTracking',
          'not_applicable',
          `showOnTracking applies to ${TRACKING_CATEGORIES.join('/')} reasons only`,
        );
      data.showOnTracking = input.showOnTracking;
    }
    if (current?.isSystem && current.code === OTHER_CODE && input.requiresNote === false)
      throw field422(
        'requiresNote',
        'other_requires_note',
        'the system "other" reason always requires a note (MD-221)',
      );
    return data;
  }

  private assertCategoryOpen(category: string) {
    if (!API_CATEGORIES.includes(category))
      throw field422('category', 'isIn', `category ${category} is not available`);
  }

  private async assertUniqueLabel(category: string, label: string, exceptId?: string) {
    await lockKey(this.db.tx, `reason_code.label:${category}:${label.toLowerCase()}`);
    const dup = await this.db.tx.reasonCode.findFirst({
      where: {
        category: category as ReasonCode['category'],
        labelTh: iEquals(label),
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    if (dup)
      throw new ProblemException(
        'duplicate',
        undefined,
        [{ field: 'label', code: 'duplicate', message: `reason already exists: ${dup.code}` }],
        { existing: { id: encodeId('reasonCode', dup.id), code: dup.code, label: dup.labelTh } },
      );
  }

  private async assertUniqueExternal(externalId: string, exceptId?: string) {
    const dup = await this.db.tx.reasonCode.findFirst({
      where: { externalId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('duplicate', undefined, [
        { field: 'externalId', code: 'duplicate', message: 'externalId already used' },
      ]);
  }

  /** รหัส unique ต่อหมวด (รวมที่ลบ — unique index ของฐาน) */
  private async assertCodeFree(category: string, code: string, exceptId?: string) {
    const taken = await this.db.tx.reasonCode.findFirst({
      where: {
        category: category as ReasonCode['category'],
        code: iEquals(code),
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (taken)
      throw new ProblemException('duplicate', undefined, [
        { field: 'code', code: 'duplicate', message: 'code already exists in this category' },
      ]);
  }

  async create(
    input: CreateReasonCodeDto | (UpsertReasonCodeDto & { externalId: string }),
  ): Promise<ReasonCode> {
    const tx = this.db.tx;
    this.assertCategoryOpen(input.category);
    const data = this.toData(input, input.category);
    if (input.externalId) {
      await lockKey(tx, `reason_code.ext:${input.externalId}`);
      await this.assertUniqueExternal(input.externalId);
    }
    await this.assertUniqueLabel(input.category, input.label);
    await lockKey(tx, 'reason_code.code');
    let code = input.code;
    if (code) {
      if (code === OTHER_CODE)
        throw field422('code', 'reserved_code', `${OTHER_CODE} is reserved by the system`);
      await this.assertCodeFree(input.category, code);
    } else code = await nextCode(tx, 'reason_code', REASON_CODE_PREFIX);
    const r = await tx.reasonCode.create({
      data: {
        ...(data as object),
        category: input.category,
        code,
        externalId: input.externalId ?? null,
      } as Prisma.ReasonCodeUncheckedCreateInput, // tenantId เติมโดย tenantExtension
    });
    await this.audit.record({
      action: 'reason_code.created',
      entityType: 'reason_code',
      entityId: r.id,
      after: auditView(r),
    });
    await emitMasterEvent(tx, 'reason_code.created', 'reason_code', r.id, toReasonCodeDto(r));
    return r;
  }

  async update(id: string, input: UpdateReasonCodeDto, expected?: number): Promise<ReasonCode> {
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    const category = current.category as ReasonCategoryApi;
    const data = this.toData(input, category, current);
    if (input.code !== undefined && input.code !== current.code) {
      if (current.isSystem)
        throw field422('code', 'system_code', 'system reason code cannot be changed');
      if (input.code === OTHER_CODE)
        throw field422('code', 'reserved_code', `${OTHER_CODE} is reserved by the system`);
      await lockKey(this.db.tx, 'reason_code.code');
      await this.assertCodeFree(category, input.code, current.id);
      data.code = input.code;
    }
    if (input.label !== undefined && input.label.toLowerCase() !== current.labelTh.toLowerCase())
      await this.assertUniqueLabel(category, input.label, current.id);
    if (input.externalId !== undefined) {
      if (input.externalId) await this.assertUniqueExternal(input.externalId, current.id);
      data.externalId = input.externalId;
    }
    if (isNoopUpdate(current, data as Record<string, unknown>)) return current;
    const r = await this.bumpVersion(current, data);
    const before = auditView(current);
    const after = auditView(r);
    await this.audit.changed('reason_code.updated', 'reason_code', r.id, before, after);
    const changed = Object.keys(after).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    // งานที่บันทึกไปแล้วไม่เปลี่ยน (snapshot — MD-220)
    if (changed.length)
      await emitMasterEvent(
        this.db.tx,
        'reason_code.updated',
        'reason_code',
        r.id,
        toReasonCodeDto(r),
        { changedFields: changed },
      );
    return r;
  }

  /** PUT /reason-codes/external/{externalId} — idempotent (ส่งซ้ำ = อัปเดตแถวเดิม); หมวดต้องเท่าเดิม */
  async upsertExternal(externalId: string, input: UpsertReasonCodeDto, expected?: number) {
    const tx = this.db.tx;
    return upsertByExternalId(tx, 'reason_code', externalId, {
      find: () => tx.reasonCode.findFirst({ where: { externalId, deletedAt: null } }),
      create: () => this.create({ ...input, externalId }),
      update: (cur) => {
        if (cur.category !== input.category)
          throw field422('category', 'immutable', 'category cannot be changed after create');
        const { code: _code, category: _cat, ...rest } = input;
        return this.update(cur.id, rest, expected);
      },
    });
  }

  private systemConflict(action: string) {
    return new ProblemException('conflict', `system reason code cannot be ${action}`, [
      { field: 'id', code: 'system_reason', message: `system reason code cannot be ${action}` },
    ]);
  }

  async changeStatus(id: string, event: RcEvent, reason?: string, expected?: number) {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    // รหัสระบบถูกใช้โดย state machine/งานอัตโนมัติ (เช่น ON_HOLD + CUSTOMER_UNMAPPED) — ปิดใช้แล้วงานอัตโนมัติจะติด
    if (event === 'deactivate' && current.isSystem) throw this.systemConflict('deactivated');
    let updated!: ReasonCode;
    await this.state.transition(tx, {
      docType: 'reason_code',
      docId: id,
      table: REASON_CODE_TRANSITIONS,
      from: current.status,
      event,
      note: reason ?? null,
      eventType: event === 'deactivate' ? 'reason_code.deactivated' : 'reason_code.reactivated',
      apply: async (to) => {
        updated = await this.bumpVersion(current, { status: to });
        await this.audit.changed(
          event === 'deactivate' ? 'reason_code.deactivated' : 'reason_code.reactivated',
          'reason_code',
          id,
          auditView(current),
          auditView(updated),
          reason,
        );
        return toReasonCodeDto(updated) as unknown as Record<string, unknown>;
      },
    });
    return updated;
  }

  /** MD-004: ลบได้เฉพาะที่ไม่เคยถูกอ้างอิง → soft delete; ถูกอ้างอิง → 409 `in_use` · รหัสระบบ → 409 `conflict` */
  async remove(id: string, reason: string, expected?: number): Promise<void> {
    const tx = this.db.tx;
    const current = await this.get(id);
    if (expected !== undefined && expected !== current.version)
      throw new ProblemException('precondition_failed');
    if (current.isSystem) throw this.systemConflict('deleted');
    await lockForRemoval(tx, 'reason_code', id);
    await assertNotReferenced([
      {
        name: 'salesOrders',
        count: () => tx.salesOrder.count({ where: { holdReasonCodeId: id } }),
      },
      { name: 'tripStops', count: () => tx.tripStop.count({ where: { failReasonCodeId: id } }) },
      {
        name: 'deliveryOrderLines',
        count: () => tx.deliveryOrderLine.count({ where: { rejectReasonCodeId: id } }),
      },
      { name: 'stopEvents', count: () => tx.stopEvent.count({ where: { reasonCodeId: id } }) },
      {
        name: 'statusHistory',
        count: () => tx.docStatusHistory.count({ where: { reasonCodeId: id } }),
      },
    ]);
    await this.bumpVersion(current, {
      deletedAt: new Date(),
      externalId: null,
      deletedExternalId: current.externalId,
    });
    await this.audit.record({
      action: 'reason_code.deleted',
      entityType: 'reason_code',
      entityId: id,
      before: auditView(current),
      reason,
    });
    await emitMasterEvent(tx, 'reason_code.deleted', 'reason_code', id, toReasonCodeDto(current));
  }

  /** optimistic lock: update เฉพาะเมื่อ version ยังเท่าเดิม ไม่งั้น 412 */
  private async bumpVersion(
    current: ReasonCode,
    data: Prisma.ReasonCodeUncheckedUpdateInput,
  ): Promise<ReasonCode> {
    const tx = this.db.tx;
    const r = await tx.reasonCode.updateMany({
      where: { id: current.id, version: current.version, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new ProblemException('precondition_failed');
    return (await tx.reasonCode.findUnique({ where: { id: current.id } }))!;
  }
}
