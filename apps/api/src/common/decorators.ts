import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension, ApiHeader } from '@nestjs/swagger';

export const IS_PUBLIC = 'tms:isPublic';
/** route ที่ไม่ต้องมี credential (health, openapi.json) */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const NO_TRANSACTION = 'tms:noTransaction';
/**
 * route ที่ไม่ต้องเปิด transaction ของ request (ไม่แตะฐานข้อมูล แต่เรียกระบบภายนอกที่อาจช้า เช่น geocode ST2-T03)
 * ห้ามใช้ `DbService.tx` ใน route นี้ — ยังผ่าน AuthGuard/ตรวจสิทธิ์ตามปกติ
 */
export const NoTransaction = () => SetMetadata(NO_TRANSACTION, true);

export const TENANT_RESOURCE = 'tms:tenantResource';
/**
 * ประกาศว่า route ที่มี `:id` นี้อ้าง resource ชนิดไหน — harness ทดสอบแยก tenant (ST0-T05)
 * ใช้ค่านี้หา fixture มาสร้างข้อมูลใน tenant A แล้วเรียกด้วย token ของ tenant B ต้องได้ 404
 * route ที่มี `:id` แต่ไม่ประกาศ → harness fail
 */
export const TenantResource = (kind: string) => SetMetadata(TENANT_RESOURCE, kind);

export const REQUIRED_SCOPE = 'tms:requiredScope';
/**
 * scope แบบ `resource:verb` (docs/01 §5.1) — ส่งหลายตัว = มีตัวใดตัวหนึ่งก็พอ
 * ST7-T11: ประกาศใน OpenAPI ด้วย (`x-required-scopes`) — ใช้สร้างตัวอย่าง 403 ที่ขาด (`describeProblemDefaults`)
 */
export const RequireScope = (...scopes: [string, ...string[]]) =>
  applyDecorators(SetMetadata(REQUIRED_SCOPE, scopes), ApiExtension('x-required-scopes', scopes));

export const REQUIRE_STEP_UP = 'tms:requireStepUp';
/** ต้องยืนยัน 2FA ซ้ำภายใน 5 นาที (header `X-Step-Up` จาก POST /v1/auth/step-up) — A3 "เปลี่ยน role ต้อง step-up" */
export const RequireStepUp = () =>
  applyDecorators(
    SetMetadata(REQUIRE_STEP_UP, true),
    ApiExtension('x-step-up', { mode: 'always' }),
  );
/**
 * D-67 (PO 22 พ.ย. 2569): step-up เฉพาะคน — ผู้ใช้ที่ login ต้องส่ง `X-Step-Up` (เหมือน RequireStepUp)
 * แต่ API key / OAuth client (`pt=client`) ทำ step-up ไม่ได้ → คุมด้วย scope ของ key ตามเดิม
 * ใช้กับ route ที่ key เข้าถึงได้อยู่แล้ว (เช่น `invoices:void`) — route ที่ key เข้าไม่ได้อยู่แล้วใช้ RequireStepUp()
 */
export const RequireHumanStepUp = () =>
  applyDecorators(
    SetMetadata(REQUIRE_STEP_UP, 'human'),
    ApiExtension('x-step-up', { mode: 'human' }),
  );
/**
 * D-67: step-up แบบมีเงื่อนไข (ตรวจใน service ด้วย `assertHumanStepUp()`) — decorator นี้แค่ประกาศใน OpenAPI
 * (`x-step-up` + header `X-Step-Up` + ตัวอย่าง 403 `step_up_required`) · `when` = เงื่อนไขที่ต้อง step-up (ไทย)
 */
/**
 * D-67: ประกาศ step-up ที่ตรวจใน handler (`assertStepUp` / `assertHumanStepUp`) ทุกครั้ง — validation (422) / 404 มาก่อน
 * `mode` 'human' = API key ไม่ต้อง (คุมด้วย scope)
 */
export const StepUpAlways = (mode: StepUpDocMode = 'always') => ApiExtension('x-step-up', { mode });
/**
 * D-67: step-up แบบมีเงื่อนไข — ดูด้านบน · `mode`:
 * - 'human' (ค่าเริ่ม) = API key ไม่ต้อง (คุมด้วย scope)
 * - 'user' (D-79) = API key ทำรายการนี้ไม่ได้ → 403 `bank_change_requires_user` (บัญชีธนาคารรถร่วม)
 * - 'platform' (D-77) = token จาก `POST /v1/platform/auth/step-up` (Platform Console)
 */
export const StepUpWhen = (when: string, mode: StepUpDocMode = 'human') =>
  ApiExtension('x-step-up', { mode, when });
export type StepUpDocMode = 'always' | 'human' | 'user' | 'platform';

export const ALLOW_BEFORE_2FA = 'tms:allowBefore2fa';
/**
 * D-78: route ที่ผู้ใช้ซึ่งต้องตั้ง 2FA แต่ยังไม่ตั้ง เรียกได้ (สถานะ 2FA ของตัวเอง) — route อื่นตอบ 403 `two_factor_enrolment_required`
 * (ขั้นตั้ง 2FA เอง `/auth/2fa/enroll*` เป็น @Public ใช้ mfaToken จาก login อยู่แล้ว)
 */
export const AllowBeforeTwoFactor = () => SetMetadata(ALLOW_BEFORE_2FA, true);

export const REQUIRED_FEATURE = 'tms:requiredFeature';
/** ต้องเปิดฟีเจอร์นี้ในแพ็กเกจ/override ของ tenant (ST1-T18) — ปิด → 403 `feature_not_in_plan` + `featureKey` (spec/01 PLT-078) */
export const RequireFeature = (feature: string) => SetMetadata(REQUIRED_FEATURE, feature);

export const LINK_ACTION = 'tms:linkAction';
/**
 * route ที่ยืนยันตัวตนด้วย magic link (ST1-T06) แทน token — path ต้องมี `:token`
 * ลิงก์หมดอายุ/ถูกเพิกถอน/ไม่มี action นี้ → 404 · principal = `link` (ไม่เห็นราคาขายเด็ดขาด)
 */
export const LinkAction = (action: string) => SetMetadata(LINK_ACTION, action);

export const PLATFORM_ROLES = 'tms:platformRoles';
/**
 * route ของ Platform Console (ST1-T24) — ต้องใช้ token ของทีม Innovera (login แยก + 2FA) ไม่ใช่ token ลูกค้า
 * ระบุ role ที่ทำได้ (docs/04 A6: SUPER_ADMIN / SUPPORT / BILLING) — ไม่ระบุ = ทุก role
 */
export const PlatformAuth = (...roles: ('SUPER_ADMIN' | 'SUPPORT' | 'BILLING')[]) =>
  SetMetadata(PLATFORM_ROLES, roles);

export const RATE_LIMIT_CLASS = 'tms:rateLimitClass';
/**
 * ST7-T08: คำขอหนัก (export, นำเข้า, สร้าง PDF, ส่งทดสอบ, ทำหลายรายการในคำขอเดียว) — นับ bucket "heavy" ต่อบริษัท
 * (5 req/s ใน profile standard) ซ้อนกับ tenant/key/user · route อื่นแบ่งเป็น read (GET/HEAD) / write โดยอัตโนมัติ
 */
export const RateLimitClass = (cls: 'heavy') => SetMetadata(RATE_LIMIT_CLASS, cls);

export const SANDBOX_AWARE = 'tms:sandboxAware';
/**
 * ST7-T09: route ของหน้า นักพัฒนา / Open API ที่ผู้ใช้ (UI) สลับเป็นโหมด Sandbox ได้ด้วย header `X-Tms-Mode: test`
 * → AuthGuard เปลี่ยน tenant ของคำขอเป็น sandbox ของบริษัท (สร้างเมื่อยังไม่มี) · API key ไม่ใช้ header นี้ (โหมดตาม key)
 */
export const SandboxAware = () =>
  applyDecorators(
    SetMetadata(SANDBOX_AWARE, true),
    ApiHeader({
      name: 'X-Tms-Mode',
      required: false,
      enum: ['live', 'test'],
      description:
        'เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key)',
    }),
  );
export const LIVE_ONLY = 'tms:liveOnly';
/**
 * ST7-T09: route ที่ห้ามใช้ใน sandbox (เชื่อมระบบภายนอกจริง เช่น connector/ERP) → 403 `sandbox_unsupported`
 * ตรวจใน AuthGuard หลังรู้ tenant ของคำขอ (ทั้ง key `tk_test_` และผู้ใช้ที่สลับโหมด)
 */
export const LiveOnly = () => SetMetadata(LIVE_ONLY, true);
export const TRANSACTION_TIMEOUT_MS = 'tms:transactionTimeoutMs';
/** transaction ของคำขอ (ค่าเริ่ม) — คำขอเกินนี้ย้อนทั้งหมด → 503 `service_busy` */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 15_000;
/**
 * ST5-T12b (review H1): transaction ของ route นี้ยาวกว่าค่าเริ่ม 15 วิ — ใช้เฉพาะงานที่ต้องเป็นหน่วยเดียว (atomic) และโตตามขนาดเอกสาร
 * (เช่น ยกเลิก/ถอด DO จากใบแจ้งหนี้ 1,000 DO ที่ต้องคิดบรรทัดรายได้ใหม่ต่อใบสั่ง) · ระบุเหตุผลที่จุดใช้ · ใช้คู่กับ `IdempotencyLockMs` ≥ ค่านี้
 */
export const TransactionTimeout = (ms: number) => SetMetadata(TRANSACTION_TIMEOUT_MS, ms);
export const IDEMPOTENCY_LOCK_MS = 'tms:idempotencyLockMs';
/**
 * ST7-T10: เวลาจอง Idempotency-Key ระหว่างทำ (ค่าเริ่ม 60 วิ) — route ที่ทำนาน (เช่น bulk 200 ใบ) ตั้งให้ยาวกว่าเวลาสูงสุดที่ยอม
 * คำขอซ้ำ key เดิมระหว่างนั้น = 409 `idempotency_in_progress` (ไม่ทำซ้อน)
 */
export const IdempotencyLockMs = (ms: number) => SetMetadata(IDEMPOTENCY_LOCK_MS, ms);
