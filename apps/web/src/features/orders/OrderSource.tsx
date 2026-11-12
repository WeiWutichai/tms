import { Tag } from '@tms/ui';
import { useI18n, type T } from '../../i18n';

/**
 * ที่มาของใบสั่งขนส่ง (ST3-T01; docs/04 C "Source ของ order … แสดง badge บนทุกหน้า")
 * ค่าเดียวกับ API: `source` = MANUAL / IMPORT / API / PORTAL / CONNECTOR + `connector` (เช่น `krs` → ERP:krs)
 * หน้าตาตามต้นแบบ TMS v4:
 * - ชิป (`cC`) ในคอลัมน์ "ที่มา" ของตาราง/การ์ด: มือ · CSV · API · ชื่อ connector (srcL('ERP') = ชื่อระบบบัญชี เช่น KRS)
 * - ข้อความยาวในแถว "ที่มา" ของ drawer SO (`srcW`): สร้างเอง · นำเข้า CSV · API · ERP
 * ทุกหน้าที่แสดง order (รายการ SO, drawer, ใบค้าง ST3-T07, pool บนกระดาน ST3-T12, DO) ใช้ตัวนี้ตัวเดียว
 */
export type OrderSourceValue = 'MANUAL' | 'IMPORT' | 'API' | 'PORTAL' | 'CONNECTOR';

export interface OrderSourceProps {
  source: OrderSourceValue;
  /** รหัส connector (เฉพาะ CONNECTOR) */
  connector?: string | null;
  /** ชื่อแสดงของ connector จากหน้าการเชื่อมต่อ (ST7) — ไม่ส่ง = รหัสตัวใหญ่ */
  connectorName?: string | null;
  /** externalRef ของต้นทาง — แสดงใน tooltip */
  externalId?: string | null;
}

/** ข้อความสั้นบนชิป */
export function orderSourceLabel(t: T, p: OrderSourceProps): string {
  if (p.source === 'CONNECTOR')
    return p.connectorName || (p.connector ?? '').toUpperCase() || 'ERP';
  return t(`so.src.${p.source}`);
}

/** ข้อความยาวในรายละเอียด (drawer) */
export function orderSourceText(t: T, p: OrderSourceProps): string {
  return t(`so.srcLong.${p.source}`);
}

/** ชิปที่มา (ตาราง/การ์ด) */
export function OrderSourceBadge(p: OrderSourceProps) {
  const { t } = useI18n();
  const label = orderSourceLabel(t, p);
  return (
    <Tag
      title={p.externalId ? t('so.src.title', { src: label, ref: p.externalId }) : undefined}
      data-source={p.source}
    >
      {label}
    </Tag>
  );
}
