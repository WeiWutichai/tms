import type { Schemas } from '@tms/contracts';
import { EmptyState } from '@tms/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

type Connector = Schemas['ConnectorDto'];
type ItemMapping = Schemas['ErpItemMappingDto'];

/**
 * ตาราง "จับคู่ประเภทค่าใช้จ่าย ↔ รหัสสินค้าใน {ระบบ}" (ST7-T18) — ต้นแบบ TMS v4 `st.cd` แท็บ map
 * ST7-T20 รวมเข้ากล่อง "ตั้งค่า {ระบบ}" ของ ConnectorSettings (แท็บ การจับคู่และเลขเอกสาร)
 * ค่าบริการทุกฝั่ง (ฝั่งซื้อใช้กับ settlement) + ที่ปิดใช้ (ต่อท้าย "(ปิดใช้)") · บันทึกส่ง If-Match — 412 = โหลดใหม่แล้วแจ้ง
 */
export function MappingTable({
  c,
  name,
  canWrite,
}: {
  c: Connector;
  name: string;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const maps = useQuery({
    queryKey: ['connector-mappings', c.id],
    queryFn: () =>
      unwrap(api.GET('/v1/connectors/{id}/mappings', { params: { path: { id: c.id } } })),
  });
  const codes = useQuery({
    queryKey: ['connector-master-codes', c.id, 'ITEM'],
    queryFn: () =>
      unwrap(
        api.GET('/v1/connectors/{id}/master-codes', {
          params: { path: { id: c.id }, query: { kind: 'ITEM' } },
        }),
      ),
  });
  const listId = `conn-codes-${c.id}`;
  return (
    <div className="conn-map">
      <span className="conn-map__lbl">{t('conn.map.label', { name })}</span>
      {maps.isError ? (
        <EmptyState
          icon="triangle-alert"
          title={t('conn.map.loadError')}
          action={
            <button type="button" className="set-btn2" onClick={() => void maps.refetch()}>
              {t('cnx.retry')}
            </button>
          }
        />
      ) : maps.isLoading ? (
        <div className="conn-msg">{t('cnx.loading')}</div>
      ) : (
        <div className="conn-map__tbl">
          <div className="conn-map__row conn-map__row--hd">
            <span>{t('conn.map.col.type')}</span>
            <span>{t('conn.map.col.vat')}</span>
            <span>{t('conn.map.col.code', { name })}</span>
          </div>
          {(maps.data?.data ?? []).map((m) => (
            <MappingRow
              key={m.serviceItem.id}
              connectorId={c.id}
              m={m}
              name={name}
              listId={listId}
              canWrite={canWrite && c.status !== 'DISCONNECTED'}
            />
          ))}
        </div>
      )}
      <datalist id={listId}>
        {(codes.data?.data ?? []).map((x) => (
          <option key={x.code} value={x.code}>
            {x.name ?? ''}
          </option>
        ))}
      </datalist>
    </div>
  );
}

function MappingRow({
  connectorId,
  m,
  name,
  listId,
  canWrite,
}: {
  connectorId: string;
  m: ItemMapping;
  name: string;
  listId: string;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [v, setV] = useState(m.itemCode ?? '');
  useEffect(() => setV(m.itemCode ?? ''), [m.itemCode]);
  const save = useMutation({
    mutationFn: (itemCode: string | null) =>
      unwrap(
        api.PUT('/v1/connectors/{id}/mappings/{serviceItemId}', {
          params: {
            path: { id: connectorId, serviceItemId: m.serviceItem.id },
            header: { 'If-Match': `"${m.version}"` },
          },
          body: { itemCode },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connector-mappings', connectorId] }),
    // มีคนแก้ก่อน (412) → โหลดค่าล่าสุด แล้วแจ้งให้ตรวจอีกครั้ง
    onError: (e) => {
      if (e instanceof ApiError && e.problem.code === 'precondition_failed')
        void qc.invalidateQueries({ queryKey: ['connector-mappings', connectorId] });
    },
  });
  const code = save.error instanceof ApiError ? save.error.problem.errors?.[0]?.code : undefined;
  const stale = save.error instanceof ApiError && save.error.problem.code === 'precondition_failed';
  const err = save.error
    ? t(
        stale
          ? 'conn.map.stale'
          : code === 'erp_code_unknown'
            ? 'conn.map.unknown'
            : code === 'invalid_format'
              ? 'conn.map.invalid'
              : 'conn.map.saveFailed',
        { name },
      )
    : !save.isPending && m.status === 'CODE_UNKNOWN' && v === (m.itemCode ?? '')
      ? t('conn.map.unknown', { name })
      : '';
  const label =
    m.serviceItem.status === 'INACTIVE'
      ? t('conn.map.inactive', { name: m.serviceItem.nameTh })
      : m.serviceItem.nameTh;
  return (
    <div className="conn-map__row">
      <span>{label}</span>
      <span>
        <span className="conn-map__vat">{t(`svc.vat.${m.serviceItem.vatType}` as MessageKey)}</span>
      </span>
      <span className="conn-map__in">
        <input
          value={v}
          list={listId}
          disabled={!canWrite}
          aria-label={t('conn.map.col.code', { name }) + ' ' + label}
          aria-invalid={!!err || undefined}
          title={err || undefined}
          style={err ? { borderColor: '#B3322A' } : undefined}
          onChange={(e) => {
            setV(e.target.value);
            save.reset();
          }}
          onBlur={() => {
            const next = v.trim();
            if (next !== (m.itemCode ?? '')) save.mutate(next || null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </span>
    </div>
  );
}
