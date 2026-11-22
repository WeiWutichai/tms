import { Injectable, type Type } from '@nestjs/common';
import type { IdKind } from '../../common/ids';
import type { ExportColumn, ExportPage } from '../master/export';

/**
 * แหล่งส่งออกของหน้ารายการ 1 หน้า (ST9-T10; docs/04 I "export ตาม filter; งานใหญ่ background + แจ้งเมื่อเสร็จ")
 * - `query` = class ตัวกรองของ `GET /v1/{resource}` ตัวเดียวกัน (ตรวจด้วย class-validator กติกาเดียวกับ query string)
 * - `fetch` = ฟังก์ชันอ่านของ service เดียวกับรายการ (where-builder เดียวกัน, RLS ของ tenant, DTO เดียวกัน) อ่านทีละหน้า
 * - `columns(scopes)` = คอลัมน์ไฟล์ — ตัดคอลัมน์ที่ผู้สั่งไม่มีสิทธิ์เห็น (ราคา/การเงิน) ตาม scope ของผู้สั่ง
 * - `scope` = สิทธิ์อ่านของรายการ (ต้องมีพร้อม `export:run`) — ไฟล์ไม่กว้างกว่าที่ผู้สั่งเห็นในหน้ารายการ
 */
export interface ExportSpec<Q extends object = any, R extends { id: string } = any> {
  /** ชื่อ resource ใน `POST /v1/exports` เช่น `orders`, `customers` */
  resource: string;
  /** ชื่อภาษาไทยที่ผู้ใช้เห็นในแจ้งเตือน เช่น "ใบสั่งขนส่ง (SO)" */
  label: string;
  /** ชื่อไฟล์ (ASCII) */
  fileBase: string;
  /**
   * ST7-T23 ชื่อไฟล์ตามตัวกรอง (ไม่รวมนามสกุล — ภาษาไทยได้: ดาวน์โหลดส่ง `filename*` UTF-8) เช่น "รายการขาย_ต.ค.2569"
   * ไม่มี = `{fileBase}-{วันเวลา}`
   */
  fileName?: (q: Q) => string;
  /** สิทธิ์อ่านรายการ (any-of) */
  scope: string | string[];
  /** ชนิด id ของ DTO — ใช้ถอด cursor ของหน้าถัดไป */
  idKind: IdKind;
  query: Type<Q>;
  fetch: (q: Q, page: ExportPage) => Promise<R[]>;
  columns: (scopes: readonly string[], q: Q) => ExportColumn<R>[];
}

@Injectable()
export class ExportRegistry {
  private readonly specs = new Map<string, ExportSpec>();

  register(spec: ExportSpec): void {
    if (this.specs.has(spec.resource))
      throw new Error(`export spec '${spec.resource}' already registered`);
    if (!/^[a-z][a-z0-9-]*$/.test(spec.resource))
      throw new Error(`bad export resource '${spec.resource}'`);
    this.specs.set(spec.resource, spec);
  }

  get(resource: string): ExportSpec | undefined {
    return this.specs.get(resource);
  }

  list(): ExportSpec[] {
    return [...this.specs.values()];
  }
}
