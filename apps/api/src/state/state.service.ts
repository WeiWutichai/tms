import { Injectable } from '@nestjs/common';
import { transition, type TransitionTable } from '@tms/domain';
import { requestContext } from '../common/request-context';
import type { Tx } from '../db/db.service';

export interface TransitionInput<S extends string, E extends string> {
  docType: string; // เช่น 'company', 'sales_order', 'invoice'
  docId: string;
  table: TransitionTable<S, E>;
  from: S;
  event: E;
  reasonCodeId?: string | null;
  note?: string | null;
  /** event type สาธารณะ เช่น 'company.deactivated' */
  eventType: string;
  /** apply การเปลี่ยนสถานะจริง (update ที่ตรวจ version) คืน snapshot หลังเปลี่ยน */
  apply: (to: S) => Promise<Record<string, unknown>>;
  /** ค่าเดิม (ค่าเริ่ม `{status: from}`) — ฟังก์ชัน = คำนวณจาก snapshot หลังเปลี่ยน (เช่น diff กับ DTO ก่อนเปลี่ยน — ST7-T06) */
  previousAttributes?:
    Record<string, unknown> | ((snapshot: Record<string, unknown>) => Record<string, unknown>);
}

/** ผู้ฟัง event หลังเปลี่ยนสถานะ — รันใน transaction เดียวกัน (rollback = ไม่มีผล) */
export type TransitionListener = (
  tx: Tx,
  e: { tenantId: string; eventType: string; docType: string; docId: string; to: string },
) => Promise<void>;

/**
 * ตัวช่วย state machine (ST0-T10): ตรวจตาราง transition → เปลี่ยนสถานะ → เขียน doc_status_history
 * และ domain_event ใน transaction เดียวกัน (tx ของ request) — transition ผิด → InvalidTransitionError → 409
 */
@Injectable()
export class StateService {
  private readonly listeners = new Map<string, TransitionListener[]>();

  /** ST9-T08: ศูนย์แจ้งเตือนฟัง event (เช่น `order.held`) จากทุกทางที่เปลี่ยนสถานะ — ไม่ต้องแก้ทุกจุดที่เรียก */
  on(eventType: string, listener: TransitionListener): void {
    this.listeners.set(eventType, [...(this.listeners.get(eventType) ?? []), listener]);
  }

  async transition<S extends string, E extends string>(tx: Tx, input: TransitionInput<S, E>) {
    const to = transition(input.docType, input.table, input.from, input.event);
    const ctx = requestContext.get();
    const snapshot = await input.apply(to);
    await tx.docStatusHistory.create({
      data: {
        tenantId: ctx?.tenantId as string,
        docType: input.docType,
        docId: input.docId,
        fromStatus: input.from,
        toStatus: to,
        event: input.event,
        actorId: ctx?.actorId ?? null,
        reasonCodeId: input.reasonCodeId ?? null,
        note: input.note ?? null,
      },
    });
    await tx.domainEvent.create({
      data: {
        tenantId: ctx?.tenantId as string,
        type: input.eventType,
        entityType: input.docType,
        localId: input.docId,
        snapshot: snapshot as any,
        previousAttributes: (typeof input.previousAttributes === 'function'
          ? input.previousAttributes(snapshot)
          : (input.previousAttributes ?? { status: input.from })) as any,
        requestId: ctx?.requestId ?? null,
        actorId: ctx?.actorId ?? null,
      },
    });
    for (const l of this.listeners.get(input.eventType) ?? [])
      await l(tx, {
        tenantId: ctx?.tenantId as string,
        eventType: input.eventType,
        docType: input.docType,
        docId: input.docId,
        to,
      });
    return { to, snapshot };
  }

  /**
   * ST5-T12b `transition` ของเอกสารหลายใบที่ทำ event เดียวกันจากสถานะเดียวกัน (เช่น ออกใบแจ้งหนี้ 500 DO → `bill`) —
   * ผลต่อเอกสารเท่ากับเรียก `transition` ทีละใบ (ประวัติ 1 แถว + domain_event 1 แถวต่อเอกสาร ตามลำดับ `docIds` + ผู้ฟัง) แต่เขียนเป็นชุด
   * (คำสั่งคงที่ ไม่ขึ้นกับจำนวนเอกสาร) · `apply` เปลี่ยนสถานะทั้งชุดแล้วคืน snapshot หลังเปลี่ยนต่อเอกสาร (ขาดใบใด = error)
   */
  async transitionMany<S extends string, E extends string>(
    tx: Tx,
    input: Omit<TransitionInput<S, E>, 'docId' | 'apply' | 'previousAttributes'> & {
      docIds: string[];
      apply: (to: S) => Promise<Map<string, Record<string, unknown>>>;
    },
  ): Promise<{ to: S }> {
    const to = transition(input.docType, input.table, input.from, input.event);
    if (!input.docIds.length) return { to };
    const ctx = requestContext.get();
    const tenantId = ctx?.tenantId as string;
    const snapshots = await input.apply(to);
    for (const id of input.docIds)
      if (!snapshots.has(id))
        throw new Error(`transitionMany: no snapshot for ${input.docType} ${id}`);
    await tx.docStatusHistory.createMany({
      data: input.docIds.map((docId) => ({
        tenantId,
        docType: input.docType,
        docId,
        fromStatus: input.from,
        toStatus: to,
        event: input.event,
        actorId: ctx?.actorId ?? null,
        reasonCodeId: input.reasonCodeId ?? null,
        note: input.note ?? null,
      })),
    });
    await tx.domainEvent.createMany({
      data: input.docIds.map((docId) => ({
        tenantId,
        type: input.eventType,
        entityType: input.docType,
        localId: docId,
        snapshot: snapshots.get(docId) as any,
        previousAttributes: { status: input.from } as any,
        requestId: ctx?.requestId ?? null,
        actorId: ctx?.actorId ?? null,
      })),
    });
    const listeners = this.listeners.get(input.eventType) ?? [];
    for (const docId of input.docIds)
      for (const l of listeners)
        await l(tx, { tenantId, eventType: input.eventType, docType: input.docType, docId, to });
    return { to };
  }
}
