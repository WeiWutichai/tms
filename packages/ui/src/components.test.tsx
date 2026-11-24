import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Field,
  KpiCard,
  RouteChip,
  StatusTabs,
  TextInput,
} from './components';
import { DataTable, StatusDot, type Column } from './DataTable';
import { useModalFocus } from './focus';

const labels = {
  columns: 'คอลัมน์',
  options: 'ตัวเลือก',
  shownColumns: 'คอลัมน์ที่แสดง',
  tableOptions: 'ตัวเลือกตาราง',
  showFilters: 'แสดงแถวตัวกรอง',
  dense: 'แถวกะทัดรัด (44px)',
  selectRow: 'เลือก',
  exportCsv: 'ส่งออก CSV',
  resetColumns: 'คืนค่าเริ่มต้น',
  rowsPerPage: 'แถวต่อหน้า',
  selected: (n: number) => `เลือก ${n} รายการ`,
  clearSelection: 'ยกเลิกการเลือก',
  rowActions: 'การกระทำ',
  prev: 'ก่อนหน้า',
  next: 'ถัดไป',
  range: (a: number, b: number) => `${a}–${b}`,
  none: '0 รายการ',
};

describe('Button', () => {
  it('ใช้ class ตาม variant และแสดงไอคอน', () => {
    render(
      <Button variant="primary" icon="truck">
        จัดรถ
      </Button>,
    );
    const b = screen.getByRole('button', { name: 'จัดรถ' });
    expect(b).toHaveClass('tms-btn', 'tms-btn--primary');
    expect(b.querySelector('svg')).not.toBeNull();
    expect(b).toHaveAttribute('type', 'button');
  });
});

describe('Badge / StatusDot', () => {
  it('สีและไอคอนมาจากตารางสถานะของต้นแบบ', () => {
    render(<Badge label="รอกำหนดเส้นทาง" />);
    const el = screen.getByText('รอกำหนดเส้นทาง');
    expect(el).toHaveStyle({ background: '#FCF0DC', color: '#8F5500' });
  });
  it('ป้ายที่ไม่รู้จัก → โทน off เหมือนต้นแบบ', () => {
    render(<StatusDot label="ป้ายแปลก" />);
    expect(screen.getByText('ป้ายแปลก')).toHaveStyle({ color: '#3B424C' });
  });
});

describe('Field + TextInput', () => {
  it('มี error → aria-invalid และแสดงข้อความ', () => {
    render(
      <Field label="เลขผู้เสียภาษี" error="เลขไม่ถูกต้อง">
        {(a) => <TextInput {...a} />}
      </Field>,
    );
    const input = screen.getByLabelText(/เลขผู้เสียภาษี/);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('เลขไม่ถูกต้อง')).toHaveClass('tms-field-error');
  });
});

describe('StatusTabs', () => {
  it('แสดงตัวนับและเปลี่ยนแท็บ', () => {
    const onChange = vi.fn();
    render(
      <StatusTabs
        items={[
          { key: 'all', label: 'ทั้งหมด', count: 12 },
          { key: 'route', label: 'รอกำหนดเส้นทาง', count: 5 },
        ]}
        value="all"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('tab', { name: /ทั้งหมด/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /รอกำหนดเส้นทาง/ }));
    expect(onChange).toHaveBeenCalledWith('route');
  });
});

describe('KpiCard', () => {
  it('โทนเตือน: แถบซ้ายและตัวเลขสีเดียวกัน', () => {
    const { container } = render(
      <KpiCard
        label="รอกำหนดเส้นทาง"
        value="5"
        tone="warn"
        sub="คลิกเพื่อกรองตาราง"
        onClick={() => {}}
      />,
    );
    expect(container.querySelector('.tms-kpi__bar')).toHaveStyle({ background: '#8F5500' });
    expect(screen.getByText('5')).toHaveStyle({ color: '#8F5500' });
  });
});

describe('RouteChip / EmptyState', () => {
  it('render ครบ', () => {
    render(
      <>
        <RouteChip from="กรุงเทพ" to="ชลบุรี" />
        <EmptyState title="ไม่พบรายการ" description="ลองล้างตัวกรอง" />
      </>,
    );
    expect(screen.getByText(/กรุงเทพ/)).toHaveTextContent('กรุงเทพชลบุรี');
    expect(screen.getByText('ไม่พบรายการ')).toHaveClass('tms-empty__t');
  });
});

describe('Drawer', () => {
  it('กด Escape หรือปุ่มปิด → onClose; เมนู ⋯ เรียกคำสั่ง', () => {
    const onClose = vi.fn();
    const act = vi.fn();
    render(
      <Drawer
        open
        onClose={onClose}
        kind="นิติบุคคล"
        title="บริษัท ก"
        labels={{ close: 'ปิด', more: 'เพิ่มเติม' }}
        menu={[{ label: 'ปิดใช้งาน', icon: 'ban', onClick: act }]}
      >
        เนื้อหา
      </Drawer>,
    );
    fireEvent.click(screen.getByLabelText('เพิ่มเติม'));
    fireEvent.click(screen.getByRole('menuitem', { name: /ปิดใช้งาน/ }));
    expect(act).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('ปิด'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Drawer — focus (ST9-T20)', () => {
  it('มีชื่อ dialog = เลขในหัว · เปิดแล้ว focus เข้า drawer · ปิดแล้ว focus กลับปุ่มที่เปิด', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            เปิด
          </button>
          <Drawer
            open={open}
            onClose={() => setOpen(false)}
            kind="ใบสั่งขนส่ง"
            title="SO-0001"
            labels={{ close: 'ปิด', more: 'เพิ่มเติม' }}
          >
            <button type="button">ในดรอว์เออร์</button>
          </Drawer>
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'เปิด' });
    opener.focus();
    fireEvent.click(opener);
    const d = screen.getByRole('dialog', { name: 'SO-0001' });
    expect(d.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('useModalFocus — dialog ซ้อนนอก drawer (ST9-T20 review H)', () => {
  function Stacked({ managed }: { managed: boolean }) {
    const [dlg, setDlg] = useState(false);
    function PageDialog() {
      const ref = useRef<HTMLDivElement>(null);
      useModalFocus(managed, ref);
      return (
        <div ref={ref} role="dialog" aria-modal="true" aria-label="แม่แบบ" tabIndex={-1}>
          <input aria-label="ชื่อแม่แบบ" />
          <button type="button">บันทึก</button>
        </div>
      );
    }
    return (
      <>
        <Drawer
          open
          onClose={() => undefined}
          kind="ใบสั่งขนส่ง"
          title="SO-0001"
          labels={{ close: 'ปิด', more: 'เพิ่มเติม' }}
        >
          {/* ปุ่มเปิด dialog หายไปหลังกด (เหมือนรายการในเมนู ⋯) */}
          {!dlg && (
            <button type="button" onClick={() => setDlg(true)}>
              บันทึกเป็นแม่แบบ
            </button>
          )}
        </Drawer>
        {dlg && <PageDialog />}
        {dlg && (
          <button type="button" onClick={() => setDlg(false)}>
            ปิดแม่แบบ
          </button>
        )}
      </>
    );
  }
  const tab = (shift = false) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: shift });

  it('dialog ที่ไม่ใช้ hook (เปิดทีหลัง นอก aside): Tab ไม่ถูกดึงกลับเข้า drawer', () => {
    render(<Stacked managed={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกเป็นแม่แบบ' }));
    const save = screen.getByRole('button', { name: 'บันทึก' });
    save.focus();
    expect(tab()).toBe(true); // ไม่ preventDefault = เบราว์เซอร์ย้าย focus ตามปกติ
    expect(document.activeElement).toBe(save);
  });

  it('dialog ที่ใช้ hook: Tab วนใน dialog ชั้นบน · ปิดแล้ว (ปุ่มเปิดหายไป) focus กลับ drawer', () => {
    render(<Stacked managed />);
    fireEvent.click(screen.getByRole('button', { name: 'บันทึกเป็นแม่แบบ' }));
    const d = screen.getByRole('dialog', { name: 'แม่แบบ' });
    expect(d.contains(document.activeElement)).toBe(true);
    screen.getByRole('button', { name: 'บันทึก' }).focus();
    expect(tab()).toBe(false);
    expect(document.activeElement).toBe(screen.getByLabelText('ชื่อแม่แบบ'));
    expect(tab(true)).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'บันทึก' }));
    fireEvent.click(screen.getByRole('button', { name: 'ปิดแม่แบบ' }));
    expect(screen.getByRole('dialog', { name: 'SO-0001' })).toBe(document.activeElement);
  });
});

describe('DataTable', () => {
  type R = { id: string; name: string; st: string };
  const cols: Column<R>[] = [
    {
      key: 'name',
      label: 'ชื่อ',
      filter: { type: 'text', placeholder: 'ค้นหา' },
      render: (r) => r.name,
    },
    { key: 'st', label: 'สถานะ', render: (r) => <StatusDot label={r.st} /> },
  ];
  const rows: R[] = [
    { id: 'a', name: 'บริษัท ก', st: 'ใช้งาน' },
    { id: 'b', name: 'บริษัท ข', st: 'ใช้งาน' },
  ];
  const base = {
    columns: cols,
    rows,
    rowId: (r: R) => r.id,
    labels,
    page: { index: 0, size: 20, hasNext: true, visited: 1, rowsOnPage: 2 },
  };

  it('แถวตัวกรอง, คลิกแถว, ช่วงรายการ, ปุ่มก่อนหน้าปิดที่หน้าแรก', () => {
    const onRow = vi.fn();
    const onFilter = vi.fn();
    const onNext = vi.fn();
    render(<DataTable {...base} onRowClick={onRow} onFilterChange={onFilter} onNext={onNext} />);
    fireEvent.change(screen.getByLabelText('ชื่อ'), { target: { value: 'ก' } });
    expect(onFilter).toHaveBeenCalledWith('name', 'ก');
    fireEvent.click(screen.getByText('บริษัท ข'));
    expect(onRow).toHaveBeenCalledWith(rows[1]);
    expect(screen.getByText('1–2')).toBeInTheDocument();
    expect(screen.getByLabelText('ก่อนหน้า')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('ถัดไป'));
    expect(onNext).toHaveBeenCalled();
  });

  it('ซ่อนคอลัมน์จากแผง "คอลัมน์" และปิดแถวตัวกรองจากแผง "ตัวเลือก"', () => {
    render(<DataTable {...base} />);
    fireEvent.click(screen.getByRole('button', { name: /คอลัมน์/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'สถานะ' }));
    expect(screen.queryByRole('columnheader', { name: 'สถานะ' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /ตัวเลือก/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'แสดงแถวตัวกรอง' }));
    expect(screen.queryByPlaceholderText('ค้นหา')).toBeNull();
  });

  it('ST9-T20: แถวที่คลิกได้ Tab ถึงและกด Enter/Space เปิดได้ — แถวที่ไม่มี onRowClick ไม่อยู่ในลำดับ Tab', () => {
    const onRow = vi.fn();
    const { unmount } = render(<DataTable {...base} onRowClick={onRow} />);
    const row = screen.getByRole('row', { name: /บริษัท ก/ });
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onRow).toHaveBeenCalledTimes(2);
    expect(onRow).toHaveBeenCalledWith(rows[0]);
    // Enter บนปุ่ม/ช่องในแถว ไม่เปิดแถวซ้ำ
    fireEvent.keyDown(screen.getAllByRole('checkbox', { name: 'เลือก' })[0]!, { key: 'Enter' });
    expect(onRow).toHaveBeenCalledTimes(2);
    unmount();
    render(<DataTable {...base} />);
    expect(screen.getByRole('row', { name: /บริษัท ก/ })).not.toHaveAttribute('tabindex');
  });

  it('เลือกหลายแถว → แถบ bulk แสดงจำนวน', () => {
    const run = vi.fn();
    render(<DataTable {...base} bulkActions={[{ label: 'ส่งออก', icon: 'download', run }]} />);
    // ST9-T20: ชื่อช่องเลือก "เลือก" + คำอธิบาย = ข้อความคอลัมน์แรก (ไม่ใช่ id ภายใน)
    const boxes = screen.getAllByRole('checkbox', { name: 'เลือก' });
    expect(boxes[0]).toHaveAccessibleDescription('บริษัท ก');
    expect(boxes[1]).toHaveAccessibleDescription('บริษัท ข');
    // ช่องตารางของ checkbox ไม่ชื่อซ้ำกับคอลัมน์แรก
    expect(screen.getAllByRole('cell', { name: 'บริษัท ก' })).toHaveLength(1);
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[1]!);
    expect(screen.getByText('เลือก 2 รายการ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /ส่งออก/ }));
    expect(run).toHaveBeenCalledWith(['a', 'b']);
  });

  it('bulk: clearOnRun ล้างการเลือกหลังกด · disabled ปิดปุ่ม · pageScopedSelection ตัดแถวที่ไม่อยู่ในหน้า', () => {
    const run = vi.fn();
    const { rerender } = render(
      <DataTable
        {...base}
        pageScopedSelection
        bulkActions={[{ label: 'ส่งซ้ำ', icon: 'refresh-cw', run, clearOnRun: true }]}
      />,
    );
    const boxes = screen.getAllByRole('checkbox', { name: 'เลือก' });
    fireEvent.click(boxes[0]!);
    fireEvent.click(screen.getByRole('button', { name: /ส่งซ้ำ/ }));
    expect(run).toHaveBeenCalledWith(['a']);
    expect(screen.queryByText(/เลือก 1 รายการ/)).toBeNull();
    // เลือก 2 แถว แล้วหน้าเปลี่ยน (เหลือแถว b) → การเลือกเหลือเฉพาะ b
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'เลือก' })[0]!);
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'เลือก' })[1]!);
    rerender(
      <DataTable
        {...base}
        rows={rows.slice(1)}
        pageScopedSelection
        bulkActions={[
          { label: 'ส่งซ้ำ', icon: 'refresh-cw', run, clearOnRun: true, disabled: true },
        ]}
      />,
    );
    expect(screen.getByText('เลือก 1 รายการ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ส่งซ้ำ/ })).toBeDisabled();
  });

  it('selectable=false → ไม่มีช่องเลือกแถว (ผู้ใช้ไม่มี bulk action — QA ST2-T19)', () => {
    render(<DataTable {...base} selectable={false} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

describe('FormField ใน FormDrawer (QA ST2-T11)', () => {
  it('error ของช่องหายเมื่อผู้ใช้แก้ช่องนั้น และกลับมาเมื่อกดบันทึกใหม่; คำแนะนำแสดงใต้ error', async () => {
    const { FormDrawer, FormField } = await import('./master');
    const ui = (submit = () => undefined) => (
      <FormDrawer
        open
        title="ฟอร์ม"
        onClose={() => undefined}
        closeLabel="ปิด"
        footer={<button type="submit">บันทึก</button>}
        onSubmit={submit}
      >
        <FormField label="ชื่อ" error="มีรายการนี้แล้ว" hint="ไม่ซ้ำ">
          {(p) => <input {...p} defaultValue="ก" />}
        </FormField>
      </FormDrawer>
    );
    render(ui());
    expect(screen.getByText('มีรายการนี้แล้ว')).toBeTruthy();
    expect(screen.getByText('ไม่ซ้ำ')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('ชื่อ'), { target: { value: 'ข' } });
    expect(screen.queryByText('มีรายการนี้แล้ว')).toBeNull();
    expect(screen.getByLabelText('ชื่อ').getAttribute('aria-invalid')).toBe('false');
    fireEvent.click(screen.getByText('บันทึก'));
    expect(screen.getByText('มีรายการนี้แล้ว')).toBeTruthy();
  });
});

describe('FormDrawer — focus ช่องแรกที่ผิดหลังกดบันทึก (ST9-T20 QA M-1)', () => {
  it('validation ทันที และ error จาก API ที่ตามมา → focus ช่องแรกที่ aria-invalid; error ผูกด้วย aria-describedby', async () => {
    const { FormDrawer, FormField } = await import('./master');
    function Form() {
      const [errs, setErrs] = useState<Record<string, string>>({});
      return (
        <FormDrawer
          open
          title="ฟอร์ม"
          onClose={() => undefined}
          closeLabel="ปิด"
          footer={<button type="submit">บันทึก</button>}
          onSubmit={() => setErrs({ b: 'กรุณากรอก ข', c: 'กรุณากรอก ค' })}
        >
          <FormField label="ก">{(p) => <input {...p} />}</FormField>
          <FormField label="ข" error={errs.b}>
            {(p) => <input {...p} />}
          </FormField>
          <FormField label="ค" error={errs.c}>
            {(p) => <input {...p} />}
          </FormField>
        </FormDrawer>
      );
    }
    render(<Form />);
    fireEvent.click(screen.getByRole('button', { name: 'บันทึก' }));
    const b = screen.getByLabelText('ข');
    expect(document.activeElement).toBe(b);
    expect(b).toHaveAccessibleDescription('กรุณากรอก ข');
  });
});
