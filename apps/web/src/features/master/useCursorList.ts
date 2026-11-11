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
 */
export function useCursorList<R>(
  key: string,
  filters: Record<string, string>,
  fetchPage: (q: Record<string, string | number>) => Promise<CursorPage<R>>,
) {
  const [size, setSize] = useState(20);
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
    queryFn: () =>
      fetchPage({
        limit: size,
        sort: '-updatedAt',
        ...clean,
        ...(cursors[index] ? { cursor: cursors[index]! } : {}),
      }),
  });
  return {
    q,
    rows: q.data?.data ?? [],
    page: {
      index,
      size,
      hasNext: !!q.data?.hasMore,
      visited: cursors.length,
      rowsOnPage: q.data?.data.length ?? 0,
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
