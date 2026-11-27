import { tryDecodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { LOGO_MIME } from '../documents/mime';
import { defaultFileStore } from '../../pdf/file-store';
import { readSettings } from './settings.service';

/**
 * P1-ST6-T04 โลโก้องค์กร (`org.logoDocumentId`) สำหรับ PDF และหน้าติดตาม
 * - เอกสารที่มีเลขแล้ว (ใบแจ้งหนี้/ใบวางบิล) ใช้ **id ที่ตรึงไว้ใน `print_options.logoDocumentId` ตอนออกเลข** — render ซ้ำ
 *   (สำเนา/ฉบับยกเลิก) ได้ภาพเดิมแม้เปลี่ยนโลโก้ภายหลัง · ใบที่ออกก่อนมีฟีเจอร์นี้ไม่มีค่า = ไม่มีโลโก้ (ผลพิมพ์/hash เดิม — ST9-T15)
 * - ร่าง / ใบสำคัญจ่าย (render ครั้งเดียวตอนอนุมัติ/จ่ายแล้วเก็บ — D-66) ใช้ค่าตั้งปัจจุบัน
 * - ไฟล์โลโก้ไม่มีการลบ (ไม่มี hard delete · retention ไม่แตะ kind LOGO)
 */
export interface OrgLogo {
  /** uuid ของ stored_document */
  documentId: string;
  mime: string;
  /** `data:` URI สำหรับฝังใน HTML ของ PDF (renderer บล็อกทุก request ที่ไม่ใช่ data:) */
  dataUri: string;
}

/** uuid ของโลโก้ตามค่าตั้งปัจจุบันของ tenant (ไม่ตั้ง = null) */
export async function currentLogoId(tx: Tx, tenantId: string): Promise<string | null> {
  const v = (await readSettings(tx, tenantId, ['org.logoDocumentId']))['org.logoDocumentId'];
  return typeof v === 'string' ? tryDecodeId('document', v) : null;
}

/** uuid ของโลโก้ปัจจุบันที่ใช้ได้จริง (ไฟล์พร้อม) — ใช้ตรึงใน `print_options` ตอนออกเลข (ไม่อ่านเนื้อไฟล์) */
export async function usableLogoId(tx: Tx, tenantId: string): Promise<string | null> {
  const id = await currentLogoId(tx, tenantId);
  if (!id) return null;
  const d = await tx.storedDocument.findUnique({
    where: { id },
    select: { status: true, kind: true, mimeType: true, fileKey: true },
  });
  return d?.status === 'READY' &&
    d.fileKey &&
    d.kind === 'LOGO' &&
    LOGO_MIME.includes(d.mimeType as never)
    ? id
    : null;
}

/** โหลดไฟล์โลโก้ (RLS ของ tx) — ไม่พบ/ไม่ใช่โลโก้ที่พร้อม = null */
export async function loadLogo(tx: Tx, documentId: string | null): Promise<OrgLogo | null> {
  if (!documentId) return null;
  const d = await tx.storedDocument.findUnique({ where: { id: documentId } });
  if (
    !d ||
    d.status !== 'READY' ||
    !d.fileKey ||
    d.kind !== 'LOGO' ||
    !LOGO_MIME.includes(d.mimeType as never)
  )
    return null;
  const data = await defaultFileStore().get(d.fileKey);
  return {
    documentId: d.id,
    mime: d.mimeType,
    dataUri: `data:${d.mimeType};base64,${data.toString('base64')}`,
  };
}
