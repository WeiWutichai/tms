import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { requestContext } from '../common/request-context';
import { DbService } from '../db/db.service';

/** field ที่ห้ามลง audit (spec/01 PLT-127): รหัสผ่าน, secret, token */
const SECRET = /password|secret|token|hash/i;

function clean(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  return JSON.parse(
    JSON.stringify(v, (k, x) =>
      k && SECRET.test(k) ? undefined : typeof x === 'bigint' ? String(x) : x,
    ),
  ) as Prisma.InputJsonValue;
}

/** เก็บเฉพาะ field ที่เปลี่ยน (before/after คู่กัน) — create = after ทั้งก้อน, delete = before ทั้งก้อน */
export function diff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'updatedAt' || k === 'version') continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}

export interface AuditEntry {
  /** เช่น `company.created`, `branch.updated`, `document_sequence.updated` */
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /** เหตุผล — บังคับสำหรับยกเลิก/override/อนุมัติ (CLAUDE.md) */
  reason?: string;
}

/**
 * Audit log (ST1-T22; docs/04 A7) — เขียนใน transaction เดียวกับการเปลี่ยนข้อมูล (rollback แล้ว audit หายด้วย)
 * append-only: tms_app ไม่มีสิทธิ์ UPDATE/DELETE + trigger ปฏิเสธทุก role (migration 0008)
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async record(e: AuditEntry): Promise<void> {
    const ctx = requestContext.require();
    await this.db.tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId!,
        actorId: ctx.actorId ?? null,
        actAs: ctx.actAs ?? null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        before: clean(e.before),
        after: clean(e.after),
        reason: e.reason ?? null,
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
  }

  /** บันทึกการแก้ไข: เก็บเฉพาะ field ที่เปลี่ยน; ไม่มีอะไรเปลี่ยน = ไม่บันทึก */
  async changed(
    action: string,
    entityType: string,
    entityId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    reason?: string,
  ): Promise<void> {
    const d = diff(before, after);
    if (Object.keys(d.after).length === 0 && !reason) return;
    await this.record({ action, entityType, entityId, before: d.before, after: d.after, reason });
  }
}
