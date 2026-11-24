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
  /**
   * D-67: คำขอนี้มี `X-Step-Up` ที่ถูกต้องของผู้เรียกเอง (ยืนยัน 2FA ภายใน 5 นาที) — ตั้งโดย AuthGuard
   * ใช้กับ step-up แบบมีเงื่อนไข (`assertHumanStepUp` — เช่น แก้บัญชีธนาคาร, ส่งออกทั้งบริษัท)
   */
  steppedUp?: boolean;
  /** ผู้กระทำจริงเมื่อเข้าใช้งานแทน (ST1-T24) — ลง audit_log.act_as */
  actAs?: string;
  /** impersonation session (ST1-T24) */
  impersonationSessionId?: string;
  /** ทีม Innovera ที่ login Console (ST1-T24) */
  platformUser?: { id: string; role: string };
  /** magic link ที่ยืนยันแล้ว (route ที่ติด @LinkAction) — โมดูลใช้ entityId จำกัดข้อมูลที่ส่งกลับ */
  link?: { id: string; purpose: string; entityType: string; entityId: string; actions: string[] };
  /** ST7-T07: เวอร์ชันที่ pin ไว้บน API key ที่ใช้เรียก (null/ไม่มี = ตามวันสร้างบริษัท) */
  apiVersionPin?: string | null;
  /** ST7-T07: วันที่ pin ของคำขอนี้ (ตั้งโดย ApiVersionInterceptor) */
  apiVersion?: string;
  /**
   * ST7-T09: tenant ของคำขอนี้เป็น sandbox (`tenant.mode = 'test'`) — key `tk_test_` หรือผู้ใช้ที่สลับโหมด Sandbox
   * (header `X-Tms-Mode: test` บน route ที่ติด @SandboxAware) · `users` = หาผู้ใช้ของบริษัทจริง (ชื่อผู้สร้าง/ผู้ทำรายการ)
   */
  sandbox?: {
    liveTenantId: string;
    users: (where: {
      ids?: string[];
      name?: string;
    }) => Promise<{ id: string; name: string; status: string }[]>;
  };
  locale: 'th' | 'en';
  /** IP ผู้เรียก (trust proxy 1 ชั้น) — ลง audit log */
  ip?: string;
  tx?: Prisma.TransactionClient;
  /**
   * งานที่ต้องทำ**หลัง** transaction ของ request commit แล้วเท่านั้น (TransactionInterceptor เรียก; rollback = ไม่เรียก)
   * ใช้กับการเขียนผ่าน client platform ที่อยู่นอก transaction ของ request (เช่น เก็บกวาดหลังรีเซ็ต 2FA #81)
   * ล้มเหลว = log ไว้ ไม่ทำให้คำขอล้ม (ข้อมูลหลัก commit แล้ว) — ห้ามใช้กับงานที่ต้องสำเร็จเพื่อความถูกต้อง
   */
  afterCommit?: (() => Promise<void>)[];
  /** ขั้นตรวจของการนำเข้า (ST2-T23): ทุกการเขียนถูกย้อนทิ้ง — งานนอก transaction (audit แยก) ไม่ต้องทำ */
  importDryRun?: boolean;
  /**
   * D-67: ทำงานภายในงานนำเข้า (ตั้งโดย ImportService.inContext เท่านั้น) — step-up ตรวจครั้งเดียวที่
   * `POST /v1/imports/{id}/commit` จึงไม่ตรวจซ้ำใน service (`assertHumanStepUp`)
   */
  importRun?: boolean;
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
