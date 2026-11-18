import type { Schemas } from '@tms/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api, unwrap } from '../../api';
import { useSessionState, writeSession } from '../master/useCursorList';

export type ViewState = Record<string, string | number | boolean>;
export type SavedView = Schemas['SavedViewDto'];

const KEY = 'saved-views';

/** เทียบชุดตัวกรอง + คอลัมน์ (ลำดับ key ไม่มีผล — jsonb เรียง key ใหม่) */
export function sameView(
  a: { state: ViewState; hidden: string[] | null },
  b: { state: ViewState; hidden: string[] | null },
): boolean {
  const norm = (s: ViewState) =>
    JSON.stringify(
      Object.keys(s)
        .sort()
        .map((k) => [k, s[k]]),
    );
  const h = (x: string[] | null) => (x === null ? null : [...x].sort().join(','));
  return norm(a.state) === norm(b.state) && h(a.hidden) === h(b.hidden);
}

/**
 * อ่านค่าจาก state ของมุมมองแบบปลอดภัย — key ที่ไม่มี/ชนิดไม่ตรง → ค่าเริ่มต้นของหน้า
 * (มุมมองเก่าอาจไม่มี key ใหม่ หรือมาจาก API ภายนอก)
 */
export function pick<T extends ViewState>(state: ViewState, defaults: T): T {
  const out = { ...defaults } as Record<string, unknown>;
  for (const k of Object.keys(defaults)) {
    const v = state[k];
    if (v !== undefined && typeof v === typeof defaults[k]) out[k] = v;
  }
  return out as T;
}

export function useSavedViewList(page: string) {
  return useQuery({
    queryKey: [KEY, page],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const r = await unwrap(
        api.GET('/v1/saved-views', { params: { query: { page, limit: 200 } } }),
      );
      return [...(r.data as SavedView[])].sort((a, b) => a.name.localeCompare(b.name, 'th'));
    },
  });
}

export function useSavedViewMutations(page: string) {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: [KEY, page] });
  const create = useMutation({
    mutationFn: (body: Schemas['CreateSavedViewDto']) =>
      unwrap(api.POST('/v1/saved-views', { body })) as Promise<SavedView>,
    onSettled: done,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; version: number; body: Schemas['UpdateSavedViewDto'] }) =>
      unwrap(
        api.PATCH('/v1/saved-views/{id}', {
          params: { path: { id: v.id } },
          headers: { 'If-Match': `"${v.version}"` },
          body: v.body,
        }),
      ) as Promise<SavedView>,
    onSettled: done,
  });
  const remove = useMutation({
    mutationFn: (v: { id: string; version: number }) =>
      unwrap(
        api.DELETE('/v1/saved-views/{id}', {
          params: { path: { id: v.id } },
          headers: { 'If-Match': `"${v.version}"` },
        }),
      ),
    onSettled: done,
  });
  return { create, update, remove };
}

export interface SavedViewsBinding {
  page: string;
  views: SavedView[];
  loading: boolean;
  error: boolean;
  active: SavedView | null;
  /** ตัวกรอง/คอลัมน์ตอนนี้ต่างจากมุมมองที่เลือก */
  modified: boolean;
  /** ตอนนี้ = ไม่มีตัวกรอง + คอลัมน์ค่าเริ่มต้น ("ทั้งหมด") */
  isAll: boolean;
  current: { state: ViewState; hidden: string[] | null };
  select: (v: SavedView | null) => void;
  setActiveId: (id: string | null) => void;
}

/**
 * ผูกหน้ารายการกับมุมมองที่บันทึกไว้ (ST9-T11) — ใช้ร่วมทุกหน้าตาราง
 * - `state`/`hidden` = ค่าปัจจุบันของหน้า · `apply` = ตั้งค่าหน้าจากมุมมอง (null = "ทั้งหมด": ล้างตัวกรอง คอลัมน์ค่าเริ่มต้น)
 * - มุมมองที่เลือกจำต่อแท็บเบราว์เซอร์ (sessionStorage) เหมือนตัวกรองของหน้า
 * - เปิดหน้าครั้งแรกของแท็บ + มีมุมมองค่าเริ่มต้น + ยังไม่มีตัวกรอง → ใช้มุมมองค่าเริ่มต้น
 */
export function useSavedViews(opts: {
  page: string;
  state: ViewState;
  hidden: string[] | null;
  empty: ViewState;
  apply: (v: { state: ViewState; hidden: string[] | null }) => void;
}): SavedViewsBinding {
  const list = useSavedViewList(opts.page);
  const views = list.data ?? [];
  const [activeId, setActiveId] = useSessionState<string | null>(
    `tms.view.${opts.page}.active`,
    null,
  );
  const active = views.find((v) => v.id === activeId) ?? null;
  const current = { state: opts.state, hidden: opts.hidden };
  const isAll = sameView(current, { state: opts.empty, hidden: null });
  const apply = useRef(opts.apply);
  apply.current = opts.apply;

  // ค่าเริ่มต้น: ครั้งแรกของแท็บเบราว์เซอร์เท่านั้น (กลับจากหน้าอื่นไม่ทับตัวกรองที่ผู้ใช้ตั้งไว้)
  const initKey = `tms.view.${opts.page}.init`;
  useEffect(() => {
    if (!list.data) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem(initKey) !== null;
    } catch {
      seen = false;
    }
    if (seen) return;
    writeSession(initKey, 1);
    const def = list.data.find((v) => v.isDefault);
    if (def && isAll && activeId === null) {
      setActiveId(def.id);
      apply.current({ state: def.state as ViewState, hidden: def.hiddenColumns ?? null });
    }
  }, [list.data]);

  return {
    page: opts.page,
    views,
    loading: list.isLoading,
    error: list.isError,
    active,
    modified:
      !!active &&
      !sameView(current, {
        // เทียบหลังเติม/ตัด key ตามหน้า — มุมมองเก่าที่ไม่มี key ใหม่ไม่ถือว่าแก้ไข
        state: pick(active.state as ViewState, opts.empty),
        hidden: active.hiddenColumns ?? null,
      }),
    isAll,
    current,
    setActiveId,
    select: (v) => {
      setActiveId(v?.id ?? null);
      apply.current(
        v
          ? { state: v.state as ViewState, hidden: v.hiddenColumns ?? null }
          : { state: opts.empty, hidden: null },
      );
    },
  };
}
