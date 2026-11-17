import { Injectable, Logger } from '@nestjs/common';
import {
  POD_OUTCOMES,
  resolvePodChecklist,
  validatePod,
  type PodChecklist,
  type PodChecklistSource,
  type PodMissing,
  type PodOutcome,
  type PodSubmission,
} from '@tms/domain';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { readSettings } from '../settings/settings.service';

export interface EffectivePodChecklist {
  outcome: PodOutcome;
  source: PodChecklistSource;
  fields: PodChecklist['fields'];
  /** ชุดขององค์กร (ไม่สนใจ override ของลูกค้า) */
  tenantFields: PodChecklist['fields'];
}

/**
 * ตัวตรวจ POD ต่อลูกค้า (ST4-T05; docs/04 E2, docs/01 §5.3 `POST /driver/stops/{id}/pod` → 422 `pod_incomplete`)
 *
 * ผู้เรียก: ST4-T07 (ePOD เว็บ — คำนวณ pod_status), ST4-T09 (ลิงก์รถร่วม — ปิดงาน), แอปคนขับ
 * POD ทำแยกต่อ DO (spec/04 DRV-160) → ส่ง customerId ของ DO นั้น
 * ต้องเรียกภายใน request/transaction ของ tenant (RLS) — ลูกค้าข้าม tenant = 404
 */
@Injectable()
export class PodChecklistService {
  private readonly log = new Logger(PodChecklistService.name);
  constructor(private readonly db: DbService) {}

  /** checklist ที่ใช้จริงของลูกค้า (override ของลูกค้า → ค่าองค์กร → ค่าเริ่มต้นของระบบ) */
  async forCustomer(
    customerId: string,
    outcome: PodOutcome = 'SUCCESS',
  ): Promise<EffectivePodChecklist> {
    const tx = this.db.tx;
    const c = await tx.customer.findFirst({
      where: { id: customerId },
      select: { podRequirements: true },
    });
    if (!c) throw new ProblemException('not_found');
    const tenantId = requestContext.require().tenantId!;
    const s = await readSettings(tx, tenantId, ['pod.checklist']);
    const r = resolvePodChecklist(s['pod.checklist'], c.podRequirements, outcome);
    const d = resolvePodChecklist(s['pod.checklist'], {}, outcome);
    // ค่าในฐานผิดรูป (ไม่ควรเกิด — เขียนผ่านตัวตรวจเสมอ) → ใช้ชั้นถัดไป แต่ไม่เงียบ (review T05 M1)
    for (const f of r.fallbacks)
      this.log.warn(
        `pod checklist ${f.layer === 'CUSTOMER' ? `customer ${customerId}` : `tenant ${tenantId}`} (${outcome}) malformed — fell back: ${f.errors
          .map((e) => `${e.path} ${e.message}`)
          .join('; ')}`,
      );
    return {
      outcome,
      source: r.source,
      fields: r.checklist.fields,
      tenantFields: d.checklist.fields,
    };
  }

  async allForCustomer(customerId: string): Promise<EffectivePodChecklist[]> {
    const out: EffectivePodChecklist[] = [];
    for (const o of POD_OUTCOMES) out.push(await this.forCustomer(customerId, o));
    return out;
  }

  /** ตรวจหลักฐานกับ checklist ของลูกค้า — คืนรายการที่ขาด (ว่าง = ครบ) ใช้คำนวณ pod_status โดยไม่ปฏิเสธ */
  async check(
    customerId: string,
    outcome: PodOutcome,
    submission: PodSubmission,
  ): Promise<{ ok: boolean; missing: PodMissing[]; checklist: EffectivePodChecklist }> {
    const checklist = await this.forCustomer(customerId, outcome);
    return { ...validatePod(checklist, submission), checklist };
  }

  /** ปิดงาน: ขาด field ที่บังคับ → 422 `pod_incomplete` พร้อม `missing[]` และ errors ต่อ field */
  async assertComplete(
    customerId: string,
    outcome: PodOutcome,
    submission: PodSubmission,
  ): Promise<EffectivePodChecklist> {
    const r = await this.check(customerId, outcome, submission);
    if (!r.ok)
      throw new ProblemException(
        'pod_incomplete',
        undefined,
        r.missing.map((m) => ({
          field: `pod.${m.key}`,
          code: m.code,
          message:
            m.code === 'min_count'
              ? `at least ${m.expected} photo(s) required, got ${m.actual}`
              : `${m.type} is required`,
        })),
        { missing: r.missing },
      );
    return r.checklist;
  }
}
