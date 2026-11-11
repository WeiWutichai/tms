import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export interface CursorPage<R> {
  data: R[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** หน่วงค่าที่พิมพ์ในช่องกรอง (ไม่ยิง API ทุกตัวอักษร) */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = setTimeout(() => setV(value), ms);
    return () => clearTimeout(h);
  }, [value, ms]);
  return v;
}

/** อ่าน/เขียน sessionStorage แบบไม่พัง (private mode / ปิด storage) */
function readSession<T>(key: string | undefined): T | undefined {
  if (!key) return undefined;
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}
function writeSession(key: string | undefined, value: unknown) {
  if (!key) return;
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ไม่มี storage — ไม่จำสถานะ */
  }
}

/**
 * state ที่จำไว้ใน sessionStorage ของแท็บเบราว์เซอร์ — ใช้จำแท็บ/ตัวกรองของรายการเมื่อไปหน้าโปรไฟล์แล้วกลับมา (review ST2-T07)
 * `key` undefined = state ธรรมดา
 */
export function useSessionState<T>(key: string | undefined, init: T) {
  const [v, setV] = useState<T>(() => readSession<T>(key) ?? init);
  useEffect(() => writeSession(key, v), [key, v]);
  return [v, setV] as const;
}

interface Persisted {
  k: string;
  size: number;
  cursors: (string | null)[];
  index: number;
  total?: number;
}

/**
 * list แบบ cursor ที่ใช้ร่วมทุกหน้าข้อมูลหลัก (ST2-T01) — เก็บ cursor ของหน้าที่เดินผ่านเพื่อย้อนกลับได้
 * (API ไม่มี offset — docs/01 §5.1) · เปลี่ยนตัวกรอง/ขนาดหน้า = กลับหน้าแรก
 * `fetchPage` รับ query มาตรฐาน (limit, cursor, sort) + ตัวกรองของหน้า
 * `enabled: false` = ตัวกรองขัดกันเอง (เช่น แท็บรถร่วม + เจ้าของ "บริษัท") → ไม่ยิง API, ตารางว่าง
 *   ตัวกรอง + enabled หน่วงเวลาเป็นค่าเดียวกัน · ระหว่างรอ (pending) / แสดงข้อมูลชุดเก่า → `loading` และไม่มียอดรวม
 * `page.total` มีค่าเมื่อรู้ยอดรวมแน่นอน (เคยเดินถึงหน้าสุดท้ายของตัวกรองนี้) — ย้อนหน้ากลับยอดไม่หาย
 * `persist` = จำหน้า/cursor ใน sessionStorage (กลับจากหน้าอื่นอยู่หน้าเดิม)
 */
export function useCursorList<R>(
  key: string,
  filters: Record<string, string>,
  fetchPage: (q: Record<string, string | number>) => Promise<CursorPage<R>>,
  opts: { size?: number; sort?: string; enabled?: boolean; persist?: string } = {},
) {
  const want = { f: filters, on: opts.enabled ?? true };
  const wantKey = JSON.stringify(want);
  const fkey = useDebounced(wantKey);
  const debounced = JSON.parse(fkey) as typeof want;
  const pending = fkey !== wantKey;
  const enabled = debounced.on;
  const saved = useRef<Persisted | undefined>(undefined);
  if (saved.current === undefined) {
    const p = readSession<Persisted>(opts.persist);
    saved.current = p && p.k === wantKey ? p : ({ k: '' } as Persisted);
  }
  const restored = saved.current.k ? saved.current : undefined;
  // ค่าเริ่มต้นตามต้นแบบ: 10 แถวต่อหน้า, เรียงตามรหัส
  const [size, setSize] = useState(restored?.size ?? opts.size ?? 10);
  const [cursors, setCursors] = useState<(string | undefined)[]>(
    restored?.cursors.map((c) => c ?? undefined) ?? [undefined],
  );
  const [index, setIndex] = useState(restored?.index ?? 0);
  const [known, setKnown] = useState<{ k: string; total: number } | null>(
    restored?.total !== undefined ? { k: `${fkey}|${restored.size}`, total: restored.total } : null,
  );
  const resetKey = `${fkey}|${size}`;
  const lastReset = useRef(resetKey);
  useEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    setCursors([undefined]);
    setIndex(0);
  }, [resetKey]);
  const clean = Object.fromEntries(Object.entries(debounced.f).filter(([, v]) => v !== ''));
  const q = useQuery({
    queryKey: [key, 'list', size, fkey, cursors[index]],
    placeholderData: keepPreviousData,
    enabled,
    queryFn: () =>
      fetchPage({
        limit: size,
        sort: opts.sort ?? 'code',
        ...clean,
        ...(cursors[index] ? { cursor: cursors[index]! } : {}),
      }),
  });
  const stale = pending || q.isPlaceholderData;
  const rowsOnPage = enabled && !pending ? (q.data?.data.length ?? 0) : 0;
  // ยอดรวมรู้แน่เฉพาะเมื่อเดินถึงหน้าสุดท้าย (API ไม่มี count — docs/01 §5.1) — จำไว้ต่อชุดตัวกรอง
  // (เดิมแสดงจำนวนแถวในหน้าเป็นยอดรวม "10 รายการ" ผิด — QA ST2-T06)
  const reached =
    enabled && q.data && !stale && !q.isError && !q.data.hasMore
      ? index * size + rowsOnPage
      : undefined;
  useEffect(() => {
    if (reached !== undefined && (known?.k !== resetKey || known.total !== reached))
      setKnown({ k: resetKey, total: reached });
  }, [reached, resetKey, known]);
  const total = pending
    ? undefined
    : !enabled
      ? 0
      : q.isError
        ? undefined
        : (reached ?? (known?.k === resetKey ? known.total : undefined));
  useEffect(() => {
    writeSession(opts.persist, {
      k: wantKey,
      size,
      cursors: cursors.map((c) => c ?? null),
      index,
      ...(total !== undefined ? { total } : {}),
    } satisfies Persisted);
  }, [opts.persist, wantKey, size, cursors, index, total]);
  return {
    q,
    rows: enabled && !pending ? (q.data?.data ?? []) : [],
    /** กำลังโหลด หรือยังแสดงข้อมูลของตัวกรองเดิม */
    loading: enabled && (pending || q.isLoading || q.isPlaceholderData),
    page: {
      index,
      size,
      hasNext: enabled && !stale && !!q.data?.hasMore,
      visited: cursors.length,
      rowsOnPage,
      ...(total !== undefined ? { total } : {}),
    },
    setSize,
    next: () => {
      const c = q.data?.nextCursor;
      if (!c || stale) return;
      setCursors((cs) => (cs.length > index + 1 ? cs : [...cs, c]));
      setIndex((i) => i + 1);
    },
    prev: () => setIndex((i) => Math.max(0, i - 1)),
    goto: (i: number) => setIndex(i),
  };
}

/**
 * ยอดรวมที่หน้าจอแสดง ("N รายการ" + "จาก N" ใน pager) — ใช้ร่วมทุกหน้ารายการ (review ST2-T07)
 * - ตัวกรองที่ใช้อยู่ทั้งหมดเป็นตัวกรองที่ตัวนับ (summary/แท็บ) ครอบไว้ (`counted`) → ใช้ `count`
 * - มีตัวกรองอื่นด้วย → ยอดจากรายการเมื่อรู้แน่ (ถึงหน้าสุดท้าย) เท่านั้น
 * - รายการ error → ไม่แสดง
 */
export function listTotal<F extends object>(
  list: { q: { isError: boolean }; page: { total?: number } },
  filters: F,
  counted: readonly string[],
  count: number | undefined,
): number | undefined {
  if (list.q.isError) return undefined;
  const onlyCounted = Object.entries(filters).every(
    ([k, v]) => v === '' || v === undefined || counted.includes(k),
  );
  return onlyCounted && count !== undefined ? count : list.page.total;
}
