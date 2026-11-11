import type { Schemas } from '@tms/contracts';
import { ActivityTimeline, EmptyState, type TimelineItem } from '@tms/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { formatDateTime, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n/th';

type AuditEntry = Schemas['AuditEntryDto'];
type AuditPage = Schemas['AuditPageDto'];

/** path ประวัติของ master ที่มี (เพิ่มเมื่อ master ใหม่มี `GET /{master}/{id}/history`) */
export type HistoryPath =
  | '/v1/customers/{id}/history'
  | '/v1/customer-sites/{id}/history'
  | '/v1/vehicle-types/{id}/history'
  | '/v1/carriers/{id}/history'
  | '/v1/vehicles/{id}/history'
  | '/v1/drivers/{id}/history';

const VERB: Record<
  string,
  { key: MessageKey; tone: 'ok' | 'info' | 'warn' | 'off' | 'err'; icon: string }
> = {
  created: { key: 'hist.created', tone: 'ok', icon: 'check' },
  updated: { key: 'hist.updated', tone: 'ok', icon: 'check' },
  deactivated: { key: 'hist.deactivated', tone: 'ok', icon: 'check' },
  reactivated: { key: 'hist.reactivated', tone: 'ok', icon: 'check' },
  deleted: { key: 'hist.deleted', tone: 'ok', icon: 'check' },
  // ST2-T03 geocode สถานที่
  geocoded: { key: 'hist.geocoded', tone: 'info', icon: 'map-pin' },
  geocode_confirmed: { key: 'hist.geocodeConfirmed', tone: 'ok', icon: 'check' },
  geocode_rejected: { key: 'hist.geocodeRejected', tone: 'warn', icon: 'x' },
  geocode_retried: { key: 'hist.geocodeRetried', tone: 'info', icon: 'refresh-cw' },
  // ST2-T05 ดูเลขบัตร/เลขบัญชีเต็ม (spec/11 NFR-153)
  pii_revealed: { key: 'hist.piiRevealed', tone: 'warn', icon: 'eye' },
  // ST2-T06 รถ: สถานะ / ปลดระวาง / เลขไมล์
  status_changed: { key: 'hist.statusChanged', tone: 'info', icon: 'refresh-cw' },
  retired: { key: 'hist.retired', tone: 'off', icon: 'archive' },
  odometer_recorded: { key: 'hist.odometerRecorded', tone: 'ok', icon: 'gauge' },
  odometer_corrected: { key: 'hist.odometerCorrected', tone: 'warn', icon: 'gauge' },
};
/** action ที่แสดงรายการช่องที่เปลี่ยน (ก่อน → หลัง) */
const DIFF_ACTIONS = [
  'updated',
  'geocoded',
  'geocode_confirmed',
  'geocode_rejected',
  'status_changed',
  'retired',
  'odometer_recorded',
  'odometer_corrected',
];

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  // พิกัดที่ geocode เสนอ {lat, lng, …} → "lat, lng"
  if (typeof v === 'object' && 'lat' in v && 'lng' in v)
    return `${(v as { lat: number }).lat}, ${(v as { lng: number }).lng}`;
  if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : '—';
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
  fieldValue,
  describe,
}: {
  path: HistoryPath;
  id: string;
  /** ชื่อฟิลด์ภาษาไทย (key ของ DTO → ข้อความ) — ไม่มี = แสดง key */
  fieldLabel: (k: string) => string;
  /** ค่าภาษาไทยของฟิลด์ที่เป็นรหัส (เช่น ชั้นรถ/ป้าย) — คืน undefined = แสดงค่าดิบ */
  fieldValue?: (k: string, v: unknown) => string | undefined;
  /** หัวรายการเฉพาะของ action บางชนิด (เช่น ประวัติเอกสารของรถ) — คืน undefined = ใช้ค่ามาตรฐาน */
  describe?: (
    r: AuditEntry,
  ) => { title: string; tone: 'ok' | 'info' | 'warn' | 'off' | 'err'; icon: string } | undefined;
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
    const act = r.action.split('.').pop() ?? '';
    const failed =
      act === 'geocoded' && (r.after as Record<string, unknown> | null)?.geocodeStatus === 'FAILED';
    const verb = (failed
      ? { key: 'hist.geocodeFailed' as MessageKey, tone: 'warn' as const, icon: 'circle-alert' }
      : VERB[act]) ?? {
      key: 'hist.updated' as MessageKey,
      tone: 'ok' as const,
      icon: 'check',
    };
    const custom = describe?.(r);
    const before = (r.before ?? {}) as Record<string, unknown>;
    const after = (r.after ?? {}) as Record<string, unknown>;
    const lines: string[] = [];
    if (!custom && DIFF_ACTIONS.includes(act))
      for (const k of Object.keys(after))
        lines.push(
          `${fieldLabel(k)}: ${fieldValue?.(k, before[k]) ?? show(before[k])} → ${fieldValue?.(k, after[k]) ?? show(after[k])}`,
        );
    if (r.reason) lines.push(t('hist.reason', { r: r.reason }));
    return {
      key: r.id,
      title: custom?.title ?? t(verb.key),
      sub: `${formatDateTime(r.at, lang)} · ${r.actor?.name ?? r.actor?.id ?? t('hist.system')}`,
      badge: {
        label: t('hist.ok'),
        tone: custom?.tone ?? verb.tone,
        icon: custom?.icon ?? verb.icon,
      },
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
