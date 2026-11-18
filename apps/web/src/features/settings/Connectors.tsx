import type { Schemas } from '@tms/contracts';
import { EmptyState } from '@tms/ui';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

type Connector = Schemas['ConnectorDto'];
type ItemMapping = Schemas['ErpItemMappingDto'];

/**
 * ตั้งค่า → การเชื่อมต่อ → ระบบบัญชี (ERP) (ST7-T18) — ต้นแบบ TMS v4 `st.is.conn` (ส่วน `st.cd` "ตั้งค่า {ระบบ}" → แท็บ map)
 * ทำเฉพาะตาราง "จับคู่ประเภทค่าใช้จ่าย ↔ รหัสสินค้าใน {ระบบ}" ของ connector ที่ยังไม่ยกเลิก (ลิงก์ `?connector=` จากคำสั่งที่ถูกกัน)
 * การ์ดเลือก/เชื่อม/ทดสอบ + วันที่เริ่มซิงก์ = ST7-T20 · ใครออกเลขเอกสาร = ST7-T17 · แท็บบันทึกการซิงก์ = ST7-T19 [DECISION spec/12 §3]
 * ไม่มี connector / แพ็กเกจไม่มี = แสดง "ยังไม่เปิดใช้" ตามเดิม (Standalone) · โหลดล้ม = แจ้ง + ลองอีกครั้ง
 * ค่าบริการทุกฝั่ง (ฝั่งซื้อใช้กับ settlement) + ที่ปิดใช้ (ต่อท้าย "(ปิดใช้)") · บันทึกส่ง If-Match — 412 = โหลดใหม่แล้วแจ้ง
 */
export function ConnectorsSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const q = useQuery({
    queryKey: ['connectors'],
    queryFn: () => unwrap(api.GET('/v1/connectors')),
    retry: false,
  });
  const want = params.get('connector');
  const list = (q.data?.data ?? []).filter((c) => !want || c.id === want);
  // แพ็กเกจไม่มีการเชื่อมต่อ (403) = Standalone · ล้มแบบอื่น = แจ้งผิดพลาด + ลองอีกครั้ง (ไม่ใช่ "ยังไม่เปิดใช้")
  const notInPlan = q.error instanceof ApiError && q.error.problem.status === 403;
  if (q.isLoading) return <Shell>{<div className="conn-msg">{t('conn.loading')}</div>}</Shell>;
  if (q.isError && !notInPlan)
    return (
      <Shell>
        <Failed title={t('conn.loadError')} retry={() => void q.refetch()} />
      </Shell>
    );
  if (want && !list.length)
    // ลิงก์จากคำสั่งที่ถูกกันชี้ไป connector ที่ยกเลิกแล้ว/ไม่มี
    return (
      <Shell>
        <EmptyState icon="unplug" title={t('conn.gone.title')} description={t('conn.gone.desc')} />
      </Shell>
    );
  if (!list.length)
    return (
      <section className="set-card">
        <div className="set-card__hd">
          <h2>{t('set.menu.conn')}</h2>
        </div>
        <EmptyState
          icon="construction"
          title={t('empty.notReady.title')}
          description={t('set.notReady', { stage: 'ST7' })}
        />
      </section>
    );
  return (
    <section className="conn-sec">
      <div className="conn-sec__hd">
        <h2>{t('conn.title')}</h2>
        <span>{t('conn.sub')}</span>
      </div>
      {list.map((c) => (
        <ConnectorDetail key={c.id} c={c} canWrite={canWrite} />
      ))}
    </section>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="set-card">
      <div className="set-card__hd">
        <h2>{t('set.menu.conn')}</h2>
      </div>
      {children}
    </section>
  );
}

function Failed({ title, retry }: { title: string; retry: () => void }) {
  const { t } = useI18n();
  return (
    <EmptyState
      icon="triangle-alert"
      title={title}
      action={
        <button type="button" className="set-btn2" onClick={retry}>
          {t('conn.retry')}
        </button>
      }
    />
  );
}

function ConnectorDetail({ c, canWrite }: { c: Connector; canWrite: boolean }) {
  const { t } = useI18n();
  const name = c.displayName ?? c.adapterKey;
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
    <div className="conn-cd" data-testid="connector-detail">
      <div className="conn-cd__hd">
        <div className="conn-cd__title">
          <h3>{t('conn.cd.title', { name })}</h3>
          {c.status !== 'ACTIVE' && <span>{t('conn.cd.off')}</span>}
        </div>
        <div className="conn-cd__tabs" role="tablist">
          <button type="button" role="tab" aria-selected="true">
            {t('conn.tab.map')}
          </button>
        </div>
      </div>
      <div className="conn-cd__body">
        <div className="conn-map">
          <span className="conn-map__lbl">{t('conn.map.label', { name })}</span>
          {maps.isError ? (
            <Failed title={t('conn.map.loadError')} retry={() => void maps.refetch()} />
          ) : maps.isLoading ? (
            <div className="conn-msg">{t('conn.loading')}</div>
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
      </div>
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
