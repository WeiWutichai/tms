import {
  OPS_DO_DELIVERED,
  OPS_DO_FAILED,
  OPS_DO_TODAY,
  OPS_ORDER_WAITING,
  OPS_ORDER_WAITING_DAYS_AHEAD,
  OPS_TRIP_AWAITING_CARRIER,
  OPS_TRIP_RUNNING,
} from '@tms/domain/src/ops-dashboard';
import type { KpiTone } from '@tms/ui';
import { addDays } from '../rate-cards/rateFormat';
import type { MessageKey } from '../../i18n/th';

/**
 * ST9-T01 Dashboard ปฏิบัติการ — การ์ดแต่ละใบ = ตัวกรองของรายการต้นทาง (`/v1` ชุดเดียวกับลูกค้า)
 * ค่าสถานะมาจาก `packages/domain/src/ops-dashboard.ts` ชุดเดียวกับที่ API ใช้นับ (test API + E2E เทียบตัวเลขกับจำนวนแถว)
 * "วันนี้" = วันที่ server คืนใน summary (เวลาไทย: `delivery-orders/summary.date`, `orders/summary.today`) — ไม่ใช้นาฬิกาเครื่องผู้ใช้
 */
export type CardKey = 'today' | 'waiting' | 'running' | 'failed' | 'delivered' | 'offered';
export type ListKind = 'do' | 'so' | 'trip';

// ค่าเดียวกับที่ API ใช้นับ — import ซอร์สของ domain ตรง (ไฟล์ไม่มี import ตอนรัน)
const csv = (xs: readonly string[]) => xs.join(',');
export const DO_TODAY = csv(OPS_DO_TODAY);
export const DO_DELIVERED = csv(OPS_DO_DELIVERED);
export const DO_FAILED = csv(OPS_DO_FAILED);
export const SO_WAITING = csv(OPS_ORDER_WAITING);
export const TRIP_RUNNING = csv(OPS_TRIP_RUNNING);
export const TRIP_OFFERED = csv(OPS_TRIP_AWAITING_CARRIER);

export interface CardDef {
  key: CardKey;
  label: MessageKey;
  tone: KpiTone;
  /** scope ที่ต้องมี (ไม่มี = ไม่ render การ์ด — RPT-011) */
  perm: string;
  kind: ListKind;
}

/**
 * ลำดับการ์ด: 4 ใบแรกตามตำแหน่งต้นแบบ (งานวันนี้ · รอกำหนดเส้นทาง → รอจัดรถ · ระหว่างส่ง → กำลังวิ่ง ·
 * ใบแจ้งหนี้เกินกำหนด (ST5/ST9-T02) → ส่งไม่สำเร็จวันนี้) แล้วต่อด้วยการ์ดที่ docs/04 H กำหนดเพิ่ม
 */
export const CARDS: CardDef[] = [
  { key: 'today', label: 'dash.kpi.today', tone: 'neutral', perm: 'orders:read', kind: 'do' },
  { key: 'waiting', label: 'dash.kpi.waiting', tone: 'warn', perm: 'orders:read', kind: 'so' },
  { key: 'running', label: 'dash.kpi.running', tone: 'info', perm: 'trips:read', kind: 'trip' },
  { key: 'failed', label: 'dash.kpi.failed', tone: 'err', perm: 'orders:read', kind: 'do' },
  { key: 'delivered', label: 'dash.kpi.delivered', tone: 'ok', perm: 'orders:read', kind: 'do' },
  { key: 'offered', label: 'dash.kpi.offered', tone: 'warn', perm: 'trips:read', kind: 'trip' },
];

export const kindOf = (k: string): ListKind | undefined => CARDS.find((c) => c.key === k)?.kind;

export const isCardKey = (v: string | null): v is CardKey => CARDS.some((c) => c.key === v);

/**
 * ตัวกรองของรายการเมื่อคลิกการ์ด (query ของ `/v1/delivery-orders` · `/v1/orders` · `/v1/trips`)
 * `date` = วันนี้ของ server (DO: `delivery-orders/summary.date` · รอจัดรถ: `orders/summary.today`)
 */
export function cardQuery(key: CardKey, date: string): Record<string, string> {
  switch (key) {
    case 'today':
      return { dateFrom: date, dateTo: date, status: DO_TODAY };
    case 'delivered':
      return { dateFrom: date, dateTo: date, status: DO_DELIVERED };
    case 'failed':
      return { dateFrom: date, dateTo: date, status: DO_FAILED };
    case 'waiting':
      // spec/09 §1: ยังไม่อยู่ในเที่ยว และวันรับของ ≤ วันนี้ + 1
      return { status: SO_WAITING, requestedTo: addDays(date, OPS_ORDER_WAITING_DAYS_AHEAD) };
    case 'running':
      return { status: TRIP_RUNNING };
    case 'offered':
      return { status: TRIP_OFFERED };
  }
}

/** ลิงก์การ์ดรถบริษัท → หน้าทะเบียนรถพร้อมตัวกรองเดียวกับที่ API นับ (`vehicles/summary.fleet`) */
export const FLEET_LINKS = {
  available: '/fleet/vehicles?ownership=OWN&status=ready&busy=false',
  inUse: '/fleet/vehicles?ownership=OWN&busy=true',
  maintenance: '/fleet/vehicles?ownership=OWN&status=maintenance',
} as const;

/** ลิงก์จำนวนใบค้างต่อเหตุ → หน้าใบค้าง (ตัวกรองเดียวกับ `orders/summary.holdReasons` = `held=true&holdReason=`) */
export const holdLink = (code: string) => `/so/hold?reason=${encodeURIComponent(code)}`;
