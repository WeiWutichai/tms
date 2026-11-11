import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

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

/**
 * list แบบ cursor ที่ใช้ร่วมทุกหน้าข้อมูลหลัก (ST2-T01) — เก็บ cursor ของหน้าที่เดินผ่านเพื่อย้อนกลับได้
 * (API ไม่มี offset — docs/01 §5.1) · เปลี่ยนตัวกรอง/ขนาดหน้า = กลับหน้าแรก
 * `fetchPage` รับ query มาตรฐาน (limit, cursor, sort) + ตัวกรองของหน้า
 * `enabled: false` = ตัวกรองขัดกันเอง (เช่น แท็บรถร่วม + เจ้าของ "บริษัท") → ไม่ยิง API, ตารางว่าง
 * `page.total` มีค่าเมื่อรู้ยอดรวมแน่นอน (ถึงหน้าสุดท้ายแล้ว) — หน้าจอใช้ตัวนับจาก summary แทนเมื่อไม่ได้กรองอื่น
 */
export function useCursorList<R>(
  key: string,
  filters: Record<string, string>,
  fetchPage: (q: Record<string, string | number>) => Promise<CursorPage<R>>,
  opts: { size?: number; sort?: string; enabled?: boolean } = {},
) {
  // ค่าเริ่มต้นตามต้นแบบ: 10 แถวต่อหน้า, เรียงตามรหัส
  const [size, setSize] = useState(opts.size ?? 10);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [index, setIndex] = useState(0);
  const debounced = useDebounced(filters);
  const fkey = JSON.stringify(debounced);
  useEffect(() => {
    setCursors([undefined]);
    setIndex(0);
  }, [fkey, size]);
  const clean = Object.fromEntries(Object.entries(debounced).filter(([, v]) => v !== ''));
  const q = useQuery({
    queryKey: [key, 'list', size, fkey, cursors[index]],
    placeholderData: keepPreviousData,
    enabled: opts.enabled ?? true,
    queryFn: () =>
      fetchPage({
        limit: size,
        sort: opts.sort ?? 'code',
        ...clean,
        ...(cursors[index] ? { cursor: cursors[index]! } : {}),
      }),
  });
  const enabled = opts.enabled ?? true;
  const rowsOnPage = enabled ? (q.data?.data.length ?? 0) : 0;
  // ยอดรวมรู้แน่เฉพาะเมื่อเดินถึงหน้าสุดท้าย (API ไม่มี count — docs/01 §5.1) — กรองแล้วยังไม่ถึงหน้าสุดท้าย = ไม่แสดงยอด
  // (เดิมแสดงจำนวนแถวในหน้าเป็นยอดรวม "10 รายการ" ผิด — QA ST2-T06)
  const total = !enabled
    ? 0
    : q.data && !q.isPlaceholderData && !q.data.hasMore
      ? index * size + rowsOnPage
      : undefined;
  return {
    q,
    rows: enabled ? (q.data?.data ?? []) : [],
    page: {
      index,
      size,
      hasNext: enabled && !!q.data?.hasMore,
      visited: cursors.length,
      rowsOnPage,
      ...(total !== undefined ? { total } : {}),
    },
    setSize,
    next: () => {
      const c = q.data?.nextCursor;
      if (!c) return;
      setCursors((cs) => (cs.length > index + 1 ? cs : [...cs, c]));
      setIndex((i) => i + 1);
    },
    prev: () => setIndex((i) => Math.max(0, i - 1)),
    goto: (i: number) => setIndex(i),
  };
}
