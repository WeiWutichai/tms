import { EmptyState } from '@tms/ui';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';
import { SaveBar } from '../settings/OrgSections';
import { useSaveTenantSettings, useTenantSettings } from '../settings/useSettings';
import {
  PodChecklistTable,
  PodSetTabs,
  POD_SETS,
  podChecklistInvalid,
  podTrim,
  type PodField,
  type PodSetKey,
} from './PodChecklistTable';

type Sets = Record<PodSetKey, PodField[]>;

const KEY = 'pod.checklist';

/**
 * ตั้งค่า → หลักฐานส่ง (POD) — ค่าเริ่มต้นของ tenant (ST4-T05; docs/04 I "POD checklist default", E2)
 * ต้นแบบไม่มีหัวข้อนี้ [DECISION spec/12 §3]: การ์ด + ตารางแบบหน้า เหตุผล + ปุ่ม "บันทึก" ลอยมุมขวาล่าง
 * ST4-T06: แท็บ ส่งสำเร็จ / ส่งไม่สำเร็จ (แบบแท็บของ ตั้งค่า → ผู้ใช้) — ร่างแยกต่อชุด บันทึกทั้งสองชุดพร้อมกัน
 */
export function PodSection({ canWrite }: { canWrite: boolean }) {
  const { t } = useI18n();
  const q = useTenantSettings();
  const save = useSaveTenantSettings();
  const row = q.data?.data.find((s) => s.key === KEY);
  const server = useMemo<Sets>(() => {
    const v = row?.value as Partial<Record<PodSetKey, { fields: PodField[] }>> | undefined;
    return { success: v?.success?.fields ?? [], failure: v?.failure?.fields ?? [] };
  }, [row]);
  const [set, setSet] = useState<PodSetKey>('success');
  const [draft, setDraft] = useState<Sets | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // โหลดใหม่จาก server (หลังบันทึก/412) → ทิ้ง draft ที่ตรงกับ server
  useEffect(() => {
    setDraft((d) => (d && JSON.stringify(d) === JSON.stringify(server) ? null : d));
  }, [server]);
  useEffect(() => {
    if (!saved && !error) return;
    const id = setTimeout(() => {
      setSaved(null);
      setError(null);
    }, 3600);
    return () => clearTimeout(id);
  }, [saved, error]);
  const sets = draft ?? server;
  const fields = sets[set];
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(server);

  const onSave = () => {
    if (!dirty) return setSaved(t('set.saved', { section: t('set.menu.pod') }));
    const bad = POD_SETS.find((k) => podChecklistInvalid(sets[k]));
    if (bad) {
      setSet(bad);
      return setError(t('pod.v.label'));
    }
    save.mutate(
      {
        values: {
          [KEY]: Object.fromEntries(POD_SETS.map((k) => [k, { fields: podTrim(sets[k]) }])),
        },
        versions: { [KEY]: row?.version ?? 0 },
      },
      {
        onSuccess: () => {
          setDraft(null);
          setSaved(t('set.saved', { section: t('set.menu.pod') }));
        },
        onError: (e) => {
          const code = e instanceof ApiError ? e.problem.code : 'internal_error';
          if (code === 'precondition_failed') {
            // ผู้อื่นแก้ไปก่อน → ทิ้งร่าง โหลดค่าล่าสุด ให้ผู้ใช้แก้ใหม่บนค่านั้น (ไม่ทับงานคนอื่น — QA L2)
            setDraft(null);
            void q.refetch();
            return setError(t('pod.stale'));
          }
          setError(t(`problem.${code}` as MessageKey));
        },
      },
    );
  };

  return (
    <section className="set-card">
      <div className="set-tabs-hd">
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h2>{t('pod.title')}</h2>
          <span style={{ color: '#3B424C' }}>{t('pod.sub')}</span>
        </div>
        <PodSetTabs value={set} onChange={setSet} label={t('pod.sets')} />
      </div>
      {q.isError && !q.data ? (
        <EmptyState
          icon="triangle-alert"
          title={t('set.loadError')}
          action={
            <button type="button" className="set-btn2" onClick={() => void q.refetch()}>
              {t('rsn.retry')}
            </button>
          }
        />
      ) : !q.data ? (
        <div style={{ padding: 20, color: '#59606B' }}>{t('rsn.loading')}</div>
      ) : (
        <>
          <div style={{ padding: '12px 20px 0', color: '#59606B', fontSize: 12.5 }}>
            {t(`pod.setHint.${set}` as MessageKey)}
          </div>
          <PodChecklistTable
            inset
            label={`${t('pod.title')} — ${t(`pod.set.${set}` as MessageKey)}`}
            fields={fields}
            disabled={!canWrite || save.isPending}
            {...(canWrite ? { onChange: (x: PodField[]) => setDraft({ ...sets, [set]: x }) } : {})}
          />
        </>
      )}
      {canWrite && q.data && (
        <SaveBar
          dirty={dirty}
          busy={save.isPending || !q.data}
          onSave={onSave}
          saved={saved}
          error={error}
          onDismiss={() => {
            setSaved(null);
            setError(null);
          }}
        />
      )}
    </section>
  );
}
