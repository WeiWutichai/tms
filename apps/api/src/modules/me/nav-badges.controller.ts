import { Controller, Get, Header, Injectable } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { scopeAllows } from '@tms/domain';
import { Clock } from '../../common/clock';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { BillingQueueService } from '../invoices/billing-queue.service';
import { overdueWhere } from '../invoices/invoices.service';
import { OrdersService } from '../orders/orders.service';
import { PlanningService } from '../planning/planning.service';
import { StopEventsService } from '../stops/stop-events.service';
import { bangkokToday } from '../vehicle-documents/expiry';
import { VehicleDocumentsService } from '../vehicle-documents/vehicle-documents.service';

/**
 * เมนูที่มี badge งานค้าง (ต้นแบบ TMS v4 `counts()` / `vNav()`; docs/03 §1/§4 "badge งานค้าง") — เฉพาะเมนูเฟส 0 ที่หน้าใช้งานได้แล้ว
 * และระบบมีข้อมูลตรงกับนิยามของต้นแบบ: เที่ยวรถ/ใบส่งของ/จ่ายงานรถร่วม (หน้ายังไม่เปิด) และลูกค้า (ยังไม่ผูก ERP — หน้าไม่มีตัวกรอง)
 * ยังไม่มี badge [DECISION spec/12 §3 D68-89]
 */
export const NAV_BADGE_KEYS = [
  'plan',
  'exc',
  'so',
  'bill',
  'pay',
  'settle',
  'erp',
  'fdoc',
  'rate',
] as const;
export type NavBadgeKey = (typeof NAV_BADGE_KEYS)[number];

/** สิทธิ์ (scope อย่างน้อย 1 ตัว) + ฟีเจอร์แพ็กเกจของแต่ละ badge — ชุดเดียวกับเมนูใน `apps/web/src/nav.ts` */
const ACCESS: Record<NavBadgeKey, { perm: string[]; feature?: string }> = {
  plan: { perm: ['trips:read'] },
  exc: { perm: ['trips:read'] },
  so: { perm: ['orders:read'] },
  bill: { perm: ['invoices:read'] },
  pay: { perm: ['invoices:read'] },
  settle: { perm: ['settlements:read'], feature: 'settle' },
  erp: { perm: ['integrations:read'], feature: 'conn' },
  fdoc: { perm: ['master:read'], feature: 'fleet' },
  rate: { perm: ['master:read'] },
};

export class NavBadgeDto {
  @ApiProperty({
    enum: NAV_BADGE_KEYS,
    description:
      'เมนู: plan กระดานวางแผน (SO รอจัด) · exc ศูนย์ข้อยกเว้น (ธงรอตัดสิน) · so ใบสั่งขนส่ง (ค้าง: รอกำหนดเส้นทาง + ยังไม่จับคู่ลูกค้า) · bill วางบิล (DO พร้อมวางบิล) · pay รับชำระ (ใบแจ้งหนี้เกินกำหนด) · settle Settlement รถร่วม (รอตรวจ + รออนุมัติ) · erp คิวเชื่อมระบบบัญชี (ST8-T12: เนื้อหาเอกสารไม่ตรงที่ยังเปิด — ไม่ตรง + รออนุมัติ + รอส่งซ้ำ; ส่วนคิวส่งไม่สำเร็จรอ PO #86) · fdoc เอกสารรถ (หมดอายุ/จะหมดใน 30 วัน) · rate Rate card (รออนุมัติ)',
  })
  key!: NavBadgeKey;
  @ApiProperty({ example: 3, description: 'จำนวนงานค้าง (0 = ไม่แสดง badge)' }) count!: number;
}

export class NavBadgesDto {
  @ApiProperty({
    type: [NavBadgeDto],
    description:
      'เฉพาะเมนูที่ผู้เรียกมีสิทธิ์ดูและแพ็กเกจเปิด — ไม่มีสิทธิ์ = ไม่มีในรายการ (ไม่คำนวณ)',
  })
  data!: NavBadgeDto[];
  @ApiProperty({ format: 'date-time' }) asOf!: string;
}

@Injectable()
export class NavBadgesService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly entitlements: EntitlementService,
    private readonly planning: PlanningService,
    private readonly flags: StopEventsService,
    private readonly orders: OrdersService,
    private readonly queue: BillingQueueService,
    private readonly docs: VehicleDocumentsService,
  ) {}

  private count(key: NavBadgeKey): Promise<number> {
    const tx = this.db.tx;
    switch (key) {
      case 'plan':
        return this.planning.poolOrderCount(tx);
      case 'exc':
        return this.flags.openFlagCount();
      case 'so':
        return this.orders.countHeldAny(['LOCATION_UNMAPPED', 'CUSTOMER_UNMAPPED']);
      case 'bill':
        return this.queue.count(tx);
      case 'pay':
        return tx.invoice.count({ where: overdueWhere(tx, bangkokToday(this.clock.now())) });
      case 'settle':
        // แท็บ "รอตรวจ" (DRAFT, DISPUTED) + "รออนุมัติ" (SENT_TO_CARRIER) ของหน้า settle
        return tx.carrierSettlement.count({
          where: { status: { in: ['DRAFT', 'DISPUTED', 'SENT_TO_CARRIER'] } },
        });
      case 'erp':
        // ST8-T12 รายการไม่ตรง (เนื้อหาเอกสาร) ที่ยังเปิด — ชุดเดียวกับแท็บ "ทั้งหมด" ที่ยังไม่ปิดของหน้า `erp`
        return tx.reconcileResult.count({
          where: {
            resolvedAt: null,
            acknowledgedAt: null,
            severity: { in: ['MONEY', 'FIELD'] },
            diff: { path: ['check'], equals: 'DOCUMENT' },
          },
        });
      case 'fdoc':
        return this.docs.dueCount(30);
      case 'rate':
        // สถานะ "รออนุมัติ" ของหน้า Rate card (ร่าง + ส่งขออนุมัติ) ทั้งขาขายและขาซื้อ
        return tx.rateCard.count({
          where: { deletedAt: null, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } },
        });
    }
  }

  /** นับทีละเมนูใน transaction ของ tenant (RLS) — เฉพาะเมนูที่ผู้เรียกเห็น */
  async badges(): Promise<NavBadgesDto> {
    const ctx = requestContext.require();
    const scopes = ctx.scopes ?? [];
    const ent = await this.entitlements.resolve(ctx.tenantId!);
    const keys = NAV_BADGE_KEYS.filter((k) => {
      const a = ACCESS[k];
      return (
        a.perm.some((p) => scopeAllows(scopes, p)) && (!a.feature || !!ent[a.feature]?.enabled)
      );
    });
    const data: NavBadgeDto[] = [];
    for (const key of keys) data.push({ key, count: await this.count(key) });
    return { data, asOf: this.clock.now().toISOString() };
  }
}

/**
 * Badge งานค้างบน sidebar (D-81 · D68-89; docs/03 §1 "มี Favorites + badge งานค้าง", §4) — ตัวนับเบา ๆ ชุดเดียวต่อคำขอ
 * แทนการเรียก summary ของทุกหน้า · UI เรียกทุก 60 วินาที (และเมื่อกลับมาที่หน้าต่าง)
 */
@ApiTags('platform')
@ApiBearerAuth()
@Controller('me')
export class NavBadgesController {
  constructor(private readonly svc: NavBadgesService) {}

  @Get('badges')
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({
    summary: 'ตัวนับงานค้างของเมนู (sidebar badge) — เฉพาะเมนูที่ผู้เรียกมีสิทธิ์',
    description:
      'นิยามตัวนับเดียวกับแท็บ/การ์ดของหน้านั้น (ดู `key`) · ไม่มีสิทธิ์อ่านของเมนูใด = ไม่มี key นั้น · ฟีเจอร์แพ็กเกจปิด = ไม่มี',
  })
  @ApiOkResponse({ type: NavBadgesDto })
  badges(): Promise<NavBadgesDto> {
    return this.svc.badges();
  }
}
