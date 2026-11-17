import { ChoiceGroup } from '@tms/ui';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { PodChecklistTable, type PodField } from './PodChecklistTable';

/** checklist ที่ใช้จริงของลูกค้า + ชุดขององค์กร (`GET /customers/{id}/pod-checklist`) */
export function useCustomerPodChecklist(customerId: string, version: number) {
  return useQuery({
    queryKey: ['customers', customerId, 'pod-checklist', version],
    queryFn: () =>
      unwrap(api.GET('/v1/customers/{id}/pod-checklist', { params: { path: { id: customerId } } })),
  });
}

/**
 * drawer ลูกค้า แท็บ เงื่อนไข → หลักฐานส่ง (POD) (ST4-T05; docs/01 §3.2 `customer.pod_requirements`)
 * ต้นแบบไม่มีส่วนนี้ [DECISION spec/12 §3]: ตัวเลือกแบบเดียวกับช่องอื่นในแท็บ (ChoiceGroup) + ตารางเดียวกับหน้าตั้งค่า
 * ใช้ค่าองค์กร → แสดงชุดขององค์กรแบบอ่านอย่างเดียว · กำหนดเอง → ตั้งต้นจากชุดขององค์กรแล้วแก้ได้ (บันทึกด้วยปุ่มของ drawer)
 */
export function CustomerPodSection({
  customerId,
  version,
  readOnly,
  mode,
  fields,
  invalid,
  onChange,
}: {
  customerId: string;
  version: number;
  readOnly: boolean;
  mode: 'default' | 'custom';
  fields: PodField[];
  invalid: boolean;
  onChange: (mode: 'default' | 'custom', fields: PodField[]) => void;
}) {
  const { t } = useI18n();
  const q = useCustomerPodChecklist(customerId, version);
  const tenantFields = q.data?.data[0]?.tenantFields ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <ChoiceGroup
        label={t('pod.cust.title')}
        disabled={readOnly || !q.data}
        value={mode}
        onChange={(v) => {
          if (v === mode) return;
          // กำหนดเองครั้งแรก → ตั้งต้นจากชุดขององค์กร
          onChange(v, v === 'custom' && !fields.length ? tenantFields : fields);
        }}
        options={[
          { value: 'default', label: t('pod.cust.default') },
          { value: 'custom', label: t('pod.cust.custom') },
        ]}
      />
      {mode === 'default' ? (
        q.isError ? (
          <span className="tms-field-error">{t('pod.loadError')}</span>
        ) : q.data ? (
          <>
            <PodChecklistTable label={t('pod.cust.title')} fields={tenantFields} disabled />
            <span className="tms-field-hint">{t('pod.cust.defaultHint')}</span>
          </>
        ) : (
          <span style={{ color: '#59606B' }}>{t('rsn.loading')}</span>
        )
      ) : (
        <>
          <PodChecklistTable
            label={t('pod.cust.title')}
            fields={fields}
            disabled={readOnly}
            {...(readOnly ? {} : { onChange: (x: PodField[]) => onChange('custom', x) })}
          />
          {invalid && <span className="tms-field-error">{t('pod.v.label')}</span>}
        </>
      )}
    </div>
  );
}
