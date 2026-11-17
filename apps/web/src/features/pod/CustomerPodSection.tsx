import { ChoiceGroup } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import {
  PodChecklistTable,
  PodSetTabs,
  POD_SETS,
  podChecklistInvalid,
  podTrim,
  type PodField,
  type PodSetKey,
} from './PodChecklistTable';

/** checklist ที่ใช้จริงของลูกค้า + ชุดขององค์กร (`GET /customers/{id}/pod-checklist`) */
export function useCustomerPodChecklist(customerId: string, version: number) {
  return useQuery({
    queryKey: ['customers', customerId, 'pod-checklist', version],
    queryFn: () =>
      unwrap(api.GET('/v1/customers/{id}/pod-checklist', { params: { path: { id: customerId } } })),
  });
}

/** ค่าในฟอร์มต่อชุด: default = ใช้ค่าองค์กร (ไม่ส่งชุดนั้น) · custom = กำหนดเองทั้งชุด (override แยกต่อชุด — T05) */
export type PodSetForm = { mode: 'default' | 'custom'; fields: PodField[] };
export type PodForm = Record<PodSetKey, PodSetForm>;

const OUTCOME: Record<PodSetKey, 'SUCCESS' | 'FAILURE'> = {
  success: 'SUCCESS',
  failure: 'FAILURE',
};

/** `customer.podRequirements` → ฟอร์ม */
export function podFormOf(req: Partial<Record<PodSetKey, { fields: PodField[] }>>): PodForm {
  return Object.fromEntries(
    POD_SETS.map((k) => [
      k,
      req[k] ? { mode: 'custom', fields: req[k]!.fields } : { mode: 'default', fields: [] },
    ]),
  ) as PodForm;
}

/** ฟอร์ม → `podRequirements` (เฉพาะชุดที่กำหนดเอง; `{}` = ใช้ค่าองค์กรทุกชุด) */
export function podBodyOf(f: PodForm): Partial<Record<PodSetKey, { fields: PodField[] }>> {
  return Object.fromEntries(
    POD_SETS.filter((k) => f[k].mode === 'custom').map((k) => [
      k,
      { fields: podTrim(f[k].fields) },
    ]),
  );
}

export const podFormInvalid = (f: PodForm) =>
  POD_SETS.some((k) => f[k].mode === 'custom' && podChecklistInvalid(f[k].fields));

/**
 * drawer ลูกค้า แท็บ เงื่อนไข → หลักฐานส่ง (POD) (ST4-T05/T06; docs/01 §3.2 `customer.pod_requirements`)
 * ต้นแบบไม่มีส่วนนี้ [DECISION spec/12 §3]: แท็บ ส่งสำเร็จ / ส่งไม่สำเร็จ → ตัวเลือกต่อชุด (ChoiceGroup) + ตารางเดียวกับหน้าตั้งค่า
 * ใช้ค่าองค์กร → แสดงชุดขององค์กรแบบอ่านอย่างเดียว · กำหนดเอง → ตั้งต้นจากชุดขององค์กรแล้วแก้ได้ (บันทึกด้วยปุ่มของ drawer)
 */
export function CustomerPodSection({
  customerId,
  version,
  readOnly,
  pod,
  onChange,
}: {
  customerId: string;
  version: number;
  readOnly: boolean;
  pod: PodForm;
  onChange: (pod: PodForm) => void;
}) {
  const { t } = useI18n();
  const q = useCustomerPodChecklist(customerId, version);
  const [set, setSet] = useState<PodSetKey>('success');
  const tenantFields = q.data?.data.find((x) => x.outcome === OUTCOME[set])?.tenantFields ?? [];
  const cur = pod[set];
  const put = (v: PodSetForm) => onChange({ ...pod, [set]: v });
  const invalid = cur.mode === 'custom' && podChecklistInvalid(cur.fields);
  const setLabel = `${t('pod.cust.title')} — ${t(`pod.set.${set}` as MessageKey)}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="tms-label">{t('pod.cust.title')}</span>
      <div style={{ borderBottom: '1px solid #E4E6E0' }}>
        <PodSetTabs value={set} onChange={setSet} label={t('pod.sets')} />
      </div>
      <ChoiceGroup
        label={t(`pod.setHint.${set}` as MessageKey)}
        disabled={readOnly || !q.data}
        value={cur.mode}
        onChange={(v) => {
          if (v === cur.mode) return;
          // กำหนดเองครั้งแรก → ตั้งต้นจากชุดขององค์กร
          put({
            mode: v,
            fields: v === 'custom' && !cur.fields.length ? tenantFields : cur.fields,
          });
        }}
        options={[
          { value: 'default', label: t('pod.cust.default') },
          { value: 'custom', label: t('pod.cust.custom') },
        ]}
      />
      {cur.mode === 'default' ? (
        q.isError ? (
          <span className="tms-field-error">{t('pod.loadError')}</span>
        ) : q.data ? (
          <>
            <PodChecklistTable label={setLabel} fields={tenantFields} disabled />
            <span className="tms-field-hint">{t('pod.cust.defaultHint')}</span>
          </>
        ) : (
          <span style={{ color: '#59606B' }}>{t('rsn.loading')}</span>
        )
      ) : (
        <>
          <PodChecklistTable
            label={setLabel}
            fields={cur.fields}
            disabled={readOnly}
            {...(readOnly
              ? {}
              : { onChange: (x: PodField[]) => put({ mode: 'custom', fields: x }) })}
          />
          {invalid && <span className="tms-field-error">{t('pod.v.label')}</span>}
        </>
      )}
    </div>
  );
}
