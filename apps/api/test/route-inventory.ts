import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  IS_PUBLIC,
  LINK_ACTION,
  PLATFORM_ROLES,
  REQUIRED_SCOPE,
  TENANT_RESOURCE,
} from '../src/common/decorators';
import { LINK_ACTIONS as DOCS_LINK_ACTIONS } from '../src/modules/carrier-docs/carrier-docs.service';
import type { LinkPurpose } from '../src/modules/links/magic-link.service';
import { REVIEW_LINK_ACTIONS } from '../src/modules/settlements/settlement-review.service';
import { TRACKING_ACTION } from '../src/modules/tracking/tracking.service';
import { SHEET_LINK_ACTION } from '../src/modules/trip-sheets/trip-sheets.service';
import { OFFER_LINK_ACTIONS, POD_LINK_ACTIONS } from '../src/modules/trips/offer-links';
import { PAY_LINK_ACTIONS } from '../src/modules/settlements/carrier-pay-link.service';

/** route หนึ่งของแอป (อ่านจาก metadata ของ Nest — ชุดเดียวกับที่ express ลงทะเบียน) */
export interface RouteInfo {
  method: string;
  path: string;
  resource?: string;
  /** @Public หรือ @PlatformAuth (ไม่รับ token ลูกค้า) — ไม่รวม route ลิงก์ */
  isPublic: boolean;
  isPlatform: boolean;
  /** @LinkAction — ยืนยันตัวตนด้วย magic link (`:token`) */
  linkAction?: string;
  requiredScope?: string[];
  /** ชื่อ path param ทั้งหมด เช่น ['id', 'lineId'] */
  params: string[];
  controller: string;
  handler: string;
}

/** ทุก route ของแอป — ใช้ใน harness แยก tenant (ST0-T05) และ route inventory (ST9-T13) */
export function collectRoutes(app: NestExpressApplication): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as any;
      if (!cls) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
      const proto = cls.prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        const m = Reflect.getMetadata(METHOD_METADATA, handler);
        if (sub === undefined || m === undefined) continue;
        const meta = (k: string) => Reflect.getMetadata(k, handler) ?? Reflect.getMetadata(k, cls);
        const path = `/v1/${[base, String(sub)].filter((s) => s && s !== '/').join('/')}`.replace(
          /\/+/g,
          '/',
        );
        const platformRoles = meta(PLATFORM_ROLES);
        routes.push({
          method: RequestMethod[m as number]!,
          path,
          resource: meta(TENANT_RESOURCE),
          // route ของ Platform Console ไม่รับ token ลูกค้าเลย (ทดสอบใน platform.test.ts) — นับเหมือน public
          isPublic: Boolean(meta(IS_PUBLIC) ?? platformRoles),
          isPlatform: Boolean(platformRoles),
          linkAction: meta(LINK_ACTION),
          requiredScope: meta(REQUIRED_SCOPE),
          // `\\:` = ตัวอักษร `:` จริงใน path (เช่น `/orders\\:bulk`) ไม่ใช่ param
          params: [...path.matchAll(/(?<!\\):([A-Za-z0-9_]+)/g)].map((x) => x[1]!),
          controller: String(cls.name),
          handler: name,
        });
      }
    }
  }
  return routes;
}

/** action ของลิงก์แต่ละ purpose — ชุดเดียวกับที่โมดูลเจ้าของออกลิงก์ */
export const PURPOSE_ACTIONS: Record<LinkPurpose, readonly string[]> = {
  trip_offer: Object.values(OFFER_LINK_ACTIONS),
  pod: Object.values(POD_LINK_ACTIONS),
  settlement_review: Object.values(REVIEW_LINK_ACTIONS),
  tracking: [TRACKING_ACTION],
  carrier_docs: Object.values(DOCS_LINK_ACTIONS),
  trip_sheet: [SHEET_LINK_ACTION],
  // ST6-T11 ลิงก์ "ค่าเที่ยวของฉัน" ของรถร่วม (ดูอย่างเดียว)
  carrier_pay: Object.values(PAY_LINK_ACTIONS),
  // สงวนชื่อไว้ตั้งแต่ ST1-T06 — ยังไม่มีผู้ออกและไม่มี route (ใบจ่ายเงินใช้ settlement_review แบบดูอย่างเดียว D-59)
  settlement_view: [],
};
