import { normalizeTaxId, parseImportDate, type ImportSpec, type RowIssue } from './import-spec';

interface SampleRow {
  code: string;
  name: string;
  taxId: string;
  startDate: string | null;
}

/**
 * spec ตัวอย่างสำหรับ dev/test เท่านั้น (ST1-T19) — entity จริงลงทะเบียนใน ST2-T23
 * ใช้ทดสอบ framework ทั้งเส้น (wizard, dry-run, ยืนยัน, job) โดยไม่เขียนตารางธุรกิจ: commit นับแถวอย่างเดียว
 */
export const SAMPLE_IMPORT_SPEC: ImportSpec<SampleRow> = {
  kind: 'sample',
  label: 'ข้อมูลตัวอย่าง',
  scope: 'settings:write',
  columns: [
    { key: 'code', header: 'รหัส', aliases: ['Code'], required: true, example: 'C001' },
    { key: 'name', header: 'ชื่อ', aliases: ['Name'], required: true, example: 'บจก. ตัวอย่าง' },
    {
      key: 'taxId',
      header: 'เลขผู้เสียภาษี',
      aliases: ['Tax ID'],
      required: true,
      example: '0000000000001',
      hint: 'ตัวเลข 13 หลัก',
    },
    { key: 'startDate', header: 'วันที่เริ่ม', aliases: ['Start'], example: '15/11/2569' },
  ],
  async validate(_ctx, rows) {
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const issues: RowIssue[] = [];
      const code = r.values.code!;
      if (!/^[A-Za-z0-9-]{1,20}$/.test(code))
        issues.push({
          column: 'code',
          code: 'invalid_format',
          message: 'รหัสใช้ได้เฉพาะ A–Z 0–9 และ - ไม่เกิน 20 ตัว',
        });
      const first = seen.get(code.toUpperCase());
      if (first)
        issues.push({
          column: 'code',
          code: 'duplicate_in_file',
          message: `รหัสซ้ำกับแถว ${first}`,
        });
      else seen.set(code.toUpperCase(), r.row);
      const tax = normalizeTaxId(r.values.taxId ?? '');
      if (tax.issue) issues.push({ column: 'taxId', ...tax.issue });
      let startDate: string | null = null;
      if (r.values.startDate) {
        startDate = parseImportDate(r.values.startDate);
        if (!startDate)
          issues.push({
            column: 'startDate',
            code: 'invalid_format',
            message: 'วันที่อ่านไม่ได้ ใช้ DD/MM/YYYY',
          });
      }
      const bad = issues.some((x) => (x.severity ?? 'error') === 'error');
      return {
        issues,
        ...(bad ? {} : { value: { code, name: r.values.name!, taxId: tax.value!, startDate } }),
      };
    });
  },
  async commit(_ctx, rows) {
    return rows.length;
  },
};
