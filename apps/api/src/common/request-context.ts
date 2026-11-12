import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

/** ข้อมูลต่อ request — ตั้งโดย middleware (requestId), guard (tenant/actor), transaction interceptor (tx) */
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  actorId?: string;
  scopes?: string[];
  /** ชนิด principal จาก token (`user` / `dev` / ภายหลัง `link` / `driver`) — ใช้กันราคาขายแบบเด็ดขาด (ST1-T13) */
  principalType?: string;
  /** ผู้กระทำจริงเมื่อเข้าใช้งานแทน (ST1-T24) — ลง audit_log.act_as */
  actAs?: string;
  /** impersonation session (ST1-T24) */
  impersonationSessionId?: string;
  /** ทีม Innovera ที่ login Console (ST1-T24) */
  platformUser?: { id: string; role: string };
  /** magic link ที่ยืนยันแล้ว (route ที่ติด @LinkAction) — โมดูลใช้ entityId จำกัดข้อมูลที่ส่งกลับ */
  link?: { id: string; purpose: string; entityType: string; entityId: string; actions: string[] };
  locale: 'th' | 'en';
  /** IP ผู้เรียก (trust proxy 1 ชั้น) — ลง audit log */
  ip?: string;
  tx?: Prisma.TransactionClient;
  /** ขั้นตรวจของการนำเข้า (ST2-T23): ทุกการเขียนถูกย้อนทิ้ง — งานนอก transaction (audit แยก) ไม่ต้องทำ */
  importDryRun?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  require(): RequestContext {
    const ctx = storage.getStore();
    if (!ctx) throw new Error('request context missing');
    return ctx;
  },
};
