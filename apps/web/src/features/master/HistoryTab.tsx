import type { Schemas } from '@tms/contracts';
import { ActivityTimeline, EmptyState, type TimelineItem } from '@tms/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

type AuditEntry = Schemas['AuditEntryDto'];
type AuditPage = Schemas['AuditPageDto'];

/** path ประวัติของ master ที่มี (เพิ่มเมื่อ master ใหม่มี `GET /{master}/{id}/history`) */
export type HistoryPath = '/v1/customers/{id}/history' | '/v1/customer-sites/{id}/history';

const VERB: Record<
  string,
  { key: MessageKey; tone: 'ok' | 'info' | 'warn' | 'off' | 'err'; icon: string }
> = {
  created: { key: 'hist.created', tone: 'ok', icon: 'check' },
  updated: { key: 'hist.updated', tone: 'ok', icon: 'check' },
  deactivated: { key: 'hist.deactivated', tone: 'ok', icon: 'check' },
  reactivated: { key: 'hist.reactivated', tone: 'ok', icon: 'check' },
  deleted: { key: 'hist.deleted', tone: 'ok', icon: 'check' },
};

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * แท็บ "กิจกรรม" ของข้อมูลหลัก (ST2-T01 — ใช้ร่วมทุก master): ประวัติจาก audit log ใหม่สุดก่อน
 * หน้าตาตาม P.isLog ของต้นแบบ (จุด + เส้น, หัวรายการ + ป้าย, กดขยายดูรายละเอียด)
 * รายละเอียด = ฟิลด์ที่เปลี่ยน "ชื่อฟิลด์: ค่าเดิม → ค่าใหม่" + เหตุผล (ถ้ามี)
 */
export function HistoryTab({
  path,
  id,
  fieldLabel,
}: {
  path: HistoryPath;
  id: string;
  /** ชื่อฟิลด์ภาษาไทย (key ของ DTO → ข้อความ) — ไม่มี = แสดง key */
  fieldLabel: (k: string) => string;
}) {
  const { t, lang } = useI18n();
  const q = useInfiniteQuery({
    queryKey: ['history', path, id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET(path, {
          params: {
            path: { id },
            query: { limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
          },
        }),
      ) as Promise<AuditPage>,
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const rows: AuditEntry[] = q.data?.pages.flatMap((p) => p.data) ?? [];
  if (q.isSuccess && rows.length === 0)
    return <EmptyState icon="history" title={t('hist.empty')} description="" />;

  const items: TimelineItem[] = rows.map((r) => {
    const verb = VERB[r.action.split('.').pop() ?? ''] ?? {
      key: 'hist.updated' as MessageKey,
      tone: 'ok' as const,
      icon: 'check',
    };
    const before = (r.before ?? {}) as Record<string, unknown>;
    const after = (r.after ?? {}) as Record<string, unknown>;
    const lines: string[] = [];
    if (r.action.endsWith('.updated'))
      for (const k of Object.keys(after))
        lines.push(`${fieldLabel(k)}: ${show(before[k])} → ${show(after[k])}`);
    if (r.reason) lines.push(t('hist.reason', { r: r.reason }));
    return {
      key: r.id,
      title: t(verb.key),
      sub: `${formatDateTime(r.at, lang)} · ${r.actor?.name ?? r.actor?.id ?? t('hist.system')}`,
      badge: { label: t('hist.ok'), tone: verb.tone, icon: verb.icon },
      ...(lines.length ? { detail: lines.join('\n') } : {}),
    };
  });
  return (
    <>
      <ActivityTimeline items={items} />
      {q.hasNextPage && (
        <button type="button" className="tms-linkbtn" onClick={() => q.fetchNextPage()}>
          {t('hist.more')}
        </button>
      )}
    </>
  );
}
