import { fireEvent, render, screen } from '@testing-library/react';
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

const labels = {
  columns: 'คอลัมน์',
  options: 'ตัวเลือก',
  shownColumns: 'คอลัมน์ที่แสดง',
  tableOptions: 'ตัวเลือกตาราง',
  showFilters: 'แสดงแถวตัวกรอง',
  dense: 'แถวกะทัดรัด (44px)',
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

  it('เลือกหลายแถว → แถบ bulk แสดงจำนวน', () => {
    const run = vi.fn();
    render(<DataTable {...base} bulkActions={[{ label: 'ส่งออก', icon: 'download', run }]} />);
    fireEvent.click(screen.getByLabelText('a'));
    fireEvent.click(screen.getByLabelText('b'));
    expect(screen.getByText('เลือก 2 รายการ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /ส่งออก/ }));
    expect(run).toHaveBeenCalledWith(['a', 'b']);
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
