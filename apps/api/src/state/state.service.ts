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
  previousAttributes?: Record<string, unknown>;
}

/**
 * ตัวช่วย state machine (ST0-T10): ตรวจตาราง transition → เปลี่ยนสถานะ → เขียน doc_status_history
 * และ domain_event ใน transaction เดียวกัน (tx ของ request) — transition ผิด → InvalidTransitionError → 409
 */
@Injectable()
export class StateService {
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
        previousAttributes: (input.previousAttributes ?? { status: input.from }) as any,
        requestId: ctx?.requestId ?? null,
        actorId: ctx?.actorId ?? null,
      },
    });
    return { to, snapshot };
  }
}
