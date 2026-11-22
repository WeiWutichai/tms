import type { MessageKey } from '../../i18n/th';
import { TAB_STATUS } from '../settlements/settle';

/**
 * ST9-T03 Dashboard AP รถร่วม (docs/04 H "Dashboard AP รถร่วม" — **ย่อ D-54: ไม่มี "50 ทวิ ที่ยังไม่ออก"** 50 ทวิ ออกที่ระบบบัญชี)
 * 5 ช่อง: รอตรวจ / มีรายการโต้แย้ง (disputed) / รออนุมัติ / รอจ่าย / จ่ายแล้ว — ตัวเลขจาก `GET /settlements/summary` (ตัวนับเดียวกับแท็บหน้า settle)
 * คลิก = หน้า settle ที่แท็บเดียวกัน (RPT-005 — จำนวนแถว = ตัวเลขบนช่อง) [DECISION spec/12 §3 ST9-T03]:
 * - รอตรวจ = แท็บ "รอตรวจ" (DRAFT + DISPUTED — นิยามหน้า settle D-63) · มีรายการโต้แย้ง = DISPUTED (ส่วนหนึ่งของรอตรวจ → แท็บรอตรวจ + ตัวกรองสถานะ)
 * - รออนุมัติ = SENT_TO_CARRIER · รอจ่าย = APPROVED (แท็บ "อนุมัติแล้ว") · จ่ายแล้ว = PAID ทั้งหมด (แท็บ "จ่ายแล้ว")
 */
export type ApTileKey = 'chk' | 'disputed' | 'appr' | 'unpaid' | 'paid';

export interface ApTile {
  key: ApTileKey;
  label: MessageKey;
  /** สถานะที่นับ (คั่นด้วย , — รูปเดียวกับ `status` ของ `GET /settlements`) */
  statuses: string;
  /** หน้า settle + แท็บ/ตัวกรองที่คลิกลงไป (`?tab=&st=` อ่านโดย SettlePage) */
  link: string;
  /** สีตัวเลข (โทน KPI หน้า settle: รอตรวจ/รออนุมัติ = warn · อนุมัติแล้ว = info · จ่ายแล้ว = ok · โต้แย้ง = แดง) */
  color: string;
}

export const AP_TILES: ApTile[] = [
  {
    key: 'chk',
    label: 'dash.ap.chk',
    statuses: TAB_STATUS.chk,
    link: '/settle?tab=chk',
    color: '#8F5500',
  },
  {
    key: 'disputed',
    label: 'dash.ap.disputed',
    statuses: 'DISPUTED',
    link: '/settle?tab=chk&st=DISPUTED',
    color: '#B3322A',
  },
  {
    key: 'appr',
    label: 'dash.ap.appr',
    statuses: TAB_STATUS.appr,
    link: '/settle?tab=appr',
    color: '#8F5500',
  },
  {
    key: 'unpaid',
    label: 'dash.ap.unpaid',
    statuses: TAB_STATUS.ok,
    link: '/settle?tab=ok',
    color: '#2257C4',
  },
  {
    key: 'paid',
    label: 'dash.ap.paid',
    statuses: TAB_STATUS.paid,
    link: '/settle?tab=paid',
    color: '#17733F',
  },
];
