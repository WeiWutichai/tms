import { scopeAllows } from '@tms/domain';
import { assertBankStepUp } from '../../auth/step-up';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { nationalIdAllowed } from '../accounting-export/accounting-export.service';

/** สิทธิ์ดูเลขบัญชีเต็มของผู้รับเหมา (`POST /carriers/{id}/reveal` field bankAccountNo) — ใช้กับไฟล์หน้าสมุดบัญชี */
export const BANK_VIEW_SCOPE = 'settlements:pay';

/** ชนิดไฟล์แนบที่เป็นข้อมูลส่วนบุคคล → ด่านที่ใช้ */
export const PII_ATTACH: Record<string, 'bank' | 'nationalId'> = {
  BANK_BOOK: 'bank',
  ID_CARD: 'nationalId',
};

/** ชนิดไฟล์แนบของแถว stored_document (คนขับ/ผู้รับเหมาเท่านั้น) */
export function attachTypeOf(doc: { entityType: string | null; metadata: unknown }): string | null {
  if (doc.entityType !== 'driver' && doc.entityType !== 'carrier') return null;
  const t = (doc.metadata as { attachType?: unknown } | null)?.attachType;
  return typeof t === 'string' ? t : null;
}

/**
 * review round 2 (#1): เปิด/ดาวน์โหลดไฟล์แนบที่เป็นข้อมูลส่วนบุคคล ต้องผ่านด่านเดียวกับการดูค่าเต็มในระบบ
 * - หน้าสมุดบัญชี (BANK_BOOK) = ดูเลขบัญชีเต็ม: `settlements:pay` + step-up 2FA (D-67(4)) · API key / OAuth client ไม่ได้ (D-79)
 * - บัตรประชาชน (ID_CARD) = `pii.national_id:read` และเป็นผู้ใช้ที่ login (D-73 — API key / เข้าใช้งานแทนไม่ได้)
 *   (การดูเลขบัตรเต็มวันนี้ไม่บังคับ step-up → ไม่บังคับเพิ่ม)
 * ไม่มีสิทธิ์ = 404 (ไม่บอกใบ้ว่ามีไฟล์ — แบบไฟล์ส่งออก/นำเข้า) · ขาด step-up = 403 `step_up_required`
 * รายการไฟล์แนบไม่มี URL ไฟล์ — เปิดได้ทาง `GET /v1/documents/{id}` เท่านั้น (ด่านนี้)
 */
export function assertAttachmentAccess(doc: { entityType: string | null; metadata: unknown }) {
  const t = attachTypeOf(doc);
  const gate = t ? PII_ATTACH[t] : undefined;
  if (!gate) return;
  const ctx = requestContext.require();
  if (gate === 'bank') {
    if (!scopeAllows(ctx.scopes ?? [], BANK_VIEW_SCOPE)) throw new ProblemException('not_found');
    assertBankStepUp();
    return;
  }
  if (!nationalIdAllowed(ctx.scopes ?? [], ctx.principalType))
    throw new ProblemException('not_found');
}
