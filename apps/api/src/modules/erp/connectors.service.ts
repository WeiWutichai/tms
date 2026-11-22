import { NotificationEvents } from '../notifications/notification-events';
import { Injectable, Logger } from '@nestjs/common';
import { type Connector, type IntegrationOutbox, Prisma } from '@prisma/client';
import {
  canConnectorTransition,
  type ConnectorStatus,
  documentSyncModes,
  ERP_CAPABILITIES,
  ERP_MASTER_CODE_KINDS,
  fieldSyncErrors,
  normalizeFieldSync,
  type SorOwner,
  SOR_TAX_PUSH_CAPABILITIES,
  type SystemOfRecord,
  unsupportedCapabilities,
} from '@tms/domain';
import { randomUUID } from 'node:crypto';
import { isLocalEnv } from '../../auth/tokens';
import { Clock } from '../../common/clock';
import { FieldCipher } from '../../common/crypto';
import { encodeId, ID_PREFIX, type IdKind, tryDecodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { checkUrlShape } from '../webhooks/ssrf';
import type {
  ConnectorActionDto,
  ConnectorCommandDto,
  ConnectorCommandQuery,
  ConnectorCredentialsDto,
  ConnectorDto,
  ConnectorHealthDto,
  ConnectorListQuery,
  ConnectorReasonDto,
  CreateConnectorDto,
  EffectiveConnectorDto,
  EffectiveConnectorQuery,
  ErpAdapterDto,
  UpdateConnectorDto,
  UpdateSystemOfRecordDto,
} from './connector.dto';
import { sorOf, SystemOfRecordPolicy } from './system-of-record.policy';
import { ConnectorResolver } from './connector-resolver';
import {
  type ErpAdapter,
  type ErpContext,
  type HealthResult,
  isPendingCapability,
  readyCapabilities,
} from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import {
  checkMasterCodeRefs,
  MASTER_CODE_KIND_TH,
  type MasterCodeGap,
} from './erp-master-code.check';
import type { ErrorClass } from '../integration/outbox.types';
import { generateInboundToken, INBOUND_MAX_ATTEMPTS, INBOUND_PROCESS_JOB } from './inbound-token';

const HEALTH_TIMEOUT_MS = 15_000;

/**
 * ST8-T03 (spec/07 §1 ตารางสถานะ `active → error`: "auth ล้มเหลว / ปลายทางล่มต่อเนื่อง ≥ 30 นาที"):
 * - AUTH = credential ใช้ไม่ได้ → ERROR ทันที (docs/01 §6.3)
 * - TRANSIENT (ปลายทางไม่ตอบ/503/timeout) → จดเวลาเริ่มล้ม `health_failing_since` — ล้มต่อเนื่องครบ `HEALTH_ERROR_AFTER_MS` → ERROR
 *   (หยุดทั้งคิว — docs/01 A.5) · ผ่านเมื่อไร = ล้างค่า · worker ตรวจซ้ำทุก `HEALTH_RECHECK_EVERY_MS` (`recheckUnhealthy`)
 *   และคืน ERROR ที่เกิดจาก TRANSIENT เป็น ACTIVE เองเมื่อปลายทางกลับมา ("ระบบ" — spec/07 `error → active`)
 * - class อื่น (VALIDATION ค่าตั้งผิด, CAPABILITY adapter ไม่ได้ติดตั้ง) บันทึกผลอย่างเดียว ไม่เปลี่ยนสถานะ
 */
export const HEALTH_STOP_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
  'AUTH',
  'TRANSIENT',
]);
export const HEALTH_ERROR_AFTER_MS = 30 * 60_000;
export const HEALTH_RECHECK_EVERY_MS = 5 * 60_000;

/**
 * ST8-T03 ข้อความไทยของผลทดสอบการเชื่อมต่อ (`POST /connectors/{id}/health` ช่อง `message`) ตามรหัส — ข้อความดิบของปลายทางอยู่ใน `detail`
 * รหัสที่ไม่รู้จัก = ข้อความตาม ErrorClass
 */
const HEALTH_CODE_TH: Readonly<Record<string, string>> = {
  unreachable: 'ติดต่อระบบปลายทางไม่ได้ — ระบบจะลองใหม่และกลับมาเชื่อมต่อเองเมื่อปลายทางพร้อม',
  timeout: 'ระบบปลายทางไม่ตอบภายในเวลาที่กำหนด — ระบบจะลองใหม่',
  service_unavailable: 'ระบบปลายทางขัดข้องชั่วคราว (503) — ระบบจะลองใหม่',
  unauthorized: 'ระบบปลายทางไม่ยอมรับ key — ตรวจหรือเปลี่ยน key แล้วทดสอบอีกครั้ง',
  credentials_missing: 'ยังไม่ได้กรอก key ของระบบปลายทาง',
  credentials_unreadable: 'อ่าน key ที่บันทึกไว้ไม่ได้ — กรอก key ใหม่',
  config_missing: 'ค่าตั้งไม่ครบ — ตรวจ URL ของระบบปลายทาง',
  url_not_allowed: 'ไม่อนุญาตให้เชื่อมต่อปลายทางนี้ (ที่อยู่ภายใน/พอร์ตไม่อนุญาต)',
  adapter_unavailable: 'ระบบนี้ยังไม่พร้อมใช้งานในสภาพแวดล้อมนี้',
  health_error: 'ทดสอบการเชื่อมต่อไม่สำเร็จ — ระบบจะลองใหม่',
  // ST8-T04 รอบดึง SO หยุด connector (แหล่งข้อมูลผิดโครงสร้าง — แก้ต้นทางแล้วกดเปิดใช้)
  source_not_found:
    'ไม่พบแหล่งข้อมูล SO ที่ปลายทาง — ให้ปลายทางตรวจ view/endpoint แล้วเปิดใช้อีกครั้ง',
  source_columns_missing:
    'แหล่งข้อมูล SO ขาดคอลัมน์ที่จำเป็น — SO ที่ดึงได้ค้างรอแก้ต้นทาง แก้แล้วเปิดใช้อีกครั้ง',
};
const HEALTH_CLASS_TH: Readonly<Partial<Record<ErrorClass, string>>> = {
  AUTH: 'ระบบปลายทางไม่ยอมรับข้อมูลยืนยันตัวตน — ตรวจ key แล้วทดสอบอีกครั้ง',
  TRANSIENT: 'ระบบปลายทางขัดข้องชั่วคราว — ระบบจะลองใหม่',
  VALIDATION: 'ค่าตั้งการเชื่อมต่อไม่ถูกต้อง — ตรวจ URL และค่าตั้ง',
};
export function healthMessageTh(code: string, errorClass: ErrorClass): string {
  return HEALTH_CODE_TH[code] ?? HEALTH_CLASS_TH[errorClass] ?? 'ทดสอบการเชื่อมต่อไม่สำเร็จ';
}

/** ผลตรวจที่ควรเปลี่ยน connector ACTIVE เป็น ERROR ไหม (since = เวลาเริ่มล้ม TRANSIENT ต่อเนื่อง) */
export function healthShouldStop(r: HealthResult, since: Date | null, at: Date): boolean {
  if (r.ok) return false;
  if (r.errorClass === 'AUTH') return true;
  if (r.errorClass !== 'TRANSIENT' || !since) return false;
  return at.getTime() - since.getTime() >= HEALTH_ERROR_AFTER_MS;
}
const VALUE_MAX = 2048;

const field422 = (field: string, code: string, message: string) =>
  new ProblemException('validation_failed', undefined, [{ field, code, message }]);

/** capability ที่ส่งเอกสารเข้า ERP (เปิดเพิ่ม = ตรวจความพร้อมผังรหัส — ST8-T06) */
const PUSH_CAPABILITIES: ReadonlySet<string> = new Set([
  'pushInvoice',
  'pushCreditNote',
  'pushSettlement',
  'replaceDocument',
]);

/** ข้อความสั้นของรายการที่ยังไม่พร้อม */
function readinessText(gaps: MasterCodeGap[]): string {
  return gaps
    .slice(0, 5)
    .map((g) => {
      const k = MASTER_CODE_KIND_TH[g.kind] ?? 'รหัส';
      if (g.status === 'MISSING') return `ไม่ได้ระบุ${k}`;
      if (g.status === 'NO_CATALOGUE' && g.value === null) return `ยังไม่มีผังรหัส${k}`;
      return `${k} "${String(g.value).slice(0, 40)}" ไม่อยู่ในผังรหัส`;
    })
    .join(', ');
}

/** วันนี้ตามเวลาไทย (YYYY-MM-DD) */
const todayTh = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * ST7-T21 capability ที่ต้อง **เปิดเอง** (ไม่อยู่ในค่าเริ่มต้นของ connector ใหม่) และเปิดต้องมีเหตุผล:
 * `fetchPaymentStatus` — TMS จะสร้างรายการรับชำระ (เงิน) เองจากยอดที่ระบบบัญชีรายงาน [OPEN — PO/นักบัญชี spec/12 §3]
 */
export const OPT_IN_CAPABILITIES = ['fetchPaymentStatus'] as const;

/** แทนค่า credential ที่หลุดมาในข้อความ (ข้อความจาก adapter/ERP) ด้วย *** */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    // รูปที่มักหลุดใน error ของ HTTP client: ตัวจริง, URL-encoded, base64 (Basic auth), base64url
    const forms = new Set([
      s,
      encodeURIComponent(s),
      Buffer.from(s).toString('base64'),
      Buffer.from(s).toString('base64url'),
      Buffer.from(s).toString('base64').replace(/=+$/, ''),
    ]);
    for (const f of [...forms].sort((a, b) => b.length - a.length))
      if (f.length >= 4) out = out.split(f).join('***');
  }
  return out;
}

/** `delivery_order` → `deliveryOrder` — ชนิดเอกสารที่มี prefix สาธารณะ (docs/01 §5.1) แสดงเป็น id แบบ prefix */
function publicLocalId(entityType: string, localId: string): string {
  const kind = entityType.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  return kind in ID_PREFIX ? encodeId(kind as IdKind, localId) : localId;
}

/** ST7-T20 คำสั่งในคิว (sink `erp`) แบบย่อ — ไม่มี payload/result/ข้อความ error ดิบ (request/response log = ST7-T19) */
export function commandDto(r: IntegrationOutbox): ConnectorCommandDto {
  const err = (r.lastError ?? null) as { code?: unknown } | null;
  return {
    id: encodeId('outboxCommand', r.id),
    operation: r.operation,
    entityType: r.entityType,
    localId: publicLocalId(r.entityType, r.localId),
    status: r.status,
    attempt: r.attempt,
    errorClass: r.errorClass,
    errorCode: typeof err?.code === 'string' ? err.code.slice(0, 60) : null,
    createdAt: r.createdAt.toISOString(),
    doneAt: iso(r.doneAt),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** สิ่งที่ลง audit (ไม่มีค่า credential — มีแค่ชื่อช่องที่ตั้ง) */
function auditView(c: Connector) {
  return {
    adapterKey: c.adapterKey,
    companyId: c.companyId,
    erpCompanyCode: c.erpCompanyCode,
    branchMap: c.branchMap,
    capabilitiesEnabled: c.capabilitiesEnabled,
    settings: c.settings,
    credentialKeys: c.credentialKeys,
    syncFromDate: c.syncFromDate?.toISOString().slice(0, 10) ?? null,
    status: c.status,
    customerOwner: c.customerOwner,
    taxDocumentOwner: c.taxDocumentOwner,
    fieldSync: normalizeFieldSync(c.fieldSync),
  };
}

/** data.object ของ webhook `connector.health_changed` = ConnectorDto ไม่รวม `systemOfRecord` (ST7-T17) */
function healthSnapshot(d: ConnectorDto): Omit<ConnectorDto, 'systemOfRecord'> {
  const { systemOfRecord: _sor, ...rest } = d;
  return rest;
}

/** system-of-record แบบ DTO (+ ธงออกเลขใบกำกับภาษี) */
function sorDto(s: SystemOfRecord) {
  return {
    customerOwner: s.customerOwner,
    taxDocumentOwner: s.taxDocumentOwner,
    fieldSync: { ...s.fieldSync },
  };
}

interface AuditInput {
  action: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * Connector ต่อ tenant (ST7-T13; docs/01 §3.7, §6.1; docs/04 G3; spec/07 §1)
 * - สิทธิ์: อ่าน `settings:read` · จัดการ `settings:write` + ต้องเป็นผู้ใช้ (owner/admin — spec/07 §1.2) · ฟีเจอร์ `conn` + limit ของแพ็กเกจ
 * - 1 connector ที่ยังไม่ยกเลิกต่อขอบเขต (นิติบุคคล / ทุกนิติบุคคล) — routing ตามนิติบุคคลทำใน ConnectorResolver
 * - สร้างแล้วเป็น PAUSED (= configuring) · เปิดใช้ (resume) ได้เมื่อ healthCheck ผ่าน (INT-015)
 * - credential เข้ารหัส FieldCipher ไม่ส่งกลับ ไม่ลง audit/log (INT-003: ทุกการเปลี่ยน credential ลง audit แบบไม่มีค่า)
 * - ไม่มี hard delete: ยกเลิกการเชื่อม = DISCONNECTED + เหตุผล (INT-016)
 */
@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger('ConnectorsService');
  private cipherInstance?: FieldCipher;

  constructor(
    private readonly db: DbService,
    private readonly adapters: ErpAdapterRegistry,
    private readonly resolver: ConnectorResolver,
    private readonly entitlements: EntitlementService,
    private readonly prisma: PrismaService,
    private readonly events: NotificationEvents,
    private readonly clock: Clock,
    private readonly sor: SystemOfRecordPolicy,
  ) {}

  get cipher(): FieldCipher {
    return (this.cipherInstance ??= new FieldCipher());
  }

  assertHuman(): void {
    const pt = requestContext.require().principalType;
    // ST7-T20: ทีม Innovera จาก Platform Console (route `/platform/...` เท่านั้น — actor `platform:<id>` ลง audit ของ tenant)
    if (pt !== 'user' && pt !== 'dev' && pt !== 'platform')
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'connectors',
        action: 'manage',
        required: ['settings:write'],
      });
  }

  // ---------- read ----------

  adapterCatalog(): ErpAdapterDto[] {
    return this.adapters.list().map((a) => ({
      key: a.key,
      displayName: a.displayName,
      demo: !!a.localOnly,
      capabilities: ERP_CAPABILITIES.filter((c) => a.capabilities().has(c)),
      capabilitiesPending: ERP_CAPABILITIES.filter((c) => isPendingCapability(a, c)),
      masterCodeKinds: a.fetchMasterCodes
        ? ERP_MASTER_CODE_KINDS.filter((k) => (a.masterCodeKinds ?? []).includes(k))
        : [],
      fixedTaxDocumentOwner: a.fixedSystemOfRecord?.taxDocumentOwner ?? null,
      configFields: a.configFields.map((f) => ({
        key: f.key,
        secret: f.secret,
        required: f.required,
        kind: f.kind,
        maxLength: f.maxLength ?? null,
        options: f.options ? [...f.options] : null,
      })),
    }));
  }

  toDto(c: Connector): ConnectorDto {
    const adapter = this.adapters.get(c.adapterKey);
    const ready = adapter ? readyCapabilities(adapter) : new Set<string>();
    const supported = ERP_CAPABILITIES.filter((x) => ready.has(x));
    const map = (c.branchMap ?? {}) as Record<string, string>;
    return {
      id: encodeId('connector', c.id),
      adapterKey: c.adapterKey,
      displayName: adapter?.displayName ?? null,
      companyId: c.companyId ? encodeId('company', c.companyId) : null,
      erpCompanyCode: c.erpCompanyCode,
      branchMap: Object.fromEntries(
        Object.entries(map).map(([k, v]) => [encodeId('branch', k), v]),
      ),
      status: c.status,
      statusReason: c.statusReason,
      statusChangedAt: iso(c.statusChangedAt),
      capabilitiesSupported: supported,
      capabilitiesPending: adapter
        ? ERP_CAPABILITIES.filter((x) => isPendingCapability(adapter, x))
        : [],
      capabilitiesEnabled: ERP_CAPABILITIES.filter((x) => c.capabilitiesEnabled.includes(x)),
      capabilities: this.resolver.describe(c).capabilities,
      settings: (c.settings ?? {}) as Record<string, string>,
      credentialKeys: [...c.credentialKeys].sort(),
      credentialsUpdatedAt: iso(c.credentialsUpdatedAt),
      syncFromDate: c.syncFromDate?.toISOString().slice(0, 10) ?? null,
      lastHealthAt: iso(c.lastHealthAt),
      lastHealthOk: c.lastHealthOk,
      lastHealthError: (c.lastHealthError as Record<string, unknown> | null) ?? null,
      activatedAt: iso(c.activatedAt),
      disconnectedAt: iso(c.disconnectedAt),
      inbound: {
        supported: !!adapter?.inbound,
        tokenPrefix: c.inboundTokenPrefix,
        tokenRotatedAt: iso(c.inboundTokenRotatedAt),
      },
      systemOfRecord: sorDto(sorOf(c)),
      version: c.version,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  async list(q: ConnectorListQuery): Promise<ConnectorDto[]> {
    const rows = await this.db.tx.connector.findMany({
      where: q.status
        ? { status: q.status as ConnectorStatus }
        : { status: { not: 'DISCONNECTED' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<Connector> {
    const c = await tx.connector.findUnique({ where: { id } });
    if (!c) throw new ProblemException('not_found');
    return c;
  }

  /**
   * ST7-T20 ชื่อทีมงาน Innovera ในประวัติ (actor `platform:<uuid>`) — role แอปอ่าน platform_user ไม่ได้ จึงอ่านด้วย role platform
   * เฉพาะชื่อที่แสดง (ไม่มีอีเมล/บทบาท) · หน้าเว็บแสดง "ทีม Innovera · {ชื่อ}"
   */
  async withPlatformNames<
    P extends { data: { actor: { id: string; name: string | null } | null }[] },
  >(page: P): Promise<P> {
    const ids = [
      ...new Set(
        page.data.flatMap((r) => {
          const m = r.actor ? /^platform:([0-9a-f-]{36})$/i.exec(r.actor.id) : null;
          return m ? [m[1]!] : [];
        }),
      ),
    ];
    if (!ids.length) return page;
    const staff = await this.prisma.platform.platformUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const name = new Map(staff.map((u) => [`platform:${u.id}`, u.name]));
    for (const r of page.data)
      if (r.actor && name.has(r.actor.id)) r.actor.name = name.get(r.actor.id)!;
    return page;
  }

  /** ST7-T20 คำสั่งล่าสุดของ connector (ใหม่สุดก่อน) — บันทึกการซิงก์ในหน้าตั้งค่า */
  async commands(id: string, q: ConnectorCommandQuery, tx: Tx = this.db.tx) {
    const c = await this.get(id, tx);
    const rows = await tx.integrationOutbox.findMany({
      where: {
        sink: 'erp',
        targetId: c.id,
        ...(q.status ? { status: q.status as IntegrationOutbox['status'] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
      take: q.limit ?? 50,
    });
    return rows.map(commandDto);
  }

  /** connector ที่เอกสารของนิติบุคคล/สาขาใช้ (routing ตามนิติบุคคล — ST1-T16) */
  async effective(q: EffectiveConnectorQuery): Promise<EffectiveConnectorDto> {
    const tx = this.db.tx;
    const tenantId = requestContext.require().tenantId!;
    const decode = (kind: 'company' | 'branch', field: string, v?: string) => {
      if (!v) return null;
      const id = tryDecodeId(kind, v);
      if (!id) throw field422(field, 'invalid_id', `must be a ${kind} id`);
      return id;
    };
    let companyId = decode('company', 'companyId', q.companyId);
    const branchId = decode('branch', 'branchId', q.branchId);
    // แพ็กเกจไม่มี connector → Standalone เสมอ (ไม่ 403 — หน้าจอทุกแพ็กเกจถามได้)
    // system-of-record (ST7-T17) = แบบ Standalone (TMS/TMS) — ใบแจ้งหนี้ไม่ไป ERP จึงไม่มีเหตุให้ TMS หยุดออกเลขใบกำกับภาษี
    //   (ค่าที่เก็บในแถว connector ไม่เปลี่ยน — กลับมาใช้เมื่อแพ็กเกจมี `conn` อีกครั้ง)
    if (!(await this.entitlements.enabled(tenantId, 'conn'))) {
      return {
        standalone: true,
        connectorId: null,
        adapterKey: this.adapters.standalone.key,
        displayName: null,
        adapterAvailable: true,
        status: null,
        capabilities: [],
        documentSync: documentSyncModes([]),
        sending: false,
        scope: 'none',
        erpCompanyCode: null,
        companyId: q.companyId ?? null,
        branchId: q.branchId ?? null,
        systemOfRecord: { ...sorDto(sorOf(null)), canIssueTaxDocumentNumber: true },
      };
    }
    // ระบุแค่สาขา → นิติบุคคลของสาขานั้น
    if (branchId && !companyId) {
      const b = await tx.branch.findUnique({
        where: { id: branchId },
        select: { companyId: true },
      });
      if (!b) throw field422('branchId', 'branch_unavailable', 'branch not found');
      companyId = b.companyId;
    }
    // ไม่ระบุนิติบุคคล/สาขา = ค่าเริ่มต้นระดับ tenant (connector "ทุกนิติบุคคล" หรือ Standalone)
    const r =
      !companyId && !branchId
        ? { ...(await this.resolver.forCompany(tx, null)), routing: null }
        : await this.resolver.forDocument(tx, tenantId, {
            kind: q.kind ?? 'invoice',
            companyId,
            branchId,
          });
    const sor = await this.sor.describe(r);
    return {
      standalone: r.standalone,
      connectorId: r.connector ? encodeId('connector', r.connector.id) : null,
      adapterKey: r.connector?.adapterKey ?? this.adapters.standalone.key,
      displayName: r.standalone ? null : (r.adapter?.displayName ?? null),
      adapterAvailable: !!r.adapter,
      status: r.status,
      capabilities: r.capabilities,
      documentSync: documentSyncModes(r.capabilities),
      sending: r.sending,
      scope: r.scope,
      erpCompanyCode: r.erpCompanyCode,
      companyId: r.routing ? encodeId('company', r.routing.company.id) : null,
      branchId: r.routing ? encodeId('branch', r.routing.branch.id) : null,
      systemOfRecord: { ...sorDto(sor), canIssueTaxDocumentNumber: sor.canIssueTaxDocumentNumber },
    };
  }

  // ---------- validate ----------

  private adapterOr422(key: string): ErpAdapter {
    const a = this.adapters.get(key);
    if (!a || a === this.adapters.standalone)
      throw field422('adapterKey', 'unknown_adapter', `adapter '${key}' is not available`);
    return a;
  }

  private checkValue(
    adapter: ErpAdapter,
    group: 'settings' | 'credentials',
    key: string,
    v: unknown,
  ): string {
    const f = adapter.configFields.find((x) => x.key === key);
    const path = `${group}.${key}`;
    if (!f || f.secret !== (group === 'credentials'))
      throw field422(path, 'unknown_field', `'${key}' is not a ${group} field of this adapter`);
    if (typeof v !== 'string') throw field422(path, 'invalid_type', 'must be a string');
    const s = f.secret ? v : v.trim();
    if (!s) throw field422(path, 'required', 'must not be empty');
    if (s.length > (f.maxLength ?? VALUE_MAX))
      throw field422(path, 'too_long', `at most ${f.maxLength ?? VALUE_MAX} characters`);
    if (f.kind === 'url') {
      let u: URL | null = null;
      try {
        u = new URL(s);
      } catch {
        /* ด้านล่าง */
      }
      const okProto = u?.protocol === 'https:' || (u?.protocol === 'http:' && isLocalEnv());
      if (!u || !okProto) throw field422(path, 'invalid_url', 'must be an https:// URL');
      // ST7-T14 กัน SSRF ตั้งแต่ตอนบันทึก (ตัวตรวจเดียวกับ webhook — ST7-T04): ห้าม user:pass ใน URL, host ภายใน/IP ส่วนตัว,
      // พอร์ต < 1024 ที่ไม่ใช่ 80/443 · HTTP client ของ adapter ต้อง resolve + ตรวจ IP อีกชั้นตอนเรียก (ST8-T03)
      const bad = checkUrlShape(s);
      if (bad) throw field422(path, bad.code, bad.message);
    }
    if (f.options && !f.options.includes(s))
      throw field422(path, 'invalid_option', `must be one of: ${f.options.join(', ')}`);
    return s;
  }

  private checkGroup(
    adapter: ErpAdapter,
    group: 'settings' | 'credentials',
    input: Record<string, unknown> | undefined,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input ?? {}))
      out[k] = this.checkValue(adapter, group, k, v);
    for (const f of adapter.configFields)
      if (f.required && f.secret === (group === 'credentials') && !(f.key in out))
        throw field422(`${group}.${f.key}`, 'required', 'required by this adapter');
    return out;
  }

  /**
   * `taxOwner` null (ยังไม่เลือกเจ้าของเอกสารภาษี — ST7-T17): ค่าเริ่มต้นไม่รวม capability ส่งเอกสารภาษี และขอเปิดใหม่ = 422 `sor_not_chosen`
   * (`already` = ที่เปิดอยู่แล้ว — แถวเดิมก่อน ST7-T17 ไม่ถูกบังคับปิด แต่คำสั่งถูกพักที่ sink)
   */
  private checkCapabilities(
    adapter: ErpAdapter,
    list: string[] | undefined,
    taxOwner: string | null = 'TMS',
    already: readonly string[] = [],
  ): string[] {
    // ST8-T03 ที่ยังไม่ได้ทำ (`pendingCapabilities`) ไม่นับว่ารองรับ — ไม่เปิดเป็นค่าเริ่มต้น และขอเปิด = 422
    const caps = readyCapabilities(adapter);
    const taxPush = SOR_TAX_PUSH_CAPABILITIES as readonly string[];
    // ST7-T21 capability แบบ opt-in (`fetchPaymentStatus` — สร้างรายการรับชำระเองจากข้อมูลระบบบัญชี) ไม่เปิดเป็นค่าเริ่มต้น
    if (list === undefined)
      return ERP_CAPABILITIES.filter(
        (c) =>
          caps.has(c) &&
          (taxOwner || !taxPush.includes(c)) &&
          !(OPT_IN_CAPABILITIES as readonly string[]).includes(c),
      );
    const blocked = taxOwner
      ? []
      : list.filter(
          (c) =>
            taxPush.includes(c) && (caps as ReadonlySet<string>).has(c) && !already.includes(c),
        );
    if (blocked.length)
      throw new ProblemException('sor_not_chosen', undefined, [
        {
          field: 'capabilitiesEnabled',
          code: 'sor_not_chosen',
          message: `choose taxDocumentOwner before enabling: ${[...new Set(blocked)].join(', ')}`,
        },
      ]);
    const bad = unsupportedCapabilities(caps, list);
    if (bad.length)
      throw field422(
        'capabilitiesEnabled',
        'capability_not_supported',
        `not supported by this adapter: ${bad.join(', ')}`,
      );
    return ERP_CAPABILITIES.filter((c) => list.includes(c));
  }

  /**
   * ST7-T21 เปิด capability แบบ opt-in "เพิ่ม" (ที่ยังไม่เปิดอยู่) ต้องมีเหตุผล ≥ 10 ตัวอักษร (ลง audit) — 422 `reason` required
   * (ผู้สั่ง = คนเท่านั้น: create/update เรียก `assertHuman` อยู่แล้ว) · คืนเหตุผลที่ตัดช่องว่างแล้ว หรือ null เมื่อไม่ได้เปิดเพิ่ม
   */
  private optInReason(
    caps: readonly string[],
    already: readonly string[],
    reason: string | null | undefined,
  ): string | null {
    const added = caps.filter(
      (c) => (OPT_IN_CAPABILITIES as readonly string[]).includes(c) && !already.includes(c),
    );
    if (!added.length) return null;
    const r = (reason ?? '').trim();
    if (r.length < 10)
      throw field422(
        'reason',
        'required',
        `enabling ${added.join(', ')} needs a reason of at least 10 characters (it lets TMS record payments reported by the accounting system)`,
      );
    return r.slice(0, 500);
  }

  private checkSyncFromDate(v: string | null | undefined): Date | null | undefined {
    if (v === undefined || v === null) return v;
    if (v > todayTh())
      throw field422('syncFromDate', 'future_date', 'must not be later than today (spec/07 §1)');
    return new Date(`${v}T00:00:00Z`);
  }

  private async checkCompany(tx: Tx, v: string | null | undefined): Promise<string | null> {
    if (!v) return null;
    const id = tryDecodeId('company', v);
    const c = id ? await tx.company.findUnique({ where: { id }, select: { status: true } }) : null;
    if (!c || c.status !== 'ACTIVE')
      throw field422('companyId', 'company_unavailable', 'legal entity not found or inactive');
    return id;
  }

  /** สาขา (brn_) → รหัส ERP · สาขาต้องเป็นของนิติบุคคลของ connector (ถ้าผูก) */
  private async checkBranchMap(
    tx: Tx,
    companyId: string | null,
    input: Record<string, unknown> | undefined,
  ): Promise<Record<string, string> | undefined> {
    if (input === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      const path = `branchMap.${k}`;
      const id = tryDecodeId('branch', k);
      if (!id) throw field422(path, 'invalid_id', 'key must be a branch id');
      if (typeof v !== 'string' || !v.trim() || v.trim().length > 64)
        throw field422(path, 'invalid_code', 'ERP code must be 1–64 characters');
      out[id] = v.trim();
    }
    const ids = Object.keys(out);
    if (ids.length) {
      const found = await tx.branch.findMany({
        where: { id: { in: ids }, ...(companyId ? { companyId } : {}) },
        select: { id: true },
      });
      const ok = new Set(found.map((b) => b.id));
      const miss = ids.find((i) => !ok.has(i));
      if (miss)
        throw field422(
          `branchMap.${encodeId('branch', miss)}`,
          'branch_unavailable',
          'branch not found for this legal entity',
        );
    }
    return out;
  }

  private version(c: Connector, expected?: number) {
    if (expected !== undefined && expected !== c.version)
      throw new ProblemException('precondition_failed');
  }

  private async audit(tx: Tx, e: AuditInput) {
    const ctx = requestContext.require();
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId!,
        actorId: ctx.actorId ?? null,
        actAs: ctx.actAs ?? null,
        action: e.action,
        entityType: 'connector',
        entityId: e.entityId,
        before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
        reason: e.reason ?? null,
        requestId: ctx.requestId,
        ip: ctx.ip ?? null,
      },
    });
  }

  private async assertLimit(tx: Tx, tenantId: string) {
    const limit = (await this.entitlements.resolve(tenantId)).conn?.limit ?? null;
    if (limit === null) return;
    const used = await tx.connector.count({ where: { status: { not: 'DISCONNECTED' } } });
    if (used >= limit)
      throw new ProblemException('connector_limit_reached', undefined, undefined, { limit });
  }

  private async assertScopeFree(tx: Tx, companyId: string | null) {
    const dup = await tx.connector.findFirst({
      where: { companyId, status: { not: 'DISCONNECTED' } },
      select: { id: true },
    });
    if (dup)
      throw new ProblemException('connector_scope_taken', undefined, undefined, {
        connectorId: encodeId('connector', dup.id),
      });
  }

  // ---------- write ----------

  /** `reason` = เหตุผลของทีม Innovera เมื่อเปิดจาก Platform Console (ST7-T20) — ผู้ใช้ของ tenant ไม่ต้องใส่ */
  async create(body: CreateConnectorDto, reason?: string): Promise<Connector> {
    this.assertHuman();
    const ctx = requestContext.require();
    const tx = this.db.tx;
    const tenantId = ctx.tenantId!;
    const adapter = this.adapterOr422(body.adapterKey);
    const companyId = await this.checkCompany(tx, body.companyId);
    const settings = this.checkGroup(adapter, 'settings', body.settings);
    const credentials = this.checkGroup(adapter, 'credentials', body.credentials);
    // ST8-T16 adapter ที่กำหนดเจ้าของเอกสารภาษีตายตัว (D-55) — ตั้งให้เอง ส่งค่าอื่นมา = 422 `sor_fixed`
    const fixedTax = adapter.fixedSystemOfRecord?.taxDocumentOwner ?? null;
    if (fixedTax && body.taxDocumentOwner !== undefined && body.taxDocumentOwner !== fixedTax)
      throw this.sorFixed(fixedTax);
    const taxDocumentOwner = (fixedTax ?? body.taxDocumentOwner ?? null) as SorOwner | null;
    const customerOwner = (body.customerOwner ?? null) as SorOwner | null;
    // ST7-T17 ตรวจ sor_not_chosen ก่อน — ประตูผังรหัส (ST8-T06) ตามมาด้านล่าง
    let caps = this.checkCapabilities(adapter, body.capabilitiesEnabled, taxDocumentOwner);
    // ผู้ใช้ของ tenant สร้างพร้อมเปิด capability แบบ opt-in ไม่ได้ (ไม่มีช่องเหตุผลตอนสร้าง) → เปิดภายหลังด้วย PATCH + เหตุผล
    const optInReason = this.optInReason(caps, [], reason);
    const syncFromDate = this.checkSyncFromDate(body.syncFromDate);
    const branchMap = (await this.checkBranchMap(tx, companyId, body.branchMap)) ?? {};
    // จำนวน/ขอบเขตต่อ tenant — serialize การสร้างพร้อมกัน (partial unique index กันซ้ำอีกชั้น)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(13, hashtext(${tenantId}))`;
    await this.assertScopeFree(tx, companyId);
    await this.assertLimit(tx, tenantId);
    const id = randomUUID();
    // ST8-T06 ส่งเอกสารต้องพร้อมผังรหัสก่อน (connector ใหม่ยังไม่มีผัง): ค่าเริ่มต้น = ไม่เปิด capability ส่งเอกสารที่ยังไม่พร้อม ·
    // ขอเปิดชัด ๆ = 422 เหมือน update (เปิดได้หลังนำเข้าผังรหัส)
    if (caps.some((c) => PUSH_CAPABILITIES.has(c))) {
      const gaps = await this.readinessGapsFor(tx, id, adapter.key, {
        ...settings,
        ...credentials,
      });
      if (gaps.length) {
        if (body.capabilitiesEnabled !== undefined)
          throw field422(
            'capabilitiesEnabled',
            'erp_master_codes_not_ready',
            `ผังรหัสยังไม่พร้อมสำหรับส่งเอกสาร: ${readinessText(gaps)}`,
          );
        caps = caps.filter((c) => !PUSH_CAPABILITIES.has(c));
      }
    }
    const credKeys = Object.keys(credentials).sort();
    let row: Connector;
    try {
      row = await tx.connector.create({
        data: {
          id,
          tenantId,
          adapterKey: adapter.key,
          companyId,
          erpCompanyCode: body.erpCompanyCode?.trim() || null,
          branchMap,
          capabilitiesEnabled: caps,
          settings,
          credentialsEnc: credKeys.length ? this.cipher.encrypt(JSON.stringify(credentials)) : null,
          credentialKeys: credKeys,
          credentialsUpdatedAt: credKeys.length ? new Date() : null,
          syncFromDate: syncFromDate ?? null,
          taxDocumentOwner,
          customerOwner,
          status: 'PAUSED',
          statusChangedAt: new Date(),
          createdBy: ctx.actorId ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
        throw new ProblemException('connector_scope_taken');
      throw e;
    }
    await this.audit(tx, {
      action: 'connector.created',
      entityId: id,
      after: auditView(row),
      reason: reason ?? optInReason ?? null,
    });
    return row;
  }

  /**
   * แก้ค่าตั้ง — ทำใน transaction ของตัวเอง (route เป็น @NoTransaction) เพื่อปลุกคำสั่งที่พักไว้หลัง commit
   * เมื่อเปิด capability เพิ่ม (คำสั่งที่พักเพราะ `capability_off` ส่งต่อทันที)
   */
  async update(id: string, body: UpdateConnectorDto, expected?: number): Promise<Connector> {
    this.assertHuman();
    const tenantId = requestContext.require().tenantId!;
    const { before, after } = await this.db.withTenant(tenantId, (tx) =>
      this.updateIn(tx, id, body, expected),
    );
    if (after.capabilitiesEnabled.some((c) => !before.capabilitiesEnabled.includes(c)))
      await this.wakeParked(tenantId, id);
    return after;
  }

  private async updateIn(
    tx: Tx,
    id: string,
    body: UpdateConnectorDto,
    expected?: number,
  ): Promise<{ before: Connector; after: Connector }> {
    const cur = await this.get(id, tx);
    this.version(cur, expected);
    if (cur.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    const adapter = this.adapterOr422(cur.adapterKey);
    const data: Prisma.ConnectorUpdateManyMutationInput = {};
    let optInReason: string | null = null;
    if (body.erpCompanyCode !== undefined)
      data.erpCompanyCode = body.erpCompanyCode?.trim() || null;
    if (body.settings !== undefined)
      data.settings = this.checkGroup(adapter, 'settings', body.settings);
    if (body.capabilitiesEnabled !== undefined) {
      // ST7-T17 sor_not_chosen ก่อน แล้วจึงตรวจผังรหัส (ST8-T06)
      const caps = this.checkCapabilities(
        adapter,
        body.capabilitiesEnabled,
        cur.taxDocumentOwner,
        cur.capabilitiesEnabled,
      );
      data.capabilitiesEnabled = caps;
      optInReason = this.optInReason(caps, cur.capabilitiesEnabled, body.reason);
      // ST8-T06 เปิดส่งเอกสาร "เพิ่ม" ต้องพร้อมผังรหัสก่อน (บันทึกค่าตั้งอื่น/ปิด capability ได้เสมอ)
      if (caps.some((c) => PUSH_CAPABILITIES.has(c) && !cur.capabilitiesEnabled.includes(c))) {
        const settings = (data.settings ?? cur.settings) as Prisma.JsonValue;
        const gaps = await this.pushReadinessGaps(tx, { ...cur, settings });
        if (gaps.length)
          throw field422(
            'capabilitiesEnabled',
            'erp_master_codes_not_ready',
            `ผังรหัสยังไม่พร้อมสำหรับส่งเอกสาร: ${readinessText(gaps)}`,
          );
      }
    }
    if (body.syncFromDate !== undefined)
      data.syncFromDate = this.checkSyncFromDate(body.syncFromDate);
    const bm = await this.checkBranchMap(tx, cur.companyId, body.branchMap);
    if (bm !== undefined) data.branchMap = bm;
    if (!Object.keys(data).length) return { before: cur, after: cur };
    const n = await tx.connector.updateMany({
      where: { id, version: cur.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    const after = await this.get(id, tx);
    await this.auditChanged(
      tx,
      'connector.updated',
      id,
      auditView(cur),
      auditView(after),
      optInReason,
    );
    return { before: cur, after };
  }

  private async auditChanged(
    tx: Tx,
    action: string,
    id: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    reason?: string | null,
  ) {
    const b: Record<string, unknown> = {};
    const a: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        b[k] = before[k];
        a[k] = after[k];
      }
    if (!Object.keys(a).length && !reason) return;
    await this.audit(tx, { action, entityId: id, before: b, after: a, reason });
  }

  /**
   * ST7-T17 เปลี่ยน system-of-record ของ connector (docs/04 G3) — เหตุผลบังคับ + audit `connector.sor_changed`
   * เจ้าของลูกค้า/เอกสารภาษีเปลี่ยนไม่ได้เมื่อมีคำสั่งส่งเอกสาร (PUSH_* / REPLACE_DOCUMENT) ที่ไม่ใช่ FAILED_FINAL/SKIPPED
   * (รวมที่รอส่ง/กำลังส่ง — แบบ spec/07 INT-014) → 409 `sor_locked` · ล็อกแถว connector (FOR UPDATE) กันแข่งกัน
   * เลือกเจ้าของเอกสารภาษีครั้งแรก → ปลุกคำสั่งที่พักไว้ (`sor_not_chosen`) หลัง commit
   */
  async setSystemOfRecord(
    id: string,
    body: UpdateSystemOfRecordDto,
    expected?: number,
  ): Promise<Connector> {
    this.assertHuman();
    const tenantId = requestContext.require().tenantId!;
    const { before, after } = await this.db.withTenant(tenantId, (tx) =>
      this.setSystemOfRecordIn(tx, id, body, expected),
    );
    if (!before.taxDocumentOwner && after.taxDocumentOwner) await this.wakeParked(tenantId, id);
    return after;
  }

  private async setSystemOfRecordIn(
    tx: Tx,
    id: string,
    body: UpdateSystemOfRecordDto,
    expected?: number,
  ): Promise<{ before: Connector; after: Connector }> {
    await tx.$queryRaw`SELECT id FROM connector WHERE id = ${id}::uuid FOR UPDATE`;
    const cur = await this.get(id, tx);
    this.version(cur, expected);
    if (cur.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    const data: Prisma.ConnectorUpdateManyMutationInput = {};
    if (body.fieldSync !== undefined) {
      const errs = fieldSyncErrors(body.fieldSync);
      if (errs.length) throw new ProblemException('validation_failed', undefined, errs);
      data.fieldSync = normalizeFieldSync({
        ...normalizeFieldSync(cur.fieldSync),
        ...body.fieldSync,
      });
    }
    // ST8-T16 เจ้าของเอกสารภาษีที่ adapter กำหนดตายตัว (D-55) เปลี่ยนไม่ได้
    const fixedTax = this.adapters.get(cur.adapterKey)?.fixedSystemOfRecord?.taxDocumentOwner;
    if (fixedTax && body.taxDocumentOwner !== undefined && body.taxDocumentOwner !== fixedTax)
      throw this.sorFixed(fixedTax);
    const owners: Array<['customerOwner' | 'taxDocumentOwner', string | undefined]> = [
      ['customerOwner', body.customerOwner],
      ['taxDocumentOwner', body.taxDocumentOwner],
    ];
    const ownerChanged = owners.filter(([k, v]) => v !== undefined && v !== cur[k]);
    if (ownerChanged.length) {
      // เลือกครั้งแรก (จาก null) ไม่ล็อก — ยังไม่มีเอกสารภาษีถูกส่ง (คำสั่งถูกพักไว้)
      const changing = ownerChanged.filter(([k]) => cur[k] !== null);
      const inUse = changing.length
        ? await tx.integrationOutbox.findFirst({
            where: {
              sink: 'erp',
              targetId: cur.id,
              status: { notIn: ['FAILED_FINAL', 'SKIPPED'] },
              OR: [{ operation: { startsWith: 'PUSH_' } }, { operation: 'REPLACE_DOCUMENT' }],
            },
            select: { id: true },
          })
        : null;
      if (inUse)
        throw new ProblemException('sor_locked', undefined, undefined, {
          fields: changing.map(([k]) => k),
        });
      for (const [k, v] of ownerChanged) data[k] = v as SorOwner;
    }
    const merged = { ...cur, ...data } as Connector;
    if (JSON.stringify(sorOf(merged)) === JSON.stringify(sorOf(cur)))
      return { before: cur, after: cur };
    const n = await tx.connector.updateMany({
      where: { id, version: cur.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    const after = await this.get(id, tx);
    await this.auditChanged(
      tx,
      'connector.sor_changed',
      id,
      auditView(cur),
      auditView(after),
      body.reason,
    );
    return { before: cur, after };
  }

  /**
   * เปลี่ยน credential (หมุน key) — audit บันทึกเฉพาะชื่อช่อง; ผล healthCheck เดิมใช้ไม่ได้แล้ว
   * ST8-T03: **รวมกับค่าเดิม** — ช่องที่ไม่ส่งมาคงค่าเดิม (เช่น หมุน `apiKey` ไม่ลบ `sqlPassword`) · ต้องส่งอย่างน้อย 1 ช่อง ·
   * ช่องบังคับต้องมีค่าหลังรวม · ถอดค่าเดิมไม่ได้ (เปลี่ยน key ring) = ใช้เฉพาะที่ส่งมา
   */
  async setCredentials(
    id: string,
    body: ConnectorCredentialsDto,
    expected?: number,
  ): Promise<Connector> {
    this.assertHuman();
    const tx = this.db.tx;
    const cur = await this.get(id);
    this.version(cur, expected);
    if (cur.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    const adapter = this.adapterOr422(cur.adapterKey);
    const given: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.credentials ?? {}))
      given[k] = this.checkValue(adapter, 'credentials', k, v);
    if (!Object.keys(given).length)
      throw field422('credentials', 'required', 'at least one credential field');
    const secretKeys = new Set(adapter.configFields.filter((f) => f.secret).map((f) => f.key));
    let prev: Record<string, string> = {};
    try {
      prev = cur.credentialsEnc
        ? (JSON.parse(this.cipher.decrypt(cur.credentialsEnc)) as Record<string, string>)
        : {};
    } catch {
      prev = {};
    }
    const credentials: Record<string, string> = {
      ...Object.fromEntries(Object.entries(prev).filter(([k]) => secretKeys.has(k))),
      ...given,
    };
    for (const f of adapter.configFields)
      if (f.required && f.secret && !credentials[f.key])
        throw field422(`credentials.${f.key}`, 'required', 'required by this adapter');
    const keys = Object.keys(credentials).sort();
    const n = await tx.connector.updateMany({
      where: { id, version: cur.version },
      data: {
        credentialsEnc: keys.length ? this.cipher.encrypt(JSON.stringify(credentials)) : null,
        credentialKeys: keys,
        credentialsUpdatedAt: new Date(),
        lastHealthOk: null,
        lastHealthError: Prisma.DbNull,
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    await this.audit(tx, {
      action: 'connector.credentials_changed',
      entityId: id,
      before: { credentialKeys: cur.credentialKeys },
      after: { credentialKeys: keys },
      reason: body.reason ?? null,
    });
    return this.get(id);
  }

  /**
   * ST7-T22 ออก/หมุน token ของ URL รับ webhook ขาเข้า — token เดิม (ถ้ามี) ใช้ไม่ได้ทันที · คืน token ตัวจริงครั้งเดียว
   * audit บันทึกเฉพาะ prefix (ไม่มีค่า token) · connector ที่ยกเลิกแล้ว → 409
   */
  async rotateInboundToken(
    id: string,
    body: ConnectorReasonDto,
    expected?: number,
  ): Promise<{ connector: Connector; token: string }> {
    this.assertHuman();
    const tx = this.db.tx;
    const cur = await this.get(id);
    this.version(cur, expected);
    if (cur.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    if (!this.adapters.get(cur.adapterKey)?.inbound)
      throw new ProblemException('inbound_not_supported');
    const t = generateInboundToken();
    const n = await tx.connector.updateMany({
      where: { id, version: cur.version },
      data: {
        inboundTokenHash: t.hash,
        inboundTokenPrefix: t.prefix,
        inboundTokenRotatedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    await this.audit(tx, {
      action: cur.inboundTokenHash
        ? 'connector.inbound_token_rotated'
        : 'connector.inbound_token_issued',
      entityId: id,
      before: { inboundTokenPrefix: cur.inboundTokenPrefix },
      after: { inboundTokenPrefix: t.prefix },
      reason: body.reason,
    });
    return { connector: await this.get(id), token: t.token };
  }

  /** ST7-T22 เลิกรับ webhook ขาเข้า (ลบ token — URL เดิมตอบ 401) · ไม่มี token อยู่แล้ว = ไม่เปลี่ยน */
  async revokeInboundToken(id: string, body: ConnectorReasonDto, expected?: number) {
    this.assertHuman();
    const tx = this.db.tx;
    const cur = await this.get(id);
    this.version(cur, expected);
    if (!cur.inboundTokenHash) return cur;
    const n = await tx.connector.updateMany({
      where: { id, version: cur.version },
      data: {
        inboundTokenHash: null,
        inboundTokenPrefix: null,
        inboundTokenRotatedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    await this.audit(tx, {
      action: 'connector.inbound_token_revoked',
      entityId: id,
      before: { inboundTokenPrefix: cur.inboundTokenPrefix },
      after: { inboundTokenPrefix: null },
      reason: body.reason,
    });
    return this.get(id);
  }

  private async transition(
    tx: Tx,
    cur: Connector,
    to: ConnectorStatus,
    action: string,
    reason: string | null,
    extra: Prisma.ConnectorUpdateManyMutationInput = {},
  ): Promise<Connector> {
    const now = new Date();
    const n = await tx.connector.updateMany({
      where: { id: cur.id, version: cur.version, status: cur.status },
      data: {
        status: to,
        statusReason: reason,
        statusChangedAt: now,
        ...extra,
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) throw new ProblemException('precondition_failed');
    await this.audit(tx, {
      action,
      entityId: cur.id,
      before: { status: cur.status },
      after: { status: to },
      reason,
    });
    const row = await this.get(cur.id, tx);
    const ctx = requestContext.require();
    await this.emitHealthChanged(tx, row, cur.status, ctx.requestId ?? null, ctx.actorId ?? null);
    return row;
  }

  /**
   * webhook `connector.health_changed` (docs/01 §5.3; ST7-T06) ทุกครั้งที่สถานะการเชื่อมต่อเปลี่ยน — ใน transaction เดียวกับการเปลี่ยน
   * payload = ConnectorDto (ไม่มีค่า credential — ข้อความ error ตัด credential แล้ว)
   */
  private async emitHealthChanged(
    tx: Tx,
    c: Connector,
    from: ConnectorStatus,
    requestId: string | null,
    actorId: string | null,
  ) {
    await tx.domainEvent.create({
      data: {
        tenantId: c.tenantId,
        type: 'connector.health_changed',
        entityType: 'connector',
        localId: c.id,
        // ST7-T06 (QA): data.object = ConnectorDto เดียวกับ `GET /v1/connectors/{id}` (credential แสดงแค่ชื่อช่อง)
        // ST7-T17 (QA): ไม่ใส่ `systemOfRecord` — event นี้เป็นเรื่องสุขภาพ ไม่ใช่ค่าตั้ง SoR (event contract สาธารณะเดิม)
        snapshot: JSON.parse(
          JSON.stringify(healthSnapshot(this.toDto(c))),
        ) as Prisma.InputJsonValue,
        previousAttributes: { status: from },
        requestId,
        actorId,
      },
    });
  }

  async pause(id: string, body: ConnectorActionDto, expected?: number): Promise<Connector> {
    this.assertHuman();
    const cur = await this.get(id);
    this.version(cur, expected);
    if (!canConnectorTransition('pause', cur.status))
      throw new ProblemException('invalid_state_transition');
    return this.transition(this.db.tx, cur, 'PAUSED', 'connector.paused', body.reason ?? null);
  }

  /** ยกเลิกการเชื่อม (INT-016): หยุดส่ง/ดึงทันที — คำสั่งที่ค้างถูกข้ามตอน worker หยิบ · mapping/log เก็บไว้ */
  async disconnect(id: string, body: ConnectorReasonDto, expected?: number): Promise<Connector> {
    this.assertHuman();
    const cur = await this.get(id);
    this.version(cur, expected);
    if (!canConnectorTransition('disconnect', cur.status))
      throw new ProblemException('invalid_state_transition');
    const tx = this.db.tx;
    // INT-016 หยุดส่ง/ดึงทันที — คำสั่งที่ค้างจะถูกข้ามตอน worker หยิบ (แต่ละใบลง `connector.command_skipped`)
    const pending = await this.openCommands(tx, cur.id);
    const row = await this.transition(
      tx,
      cur,
      'DISCONNECTED',
      'connector.disconnected',
      body.reason,
      // ST7-T22 เลิกรับ webhook ขาเข้าด้วย (URL เดิมตอบ 401)
      { disconnectedAt: new Date(), inboundTokenHash: null, inboundTokenPrefix: null },
    );
    if (pending)
      await this.audit(tx, {
        action: 'connector.commands_abandoned',
        entityId: cur.id,
        after: { pendingCommands: pending },
        reason: body.reason,
      });
    return row;
  }

  // ---------- หมุน key เข้ารหัส (ST7-T14 — ส่งต่อจาก ST7-T13) ----------

  /**
   * เข้ารหัส **credential ของ connector เท่านั้น** ใหม่ด้วย key ปัจจุบันของ FIELD_ENCRYPTION_KEYS (ตัวแรก) ทุก tenant — worker เรียกวันละครั้ง
   * ⚠ ข้อมูลอื่นที่เข้ารหัสด้วย FieldCipher (TOTP secret, เลขบัตรคนขับ, เลขบัญชี/เลขภาษีรถร่วม, secret ของ webhook,
   *   token LINE, PIN ของ POD ฯลฯ) **ยังไม่มีงานเข้ารหัสใหม่** — ห้ามเอา key เก่าออกจาก FIELD_ENCRYPTION_KEYS จนกว่าจะมีงาน
   *   เข้ารหัสใหม่ทั้งระบบ ([OPEN] ส่งต่อ ST9 / runbook ops — PROGRESS) · `remaining = 0` ที่นี่ไม่ได้แปลว่าเอา key เก่าออกได้
   * ขั้นตอน (เฉพาะส่วน connector): เพิ่ม key ใหม่ไว้หน้าสุด (`k2:…,k1:…`) → deploy → รอรอบนี้ (หรือรันเอง) จน `remaining = 0`
   * - เขียนแบบมีเงื่อนไข (ciphertext ยังเป็นค่าเดิม) — ผู้ใช้หมุน credential พร้อมกันไม่ถูกทับ
   * - ไม่เปลี่ยน `version`/ETag (ค่าที่ API แสดงไม่เปลี่ยน) และไม่ลง audit (ไม่ใช่การเปลี่ยน credential) — log จำนวนเท่านั้น
   * - ถอดไม่ได้ (key เก่าถูกเอาออกก่อนเวลา) = นับ `failed` + log id (ไม่ลบค่า — ใส่ key กลับแล้วรันใหม่ได้)
   */
  async reencryptCredentials(): Promise<{
    scanned: number;
    reencrypted: number;
    failed: number;
    remaining: number;
  }> {
    const rows = await this.prisma.platform.connector.findMany({
      where: { credentialsEnc: { not: null } },
      select: { id: true, credentialsEnc: true },
    });
    let reencrypted = 0;
    let failed = 0;
    let remaining = 0;
    for (const r of rows) {
      const enc = r.credentialsEnc!;
      if (!this.cipher.needsRotation(enc)) continue;
      let next: string;
      try {
        next = this.cipher.encrypt(this.cipher.decrypt(enc));
      } catch {
        failed += 1;
        remaining += 1;
        this.logger.warn(`connector ${r.id}: cannot decrypt credentials for key rotation`);
        continue;
      }
      const n = await this.prisma.platform.connector.updateMany({
        where: { id: r.id, credentialsEnc: enc },
        data: { credentialsEnc: next },
      });
      if (n.count === 1) reencrypted += 1;
      else if (await this.stillOld(r.id)) remaining += 1;
    }
    return { scanned: rows.length, reencrypted, failed, remaining };
  }

  private async stillOld(id: string): Promise<boolean> {
    const c = await this.prisma.platform.connector.findUnique({
      where: { id },
      select: { credentialsEnc: true },
    });
    return !!c?.credentialsEnc && this.cipher.needsRotation(c.credentialsEnc);
  }

  // ---------- health (นอก transaction ของ request — เรียกปลายทาง) ----------

  /** ค่าตั้งเต็ม (settings + credential ถอดแล้ว) — ใช้สร้าง ErpContext เท่านั้น ห้ามคืน/ลง log */
  configOf(c: Connector): Record<string, string> {
    const creds = c.credentialsEnc
      ? (JSON.parse(this.cipher.decrypt(c.credentialsEnc)) as Record<string, string>)
      : {};
    return { ...((c.settings ?? {}) as Record<string, string>), ...creds };
  }

  /**
   * บริบทของการเรียก adapter — `branchId` (สาขาของเอกสาร) ทำให้ `branch_map` มีผล: รหัส ERP = branch_map[สาขา] → erp_company_code
   * คำสั่งใน outbox (ST7-T15/T16) ต้องใส่ `branchId` ใน payload เพื่อให้ routing ระดับสาขาทำงาน
   */
  contextOf(
    c: Connector,
    extra: Partial<Pick<ErpContext, 'idempotencyKey' | 'signal' | 'erpCompanyCode'>> & {
      branchId?: string | null;
    } = {},
  ): ErpContext {
    const map = (c.branchMap ?? {}) as Record<string, unknown>;
    const byBranch =
      extra.branchId && typeof map[extra.branchId] === 'string'
        ? (map[extra.branchId] as string)
        : null;
    return {
      tenantId: c.tenantId,
      connectorId: c.id,
      companyId: c.companyId,
      erpCompanyCode: extra.erpCompanyCode ?? byBranch ?? c.erpCompanyCode,
      config: Object.freeze(this.configOf(c)),
      idempotencyKey: extra.idempotencyKey,
      signal: extra.signal,
      capabilitiesEnabled: Object.freeze([...(c.capabilitiesEnabled ?? [])]),
    };
  }

  /**
   * ST8-T06 ความพร้อมของผังรหัสก่อนส่งเอกสาร (`adapter.pushReadiness`) — ว่าง = พร้อม/adapter ไม่กำหนด
   * ใช้ตอนเปิด capability ส่งเอกสาร (422) และแสดงในผลทดสอบการเชื่อมต่อ (ไม่ทำให้ทดสอบล้ม/ไม่หยุดคิว)
   */
  async pushReadinessGaps(tx: Tx, c: Connector): Promise<MasterCodeGap[]> {
    let config: Record<string, string>;
    try {
      config = this.configOf(c);
    } catch {
      return [];
    }
    return this.readinessGapsFor(tx, c.id, c.adapterKey, config);
  }

  /** ความพร้อมจากค่าตั้งโดยตรง (ใช้ตอนสร้าง — ยังไม่มีแถว connector) */
  private async readinessGapsFor(
    tx: Tx,
    connectorId: string,
    adapterKey: string,
    config: Record<string, string>,
  ): Promise<MasterCodeGap[]> {
    const adapter = this.adapters.get(adapterKey);
    if (!adapter?.pushReadiness) return [];
    let need;
    try {
      need = adapter.pushReadiness({
        tenantId: requestContext.get()?.tenantId ?? '',
        connectorId,
        companyId: null,
        erpCompanyCode: null,
        config: Object.freeze({ ...config }),
      });
    } catch {
      return [];
    }
    return (await checkMasterCodeRefs(tx, connectorId, need?.refs ?? [], need?.catalogues ?? []))
      .gaps;
  }

  /** เรียก healthCheck แบบมีเพดานเวลา — ไม่ throw · ข้อความตัด credential แล้ว */
  async runHealth(c: Connector): Promise<HealthResult> {
    const adapter = this.adapters.get(c.adapterKey);
    if (!adapter)
      return {
        ok: false,
        errorClass: 'CAPABILITY',
        problem: {
          code: 'adapter_unavailable',
          message: `adapter '${c.adapterKey}' not installed`,
        },
      };
    let ctx: ErpContext;
    try {
      ctx = this.contextOf(c);
    } catch {
      return {
        ok: false,
        errorClass: 'AUTH',
        problem: { code: 'credentials_unreadable', message: 'cannot decrypt credentials' },
      };
    }
    const secrets = c.credentialKeys.map((k) => ctx.config[k] ?? '');
    let timer: NodeJS.Timeout | undefined;
    try {
      const r = await Promise.race([
        adapter.healthCheck(ctx),
        new Promise<HealthResult>((ok) => {
          timer = setTimeout(
            () =>
              ok({
                ok: false,
                errorClass: 'TRANSIENT',
                problem: { code: 'timeout', message: `no answer within ${HEALTH_TIMEOUT_MS} ms` },
              }),
            HEALTH_TIMEOUT_MS,
          );
        }),
      ]);
      if (r.ok) return { ok: true };
      return {
        ok: false,
        errorClass: r.errorClass,
        problem: {
          code: redactSecrets(String(r.problem?.code ?? 'health_failed'), secrets).slice(0, 60),
          message: redactSecrets(String(r.problem?.message ?? ''), secrets).slice(0, 500),
        },
      };
    } catch (e) {
      return {
        ok: false,
        errorClass: 'TRANSIENT',
        problem: {
          code: 'health_error',
          message: redactSecrets(String((e as Error)?.message ?? e), secrets).slice(0, 500),
        },
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `prevSince` = ค่าเดิมของ `health_failing_since` — TRANSIENT ต่อเนื่องคงเวลาเริ่มเดิม */
  private healthData(r: HealthResult, at: Date, prevSince: Date | null = null) {
    return {
      healthFailingSince: !r.ok && r.errorClass === 'TRANSIENT' ? (prevSince ?? at) : null,
      lastHealthAt: at,
      lastHealthOk: r.ok,
      lastHealthError: r.ok
        ? Prisma.DbNull
        : ({
            errorClass: r.errorClass,
            code: r.problem.code,
            message: r.problem.message,
          } as Prisma.InputJsonValue),
    };
  }

  /**
   * ทดสอบการเชื่อมต่อ (docs/01 §5.2 #14 `POST /connectors/{id}/health`)
   * ACTIVE + AUTH → ERROR ทันที · TRANSIENT → ERROR เมื่อล้มต่อเนื่อง ≥ 30 นาที (`healthShouldStop` — spec/07 §1; ST8-T03) ·
   * ERROR + ผ่าน → ACTIVE (ส่งคิวค้างต่อ)
   */
  async health(id: string): Promise<ConnectorHealthDto> {
    this.assertHuman();
    const tenantId = requestContext.require().tenantId!;
    const cur = await this.db.withTenant(tenantId, (tx) => this.get(id, tx));
    if (cur.status === 'DISCONNECTED') throw new ProblemException('invalid_state_transition');
    const r = await this.runHealth(cur);
    const at = this.clock.now();
    const row = await this.db.withTenant(tenantId, async (tx) => {
      const now = await this.get(id, tx);
      const data = this.healthData(r, at, now.healthFailingSince);
      await tx.connector.update({ where: { id }, data });
      await this.audit(tx, {
        action: 'connector.health_checked',
        entityId: id,
        after: r.ok ? { ok: true } : { ok: false, errorClass: r.errorClass, code: r.problem.code },
      });
      if (now.status === 'ACTIVE' && !r.ok && healthShouldStop(r, data.healthFailingSince, at)) {
        const down = await this.transition(tx, now, 'ERROR', 'connector.error', r.problem.code);
        await this.notifyDown(tx, down, r.problem.code);
        return down;
      }
      if (now.status === 'ERROR' && r.ok)
        return this.transition(tx, now, 'ACTIVE', 'connector.recovered', null);
      return this.get(id, tx);
    });
    // ERROR → ACTIVE: ส่งคิวค้างต่อทันที (spec/07 §1.6) ไม่ต้องรอรอบพัก 15 นาที
    if (cur.status !== 'ACTIVE' && row.status === 'ACTIVE') await this.wakeParked(tenantId, id);
    return {
      ok: r.ok,
      errorClass: r.ok ? null : r.errorClass,
      code: r.ok ? null : r.problem.code,
      message: r.ok ? null : healthMessageTh(r.problem.code, r.errorClass),
      detail: r.ok ? null : r.problem.message || null,
      masterCodeGaps: await this.db.withTenant(tenantId, (tx) => this.pushReadinessGaps(tx, row)),
      checkedAt: at.toISOString(),
      connector: this.toDto(row),
    };
  }

  /** เปิดใช้ (PAUSED/ERROR → ACTIVE) — ต้องทดสอบผ่านก่อน (INT-015) · ล้ม → 409 connector_health_failed */
  async resume(id: string, body: ConnectorActionDto, expected?: number): Promise<Connector> {
    this.assertHuman();
    const tenantId = requestContext.require().tenantId!;
    const cur = await this.db.withTenant(tenantId, (tx) => this.get(id, tx));
    this.version(cur, expected);
    if (!canConnectorTransition('resume', cur.status))
      throw new ProblemException('invalid_state_transition');
    const r = await this.runHealth(cur);
    const at = this.clock.now();
    if (!r.ok) {
      await this.db.withTenant(tenantId, (tx) =>
        tx.connector.update({
          where: { id },
          data: this.healthData(r, at, cur.healthFailingSince),
        }),
      );
      throw new ProblemException('connector_health_failed', undefined, undefined, {
        errorClass: r.errorClass,
        healthCode: r.problem.code,
      });
    }
    const row = await this.db.withTenant(tenantId, (tx) =>
      this.transition(tx, cur, 'ACTIVE', 'connector.resumed', body.reason ?? null, {
        ...this.healthData(r, at),
        activatedAt: cur.activatedAt ?? at,
      }),
    );
    await this.wakeParked(tenantId, id); // คำสั่งที่พักระหว่าง PAUSED/ERROR ส่งต่อทันที
    return row;
  }

  /**
   * ระบบหยุด connector (docs/01 §6.3 AUTH: "หยุด connector ทั้งตัว status = ERROR"; ST8-T03 TRANSIENT ที่ healthCheck ยืนยันว่าปลายทางล่ม) — เรียกจาก ErpAdapterSink
   * ใน transaction ของ tenant · ไม่มีผู้ใช้ (actor null) · ไม่ทับสถานะที่ผู้ดูแลตั้ง (PAUSED/DISCONNECTED)
   */
  async markError(
    tx: Tx,
    c: Connector,
    problem: { code: string; message: string },
    errorClass: ErrorClass = 'AUTH',
  ) {
    const n = await tx.connector.updateMany({
      where: { id: c.id, status: 'ACTIVE' },
      data: {
        status: 'ERROR',
        statusReason: problem.code.slice(0, 60),
        statusChangedAt: this.clock.now(),
        lastHealthOk: false,
        lastHealthAt: this.clock.now(),
        lastHealthError: { errorClass, ...problem } as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) return;
    const row = await tx.connector.findUniqueOrThrow({ where: { id: c.id } });
    await this.emitHealthChanged(tx, row, 'ACTIVE', null, null);
    await tx.auditLog.create({
      data: {
        tenantId: c.tenantId,
        action: 'connector.error',
        entityType: 'connector',
        entityId: c.id,
        before: { status: 'ACTIVE' },
        after: { status: 'ERROR', errorClass, code: problem.code },
        reason: problem.code.slice(0, 60),
      },
    });
    await this.notifyDown(tx, row, problem.code);
    this.logger.warn(`connector ${c.id} (${c.adapterKey}) → ERROR: ${problem.code}`);
  }

  /**
   * ST8-T03 บันทึกผล healthCheck ที่ระบบตรวจเอง (sink หลังส่งล้ม TRANSIENT / worker ตรวจซ้ำ) — ไม่มีผู้ใช้ (actor null)
   * AUTH → ERROR ทันที · TRANSIENT → จดเวลาเริ่มล้ม, ครบ 30 นาที → ERROR · ผ่าน → ล้างเวลา และ ERROR ที่เกิดจาก TRANSIENT → ACTIVE
   * คืน true เมื่อกลับเป็น ACTIVE (ผู้เรียกปลุกคิวหลัง commit ด้วย `wakeParked`) · ไม่ทับ PAUSED/DISCONNECTED
   */
  async applySystemHealth(
    tx: Tx,
    connectorId: string,
    r: HealthResult,
    at: Date,
  ): Promise<boolean> {
    const c = await tx.connector.findUnique({ where: { id: connectorId } });
    if (!c || (c.status !== 'ACTIVE' && c.status !== 'ERROR')) return false;
    const data = this.healthData(r, at, c.healthFailingSince);
    if (c.status === 'ACTIVE') {
      await tx.connector.update({ where: { id: c.id }, data });
      if (!r.ok && healthShouldStop(r, data.healthFailingSince, at))
        await this.markError(tx, c, r.problem, r.errorClass);
      return false;
    }
    // ERROR: กู้คืนเองเฉพาะที่หยุดเพราะปลายทางล่ม (TRANSIENT) — AUTH ต้องให้คนแก้ credential (เหตุผลเดิมคงไว้)
    const why = ((c.lastHealthError ?? {}) as { errorClass?: string }).errorClass;
    if (why !== 'TRANSIENT') return false;
    await tx.connector.update({ where: { id: c.id }, data });
    if (!r.ok) return false;
    const n = await tx.connector.updateMany({
      where: { id: c.id, status: 'ERROR' },
      data: {
        status: 'ACTIVE',
        statusReason: null,
        statusChangedAt: at,
        version: { increment: 1 },
      },
    });
    if (n.count !== 1) return false;
    const row = await tx.connector.findUniqueOrThrow({ where: { id: c.id } });
    await this.emitHealthChanged(tx, row, 'ERROR', null, null);
    await tx.auditLog.create({
      data: {
        tenantId: c.tenantId,
        action: 'connector.recovered',
        entityType: 'connector',
        entityId: c.id,
        before: { status: 'ERROR' },
        after: { status: 'ACTIVE', by: 'system' },
        reason: 'health_recovered',
      },
    });
    await this.events.connectorRecovered(tx, {
      tenantId: c.tenantId,
      connectorId: c.id,
      label: this.adapters.get(c.adapterKey)?.displayName ?? c.adapterKey,
    });
    this.logger.log(`connector ${c.id} (${c.adapterKey}) → ACTIVE (destination is back)`);
    return true;
  }

  /**
   * ST8-T03 worker (ทุก `HEALTH_RECHECK_EVERY_MS`): ตรวจซ้ำ connector ที่ ACTIVE แต่ล้ม TRANSIENT อยู่ (นับ 30 นาทีต่อ)
   * และ ERROR ที่เกิดจาก TRANSIENT (กู้คืนเองเมื่อปลายทางกลับมา) · อ่านข้าม tenant ด้วย role platform, เขียนใต้ RLS ของ tenant
   * คืนจำนวน connector ที่ตรวจ
   */
  async recheckUnhealthy(): Promise<number> {
    const rows = await this.prisma.platform.connector.findMany({
      where: {
        OR: [
          { status: 'ACTIVE', healthFailingSince: { not: null } },
          { status: 'ERROR', lastHealthError: { path: ['errorClass'], equals: 'TRANSIENT' } },
        ],
      },
      orderBy: { lastHealthAt: 'asc' },
      take: 200,
    });
    for (const c of rows) {
      try {
        const r = await this.runHealth(c);
        const at = this.clock.now();
        const back = await this.db.withTenant(c.tenantId, (tx) =>
          this.applySystemHealth(tx, c.id, r, at),
        );
        if (back) await this.wakeParked(c.tenantId, c.id);
      } catch (e) {
        this.logger.warn(
          `connector ${c.id} health recheck failed: ${String((e as Error)?.message ?? e)}`,
        );
      }
    }
    return rows.length;
  }

  /** ST9-T08 "connector ล่ม" (docs/04 I) — ใน transaction เดียวกับการเปลี่ยนเป็น ERROR */
  private async notifyDown(tx: Tx, c: Connector, code: string) {
    await this.events.connectorDown(tx, {
      tenantId: c.tenantId,
      connectorId: c.id,
      label: this.adapters.get(c.adapterKey)?.displayName ?? c.adapterKey,
      code: code.slice(0, 60),
    });
  }

  /** ST8-T16 422 `sor_fixed` — ระบบบัญชีนี้กำหนดเจ้าของเอกสารภาษีตายตัว (D-55) */
  private sorFixed(owner: string): ProblemException {
    return new ProblemException('sor_fixed', undefined, [
      {
        field: 'taxDocumentOwner',
        code: 'sor_fixed',
        message: `taxDocumentOwner is fixed to ${owner} for this adapter`,
      },
    ]);
  }

  /**
   * ปลุกคำสั่งที่พักไว้ของ connector นี้ (PENDING จาก PAUSED/ERROR/capability ปิด) ให้ worker หยิบทันที
   * เรียกหลัง commit ของ resume / ERROR → ACTIVE / เปิด capability — แก้ integration_outbox ได้เฉพาะ role platform
   */
  async wakeParked(tenantId: string, connectorId: string): Promise<number> {
    const n = await this.prisma.platform.$executeRaw`
      UPDATE integration_outbox SET next_run_at = now(), updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND sink = 'erp' AND target_id = ${connectorId}
         AND status = 'PENDING' AND next_run_at > now()`;
    // ST7-T22 webhook ขาเข้าที่รับไว้ระหว่าง PAUSED/ERROR (คง RECEIVED ไม่มี job ค้าง) → สร้าง job ประมวลผล
    const inbound = await this.prisma.platform.$executeRaw`
      INSERT INTO job (id, tenant_id, type, payload, max_attempts)
      SELECT gen_random_uuid(), e.tenant_id, ${INBOUND_PROCESS_JOB},
             jsonb_build_object('eventId', e.id::text), ${INBOUND_MAX_ATTEMPTS}::int
        FROM processed_webhook_event e
       WHERE e.tenant_id = ${tenantId}::uuid AND e.connector_id = ${connectorId}::uuid
         AND e.status = 'RECEIVED'
         AND NOT EXISTS (SELECT 1 FROM job j
                          WHERE j.tenant_id = e.tenant_id AND j.type = ${INBOUND_PROCESS_JOB}
                            AND j.status IN ('PENDING', 'RUNNING')
                            AND j.payload->>'eventId' = e.id::text)`;
    return n + inbound;
  }

  /** คำสั่งที่ยังไม่จบของ connector (ใช้นับตอนยกเลิกการเชื่อม — จะถูกข้าม) */
  private async openCommands(tx: Tx, connectorId: string): Promise<number> {
    return tx.integrationOutbox.count({
      where: {
        sink: 'erp',
        targetId: connectorId,
        status: { in: ['PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'] },
      },
    });
  }

  /**
   * คำสั่งถูกข้าม (SKIPPED) — docs/01 §6.3 CAPABILITY "SKIPPED + แจ้งบัญชี": ลง audit ของ connector ให้หน้าคิว (ST7-T19) แสดง/แจ้งบัญชี
   * ระบบเป็นผู้กระทำ (actor null)
   */
  async recordSkipped(
    tx: Tx,
    c: { id: string; tenantId: string },
    cmd: { id: string; operation: string; entityType: string; localId: string },
    code: string,
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: c.tenantId,
        action: 'connector.command_skipped',
        entityType: 'connector',
        entityId: c.id,
        after: {
          outboxId: cmd.id,
          operation: cmd.operation,
          entityType: cmd.entityType,
          localId: cmd.localId,
          code,
        },
        reason: code,
      },
    });
    this.logger.warn(
      `connector ${c.id}: ${cmd.operation} ${cmd.entityType}/${cmd.localId} skipped (${code})`,
    );
  }
}
