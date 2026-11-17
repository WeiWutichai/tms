import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from '../../api';
import { useCursorList } from '../master/useCursorList';

export type StopEventFlag = Schemas['StopEventFlagDto'];
export type StopSequence = Schemas['StopEventSequenceDto'];
export type FlagKind = StopEventFlag['flags'][number];
export type FlagTab = 'all' | 'open' | 'resolved';
export type Decision = 'ACCEPT' | 'IGNORE';

const KEY = 'stop-event-flags';

/** รายการธง (ST4-T02 — GET /v1/stop-event-flags; ล่าสุดก่อน) */
export function useFlagList(filters: {
  status: FlagTab;
  flag: string;
  q: string;
  today?: boolean;
}) {
  const query: Record<string, string> = { status: filters.status };
  if (filters.today) query.resolvedToday = 'true';
  if (filters.flag) query.flag = filters.flag;
  if (filters.q.trim()) query.q = filters.q.trim();
  return useCursorList<StopEventFlag>(
    KEY,
    query,
    // เรียงเวลารับล่าสุดก่อนเสมอ (API ไม่มี sort)
    ({ sort: _sort, ...q }) =>
      unwrap(api.GET('/v1/stop-event-flags', { params: { query: q as never } })),
    { size: 10, persist: 'tms.exc.page' },
  );
}

export function useFlagSummary() {
  return useQuery({
    queryKey: [KEY, 'summary'],
    queryFn: () => unwrap(api.GET('/v1/stop-event-flags/summary')),
  });
}

/** ลำดับ event ของจุด (GET /v1/stops/{id}/events) — แท็บกิจกรรมของ drawer */
export function useStopSequence(stopId: string | null) {
  return useQuery({
    queryKey: [KEY, 'seq', stopId],
    enabled: !!stopId,
    queryFn: () => unwrap(api.GET('/v1/stops/{id}/events', { params: { path: { id: stopId! } } })),
  });
}

export function useResolveFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: Decision; reason: string }) =>
      unwrap(
        api.POST('/v1/stop-event-flags/{id}/resolve', {
          params: { path: { id: v.id } },
          body: { decision: v.decision, reason: v.reason },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
