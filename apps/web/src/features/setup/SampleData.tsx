import { useMutation, useQuery } from '@tanstack/react-query';
import { Icon, useEscapeLayer, useModalFocus } from '@tms/ui';
import { useRef, useState } from 'react';
import { api, queryClient, unwrap } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { problemText } from '../master/problems';

export const SAMPLE_KEY = ['sample-data'] as const;

type Counts = Record<
  'customer' | 'customer_site' | 'carrier' | 'vehicle' | 'rate_card' | 'sales_order',
  number
>;
export interface SampleStatus {
  allowed: boolean;
  loaded: boolean;
  counts: Counts;
}
interface Kept {
  entityType: string;
  id: string;
  label: string;
  reason: string;
}

/** สถานะข้อมูลตัวอย่าง (เฉพาะผู้ตั้งค่าบริษัท — ผู้เรียกส่ง enabled) */
export function useSampleData(enabled: boolean) {
  return useQuery({
    queryKey: SAMPLE_KEY,
    enabled,
    queryFn: async () =>
      ((await api.GET('/v1/sample-data')).data as SampleStatus | undefined) ?? null,
    retry: false,
  });
}

/** ข้อมูลหลัก/ใบสั่งเปลี่ยน → รายการทุกหน้าโหลดใหม่ + checklist */
function refreshAll() {
  void queryClient.invalidateQueries();
}

/**
 * แถบ "ลองใช้ด้วยข้อมูลตัวอย่าง" ในการ์ดเริ่มต้นใช้งาน (P1-ST2-T09; docs/02 §2) — ต้นแบบไม่มีขั้นนี้
 * [DECISION — lead 28 พ.ย. 2569, ย้อนได้ — spec/12 §3]: ประกอบจากแบบของการ์ดขั้น (`chk` — กรอบ #E4E6E0 radius 10 พื้น #F7F8F5,
 * วงไอคอน 24px) + ปุ่ม `tms-btn` ของ design system · ล้าง = กล่องยืนยันกรอบ `tms-dialog` · ผลล้างที่เก็บไว้ = dialog รายการ
 */
export function SampleDataStrip({
  s,
  onToast,
}: {
  s: SampleStatus;
  onToast: (text: string) => void;
}) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const [kept, setKept] = useState<Kept[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/sample-data')),
    onSuccess: (d) => {
      setErr(null);
      queryClient.setQueryData(SAMPLE_KEY, d);
      refreshAll();
      onToast(t('sample.loadedToast'));
    },
    onError: (e) => setErr(problemText(e, t)),
  });
  const clear = useMutation({
    mutationFn: () => unwrap(api.POST('/v1/sample-data/clear')),
    onSuccess: (d) => {
      setErr(null);
      setConfirm(false);
      queryClient.setQueryData(SAMPLE_KEY, d);
      refreshAll();
      const k = (d as { kept: Kept[] }).kept;
      if (k.length) setKept(k);
      else onToast(t('sample.clearedToast'));
    },
    onError: (e) => {
      setConfirm(false);
      setErr(problemText(e, t));
    },
  });
  if (!s.loaded && !s.allowed && !kept) return null;
  const c = s.counts;
  return (
    <div
      data-testid="sample-data"
      data-loaded={s.loaded ? 'true' : 'false'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        border: '1px solid #E4E6E0',
        borderRadius: 10,
        background: '#F7F8F5',
        flexWrap: 'wrap',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          border: '1.5px solid #9DB6E3',
          color: '#2257C4',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon n="database" s={13} />
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 220 }}>
        <span style={{ fontWeight: 600, color: '#101418' }}>
          {s.loaded ? t('sample.loadedTitle') : t('sample.title')}
        </span>
        <span style={{ fontSize: 12.5, color: '#59606B' }}>
          {s.loaded
            ? t('sample.loadedDesc', {
                c: c.customer,
                s: c.customer_site,
                v: c.vehicle,
                k: c.carrier,
                r: c.rate_card,
                o: c.sales_order,
              })
            : t('sample.desc')}
        </span>
        {err && (
          <span role="alert" style={{ fontSize: 12.5, color: '#B3322A' }}>
            {err}
          </span>
        )}
      </div>
      {s.loaded ? (
        <button
          type="button"
          className="tms-btn tms-btn--sm tms-btn--danger"
          onClick={() => setConfirm(true)}
          disabled={clear.isPending}
        >
          <Icon n="trash-2" s={15} />
          {t('sample.clear')}
        </button>
      ) : (
        s.allowed && (
          <button
            type="button"
            className="tms-btn tms-btn--sm tms-btn--secondary"
            onClick={() => load.mutate()}
            disabled={load.isPending}
            aria-busy={load.isPending}
          >
            <Icon n="database" s={15} />
            {t('sample.load')}
          </button>
        )
      )}
      {confirm && (
        <ClearDialog
          busy={clear.isPending}
          onOk={() => clear.mutate()}
          onClose={() => setConfirm(false)}
        />
      )}
      {kept && <KeptDialog kept={kept} onClose={() => setKept(null)} />}
    </div>
  );
}

function ClearDialog({
  busy,
  onOk,
  onClose,
}: {
  busy: boolean;
  onOk: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useEscapeLayer(true, onClose);
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(true, box);
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        role="alertdialog"
        aria-modal="true"
        tabIndex={-1}
        data-modal-focus=""
        aria-label={t('sample.clearTitle')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{t('sample.clearTitle')}</h2>
            <p className="tms-dialog__desc">{t('sample.clearDesc')}</p>
          </div>
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="tms-btn tms-btn--danger"
            disabled={busy}
            aria-busy={busy}
            onClick={onOk}
          >
            <Icon n="trash-2" s={16} />
            {t('sample.clearOk')}
          </button>
        </div>
      </div>
    </div>
  );
}

function KeptDialog({ kept, onClose }: { kept: Kept[]; onClose: () => void }) {
  const { t } = useI18n();
  useEscapeLayer(true, onClose);
  const box = useRef<HTMLDivElement>(null);
  useModalFocus(true, box);
  return (
    <div className="tms-dialog__scrim" onClick={onClose}>
      <div
        ref={box}
        className="tms-dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        data-modal-focus=""
        aria-label={t('sample.keptTitle', { n: kept.length })}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tms-dialog__head">
          <div style={{ flex: 1 }}>
            <h2 className="tms-dialog__title">{t('sample.keptTitle', { n: kept.length })}</h2>
            <p className="tms-dialog__desc">{t('sample.keptDesc')}</p>
          </div>
          <button
            type="button"
            className="tms-drawer__iconbtn"
            aria-label={t('drawer.close')}
            title={t('drawer.close')}
            onClick={onClose}
          >
            <Icon n="x" s={18} />
          </button>
        </div>
        <div className="tms-dialog__body">
          {kept.map((k) => (
            <div
              key={k.id}
              data-testid="sample-kept"
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}
            >
              <Icon
                n="triangle-alert"
                s={16}
                style={{ color: '#8F5500', marginTop: 3, flexShrink: 0 }}
              />
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500 }}>{k.label}</span>
                <span style={{ color: '#59606B', fontSize: 12.5 }}>
                  {t(`sample.type.${k.entityType}` as MessageKey)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <div className="tms-dialog__foot">
          <button type="button" className="tms-dialog__cancel" onClick={onClose}>
            {t('plan.bulk.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
