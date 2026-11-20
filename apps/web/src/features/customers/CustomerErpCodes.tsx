import { Badge, Icon } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import { adapterName } from '../settings/ConnectorSettings';

/**
 * ST8-T05 รหัสลูกค้าในระบบบัญชีที่เชื่อมต่อ (docs/01 §3.7 external_mapping CUSTOMER, A.4)
 * ต้นแบบ TMS v4 drawer ลูกค้า แท็บ `erpc` "รหัสระบบบัญชี" (มีเมื่อมี connector — `s.conn`) + กล่องเตือน `warn` ในแท็บทั่วไป
 * แถวละ connector: ชื่อระบบ · ช่องรหัส (placeholder "ยังไม่ map") · ป้าย สำเร็จ/ยังไม่ map — บันทึกด้วยปุ่ม "บันทึก" ของ drawer
 */
export interface CustomerErpCode {
  connector: { id: string; adapterKey: string; displayName: string; status: string };
  externalId: string | null;
  sourceCode: string | null;
  status: string;
  updatedAt: string | null;
  version: number;
}

const key = (id: string) => ['customer-erp-codes', id];

export function useCustomerErpCodes(customerId: string, enabled: boolean) {
  return useQuery({
    queryKey: key(customerId),
    enabled,
    queryFn: async () =>
      (
        await unwrap(
          api.GET('/v1/customers/{id}/erp-codes', { params: { path: { id: customerId } } }),
        )
      ).data as CustomerErpCode[],
  });
}

/** บันทึกเฉพาะ connector ที่ค่าเปลี่ยน (ทีละตัว — If-Match = version ของแถว) */
export function useSaveCustomerErpCodes(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: { row: CustomerErpCode; value: string }[]) => {
      for (const { row, value } of items)
        await unwrap(
          api.PUT('/v1/customers/{id}/erp-codes/{connectorId}', {
            params: {
              path: { id: customerId, connectorId: row.connector.id },
              header: { 'If-Match': `"${row.version}"` } as never,
            },
            body: { externalId: value.trim() || null },
          }),
        );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key(customerId) }),
  });
}

/** ค่าในช่องที่ต่างจากที่บันทึกไว้ */
export function erpCodeChanges(rows: CustomerErpCode[], draft: Record<string, string>) {
  return rows.flatMap((row) => {
    const v = draft[row.connector.id];
    return v !== undefined && v.trim() !== (row.externalId ?? '') ? [{ row, value: v }] : [];
  });
}

export function CustomerErpCodesTab({
  rows,
  draft,
  onChange,
  readOnly,
}: {
  rows: CustomerErpCode[];
  draft: Record<string, string>;
  onChange: (connectorId: string, v: string) => void;
  readOnly: boolean;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t('cust.erp.title')}</h3>
      <div style={{ border: '1px solid #D9DCD4', borderRadius: 8, overflow: 'hidden' }}>
        {rows.map((r) => {
          const mapped = !!r.externalId;
          const name = adapterName(t, r.connector.adapterKey, r.connector.displayName);
          return (
            <div
              key={r.connector.id}
              data-testid="cust-erp-row"
              style={{
                display: 'grid',
                gridTemplateColumns: '110px minmax(0,1fr) auto',
                gap: 10,
                alignItems: 'center',
                padding: '10px 12px',
                borderBottom: '1px solid #E4E6E0',
              }}
            >
              <span style={{ fontWeight: 500 }}>{name}</span>
              <input
                aria-label={t('cust.erp.code', { erp: name })}
                value={draft[r.connector.id] ?? r.externalId ?? ''}
                onChange={(e) => onChange(r.connector.id, e.target.value)}
                placeholder={t('cust.erp.unmapped')}
                disabled={readOnly}
                maxLength={64}
                style={{
                  height: 32,
                  padding: '0 8px',
                  border: '1px solid #C9CDC3',
                  borderRadius: 6,
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: 13,
                  minWidth: 0,
                }}
              />
              <Badge
                label={t(mapped ? 'cust.erp.ok' : 'cust.erp.unmapped')}
                tone={mapped ? 'ok' : 'warn'}
                icon={mapped ? 'check' : 'link-2-off'}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** กล่องเตือนในแท็บทั่วไป (ต้นแบบ `warn` ของ drawer ลูกค้า) — connector ที่ยังไม่มีรหัสลูกค้า */
export function CustomerErpWarn({ rows }: { rows: CustomerErpCode[] }) {
  const { t } = useI18n();
  const missing = rows
    .filter((r) => !r.externalId)
    .map((r) => adapterName(t, r.connector.adapterKey, r.connector.displayName));
  if (!missing.length) return null;
  return (
    <div
      role="note"
      data-testid="cust-erp-warn"
      style={{
        background: '#FCF0DC',
        borderRadius: 8,
        padding: '10px 14px',
        display: 'flex',
        gap: 8,
      }}
    >
      <Icon n="triangle-alert" s={16} style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }} />
      <span>{t('cust.erp.warn', { erp: missing.join(', ') })}</span>
    </div>
  );
}
