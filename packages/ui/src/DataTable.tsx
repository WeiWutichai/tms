import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { tone as toneColors, type Tone } from './tokens';
import { statusOf } from './status-map';

/**
 * ตารางมาตรฐาน — พอร์ตจาก template `T.*` ของหน้าจริงใน TMS v4 (ไม่ใช่ตารางตัวอย่างในหน้า design system)
 * - แถวตัวกรองใต้หัวคอลัมน์ (เปิด/ปิดได้ในแผง "ตัวเลือก")
 * - rail ขวา: "คอลัมน์" (เลือกคอลัมน์) / "ตัวเลือก" (แถวตัวกรอง, แถวกะทัดรัด 44px, ส่งออก CSV)
 * - เลือกหลายแถว → แถบ bulk action
 * - ส่วนท้าย: แถวต่อหน้า 10/20/50, ช่วงรายการ, ปุ่มก่อนหน้า/ถัดไป + เลขหน้า
 *   ⚠ API ใช้ cursor (docs/01 §5.1) — เลขหน้าแสดงเฉพาะหน้าที่เดินผ่านแล้ว (ดู spec/12 §3 รายการ "ตาราง: เลขหน้า vs cursor")
 */
export interface Column<R> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  filter?:
    | { type: 'text'; placeholder?: string }
    | { type: 'select'; options: { value: string; label: string }[] };
  hiddenByDefault?: boolean;
  render: (row: R) => ReactNode;
  csv?: (row: R) => string;
}

export interface TableLabels {
  columns: string;
  options: string;
  shownColumns: string;
  tableOptions: string;
  showFilters: string;
  dense: string;
  exportCsv: string;
  resetColumns: string;
  rowsPerPage: string;
  selected: (n: number) => string;
  clearSelection: string;
  rowActions: string;
  prev: string;
  next: string;
  range: (from: number, to: number) => string;
  /** "x–y จาก N" เมื่อรู้ยอดรวม (page.total) */
  rangeOf?: (from: number, to: number, total: number) => string;
  none: string;
}

export interface DataTableProps<R> {
  columns: Column<R>[];
  rows: R[];
  rowId: (r: R) => string;
  labels: TableLabels;
  activeId?: string | null;
  onRowClick?: (r: R) => void;
  filters?: Record<string, string>;
  onFilterChange?: (key: string, value: string) => void;
  bulkActions?: { label: string; icon: string; run: (ids: string[]) => void }[];
  rowMenu?: (r: R) => { label: string; icon: string; run: () => void }[];
  empty?: ReactNode;
  loading?: boolean;
  /** paging แบบ cursor */
  page: {
    index: number;
    size: number;
    hasNext: boolean;
    visited: number;
    rowsOnPage: number;
    /** ยอดรวมทั้งหมด (ถ้ารู้ — เช่นจาก summary) แสดง "จาก N" */
    total?: number;
  };
  /**
   * ส่งออก CSV ในแผง "ตัวเลือก": ไม่ส่ง = ส่งออกแถวในหน้านี้จากฝั่งเบราว์เซอร์,
   * ฟังก์ชัน = ให้หน้าเรียก API ส่งออกเอง (ครบทุกแถว + ตรวจสิทธิ์ export), false = ซ่อน (ไม่มีสิทธิ์)
   */
  onExportCsv?: (() => void) | false;
  onPageSize?: (n: number) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onGoto?: (index: number) => void;
}

export function StatusDot({ label, tone }: { label: string; tone?: Tone }) {
  const t = toneColors[tone ?? statusOf(label).tone];
  return (
    <span className="tms-status-dot" style={{ color: t.c }}>
      <span style={{ background: t.c }} />
      {label}
    </span>
  );
}

export function DocNo({ children }: { children: ReactNode }) {
  return <span className="tms-docno">{children}</span>;
}

export function DataTable<R>(p: DataTableProps<R>) {
  const [hidden, setHidden] = useState<string[]>(() =>
    p.columns.filter((c) => c.hiddenByDefault).map((c) => c.key),
  );
  const [panel, setPanel] = useState<null | 'cols' | 'opts'>(null);
  const [showFilters, setShowFilters] = useState(true);
  const [dense, setDense] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const visible = p.columns.filter((c) => !hidden.includes(c.key));
  const ids = useMemo(() => p.rows.map(p.rowId), [p.rows, p.rowId]);
  const allOn = ids.length > 0 && ids.every((i) => sel.includes(i));

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const from = p.page.rowsOnPage ? p.page.index * p.page.size + 1 : 0;
  const to = p.page.index * p.page.size + p.page.rowsOnPage;

  const exportCsv = () => {
    if (p.onExportCsv) return p.onExportCsv();
    // กัน formula injection (ค่าเริ่มด้วย = + - @ tab CR → เติม ') เหมือน export ฝั่ง API
    const esc = (raw: string) => {
      const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const lines = [visible.map((c) => esc(c.label)).join(',')];
    for (const r of p.rows)
      lines.push(visible.map((c) => esc(c.csv ? c.csv(r) : String(c.render(r) ?? ''))).join(','));
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'export.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="tms-table-wrap" style={{ ['--row-h' as string]: dense ? '44px' : '52px' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {sel.length > 0 && p.bulkActions && (
          <div className="tms-bulk">
            <span className="tms-bulk__n">{p.labels.selected(sel.length)}</span>
            {p.bulkActions.map((b) => (
              <button
                key={b.label}
                type="button"
                className="tms-btn tms-btn--secondary tms-btn--sm"
                onClick={() => b.run(sel)}
              >
                <Icon n={b.icon} s={16} />
                {b.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSel([])}
              style={{
                marginLeft: 'auto',
                height: 32,
                border: 0,
                background: 'transparent',
                color: '#3B424C',
                cursor: 'pointer',
                padding: '0 8px',
              }}
            >
              {p.labels.clearSelection}
            </button>
          </div>
        )}
        <div className="tms-table-scroll">
          <table className="tms-table">
            <thead>
              <tr>
                <th className="tms-check">
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={() => setSel(allOn ? [] : ids)}
                    aria-label={p.labels.selected(ids.length)}
                  />
                </th>
                {visible.map((c) => (
                  <th key={c.key} style={{ width: c.width, textAlign: c.align ?? 'left' }}>
                    {c.label}
                  </th>
                ))}
                <th style={{ width: 52 }} />
              </tr>
              {showFilters && (
                <tr className="tms-filters">
                  <th />
                  {visible.map((c) => (
                    <th key={c.key}>
                      {c.filter?.type === 'text' && (
                        <input
                          className="tms-filter-input"
                          value={p.filters?.[c.key] ?? ''}
                          placeholder={c.filter.placeholder}
                          aria-label={c.label}
                          onChange={(e) => p.onFilterChange?.(c.key, e.target.value)}
                        />
                      )}
                      {c.filter?.type === 'select' && (
                        <select
                          className="tms-filter-input"
                          style={{ padding: '0 6px' }}
                          value={p.filters?.[c.key] ?? ''}
                          aria-label={c.label}
                          onChange={(e) => p.onFilterChange?.(c.key, e.target.value)}
                        >
                          {c.filter.options.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </th>
                  ))}
                  <th />
                </tr>
              )}
            </thead>
            <tbody>
              {p.rows.map((r) => {
                const id = p.rowId(r);
                const menu = p.rowMenu?.(r) ?? [];
                return (
                  <tr key={id} aria-selected={p.activeId === id} onClick={() => p.onRowClick?.(r)}>
                    <td className="tms-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={sel.includes(id)}
                        onChange={() =>
                          setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
                        }
                        aria-label={id}
                      />
                    </td>
                    {visible.map((c) => (
                      <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                        {c.render(r)}
                      </td>
                    ))}
                    <td className="tms-act" onClick={(e) => e.stopPropagation()}>
                      {menu.length > 0 && (
                        <button
                          type="button"
                          className="tms-rowmenu-btn"
                          title={p.labels.rowActions}
                          aria-label={p.labels.rowActions}
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuFor(menuFor === id ? null : id);
                          }}
                        >
                          <Icon n="ellipsis-vertical" s={18} />
                        </button>
                      )}
                      {menuFor === id && (
                        <div className="tms-rowmenu" style={{ top: 44 }} role="menu">
                          {menu.map((m) => (
                            <button key={m.label} type="button" role="menuitem" onClick={m.run}>
                              <Icon n={m.icon} s={16} style={{ color: '#59606B' }} />
                              {m.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!p.loading && p.rows.length === 0 && <div className="tms-table-empty">{p.empty}</div>}
        </div>
        <div className="tms-pager">
          <label>
            {p.labels.rowsPerPage}
            <select
              value={String(p.page.size)}
              onChange={(e) => p.onPageSize?.(Number(e.target.value))}
            >
              {['10', '20', '50'].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <span className="tms-pager__range">
            {p.page.rowsOnPage
              ? p.page.total !== undefined && p.labels.rangeOf
                ? p.labels.rangeOf(from, to, p.page.total)
                : p.labels.range(from, to)
              : p.labels.none}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="tms-pager__nav"
              disabled={p.page.index === 0}
              onClick={p.onPrev}
              aria-label={p.labels.prev}
            >
              <Icon n="chevron-left" s={16} />
            </button>
            {Array.from({ length: Math.max(p.page.visited, p.page.index + 1) }, (_, i) => (
              <button
                key={i}
                type="button"
                className="tms-pager__page"
                aria-current={i === p.page.index ? 'page' : undefined}
                onClick={() => p.onGoto?.(i)}
              >
                {i + 1}
              </button>
            ))}
            <button
              type="button"
              className="tms-pager__nav"
              disabled={!p.page.hasNext}
              onClick={p.onNext}
              aria-label={p.labels.next}
            >
              <Icon n="chevron-right" s={16} />
            </button>
          </div>
        </div>
      </div>
      {panel === 'cols' && (
        <div className="tms-sidepanel">
          <div className="tms-sidepanel__t">{p.labels.shownColumns}</div>
          {p.columns.map((c) => (
            <label key={c.key}>
              <input
                type="checkbox"
                checked={!hidden.includes(c.key)}
                onChange={() =>
                  setHidden((h) =>
                    h.includes(c.key) ? h.filter((x) => x !== c.key) : [...h, c.key],
                  )
                }
              />
              {c.label}
            </label>
          ))}
          <button
            type="button"
            className="tms-sidepanel__link"
            onClick={() => setHidden(p.columns.filter((c) => c.hiddenByDefault).map((c) => c.key))}
          >
            {p.labels.resetColumns}
          </button>
        </div>
      )}
      {panel === 'opts' && (
        <div className="tms-sidepanel">
          <div className="tms-sidepanel__t">{p.labels.tableOptions}</div>
          <label>
            <input
              type="checkbox"
              checked={showFilters}
              onChange={() => setShowFilters((v) => !v)}
            />
            {p.labels.showFilters}
          </label>
          <label>
            <input type="checkbox" checked={dense} onChange={() => setDense((v) => !v)} />
            {p.labels.dense}
          </label>
          {p.onExportCsv !== false && (
            <button type="button" className="tms-sidepanel__link" onClick={exportCsv}>
              <Icon n="download" s={16} />
              {p.labels.exportCsv}
            </button>
          )}
        </div>
      )}
      <div className="tms-colrail">
        <button
          type="button"
          aria-pressed={panel === 'cols'}
          onClick={() => setPanel(panel === 'cols' ? null : 'cols')}
        >
          <Icon n="columns-3" s={16} />
          {p.labels.columns}
        </button>
        <button
          type="button"
          aria-pressed={panel === 'opts'}
          onClick={() => setPanel(panel === 'opts' ? null : 'opts')}
        >
          <Icon n="settings-2" s={16} />
          {p.labels.options}
        </button>
      </div>
    </div>
  );
}
