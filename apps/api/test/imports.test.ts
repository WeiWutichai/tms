import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { JobQueue } from '../src/jobs/job-queue.service';
import { ImportRegistry, type ImportSpec } from '../src/modules/imports/import-spec';
import { normalizeTaxId, parseImportDate } from '../src/modules/imports/import-spec';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function xlsxOf(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('a');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** ST1-T19: ไฟล์ 1,000 แถวมีผิด 3 แถว → dry-run ระบุ 3 แถว + เหตุผล และไม่มีข้อมูลถูกเขียนจนกดยืนยัน */
describe('imports (ST1-T19)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tA: string;
  let tB: string;
  let admin: string;
  let planner: string;
  let otherAdmin: string;
  /** แถวที่ spec ทดสอบเขียนจริง (ตรวจว่า dry-run ไม่เรียก commit) */
  const written: string[] = [];

  async function member(tenantId: string, email: string, role: string) {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: { tenantId, email, name: email, status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles[role]! } });
    return u.id;
  }
  const as = async (
    tenantId: string,
    userId: string,
    scope = 'settings:write documents:write documents:read',
  ) => api(app, await tokenFor(tenantId, scope, userId));

  async function upload(
    a: Awaited<ReturnType<typeof as>>,
    data: Buffer,
    mime = XLSX,
    filename = 'ลูกค้า.xlsx',
  ): Promise<string> {
    const r = await a
      .post('/v1/documents')
      .send({ kind: 'IMPORT', mime, bytes: data.length, filename })
      .expect(201);
    const u = new URL(r.body.uploadUrl);
    await request(app.getHttpServer())
      .put(u.pathname + u.search)
      .set('Content-Type', 'application/octet-stream')
      .send(data)
      .expect(200);
    return r.body.id;
  }

  const TEST_SPEC: ImportSpec<{ code: string }> = {
    kind: 'test_items',
    label: 'รายการทดสอบ',
    scope: 'settings:write',
    modes: ['create_only', 'upsert_by_code'],
    columns: [
      { key: 'code', header: 'รหัส', aliases: ['Code'], required: true },
      { key: 'taxId', header: 'เลขผู้เสียภาษี', aliases: ['Tax ID'], required: true },
    ],
    async validate(_ctx, rows) {
      const seen = new Set<string>();
      return rows.map((r) => {
        const tax = normalizeTaxId(r.values.taxId!);
        const issues = tax.issue ? [{ column: 'taxId', ...tax.issue }] : [];
        if (seen.has(r.values.code!))
          issues.push({ column: 'code', code: 'duplicate_in_file', message: 'รหัสซ้ำในไฟล์' });
        seen.add(r.values.code!);
        const bad = issues.some((x) => (x.severity ?? 'error') === 'error');
        return { issues, ...(bad ? {} : { value: { code: r.values.code! } }) };
      });
    },
    async commit(_ctx, rows) {
      for (const r of rows) written.push(r.value.code);
      return rows.length;
    },
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    app.get(ImportRegistry).register(TEST_SPEC);
    tA = (await createTenant(db, 'บริษัท เอ')).id;
    tB = (await createTenant(db, 'บริษัท บี')).id;
    admin = await member(tA, 'admin@imp.test', 'admin');
    planner = await member(tA, 'planner@imp.test', 'planner');
    otherAdmin = await member(tB, 'admin@imp-b.test', 'admin');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('1,000 แถว ผิด 3 แถว: dry-run บอก 3 แถว + เหตุผล ไม่เขียนจนยืนยัน; all_or_nothing ปิดการยืนยัน; skip เขียน 997', async () => {
    const rows: unknown[][] = [['Code', 'Tax ID']];
    for (let i = 1; i <= 1000; i++)
      rows.push([`C${i}`, `00000000000${String(i % 100).padStart(2, '0')}`]);
    rows[101]![1] = '123'; // แถว 102 ในไฟล์
    rows[501]![1] = '1.05E+12'; // แถว 502
    rows[900]![0] = 'C5'; // แถว 901 รหัสซ้ำแถว 6
    const a = await as(tA, admin);
    const doc = await upload(a, await xlsxOf(rows));
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    expect(r).toMatchObject({
      status: 'validated',
      totalRows: 1000,
      okRows: 997,
      errorRows: 3,
      mapping: { code: 'Code', taxId: 'Tax ID' },
      headers: ['Code', 'Tax ID'],
      errorPolicy: 'all_or_nothing',
    });
    expect(r.id).toMatch(/^imp_/);
    expect(r.issues.map((x: { row: number }) => x.row)).toEqual([102, 502, 901]);
    expect(r.issues[0]).toMatchObject({
      column: 'เลขผู้เสียภาษี',
      value: '123',
      code: 'invalid_format',
    });
    expect(r.issues[1].message).toContain('วิทยาศาสตร์');
    expect(r.issues[2]).toMatchObject({ column: 'รหัส', code: 'duplicate_in_file' });
    expect(r.sample).toHaveLength(3);
    expect(r.sample[0]).toEqual({
      row: 2,
      values: { code: 'C1', taxId: '0000000000001' },
      error: false,
    });
    expect(written).toHaveLength(0);

    await a.post(`/v1/imports/${r.id}/commit`).expect(409);
    expect(written).toHaveLength(0);

    // รายงานแถวผิด .xlsx: หัวคอลัมน์เดิม + ผลตรวจ
    const rep = await a
      .get(`/v1/imports/${r.id}/errors`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(rep.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rep.body);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Code', 'Tax ID', 'ผลตรวจ']);
    expect(ws.rowCount).toBe(4);
    expect(String(ws.getRow(2).getCell(3).value)).toContain('เลขผู้เสียภาษี');

    const p = (
      await a.patch(`/v1/imports/${r.id}`).send({ errorPolicy: 'skip_invalid_rows' }).expect(200)
    ).body;
    expect(p).toMatchObject({ status: 'validated', errorRows: 3 });
    const c = (await a.post(`/v1/imports/${r.id}/commit`).expect(200)).body;
    expect(c).toMatchObject({ status: 'completed_with_errors', importedRows: 997 });
    expect(written).toHaveLength(997);
    await a.post(`/v1/imports/${r.id}/commit`).expect(409); // ซ้ำไม่ได้
    const audit = await db.auditLog.findFirst({ where: { action: 'import.completed' } });
    expect(audit?.after).toMatchObject({ kind: 'test_items', imported: 997, skipped: 3 });
  });

  it('จับคู่คอลัมน์เอง (PATCH) แล้วตรวจใหม่; ไม่จับคู่ช่องบังคับ → required', async () => {
    written.length = 0;
    const a = await as(tA, admin);
    const doc = await upload(
      a,
      await xlsxOf([
        ['A', 'B'],
        ['X1', '0000000000001'],
        ['X2', '0000000000002'],
      ]),
    );
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    expect(r).toMatchObject({ mapping: {}, errorRows: 2 });
    expect(r.issues[0]).toMatchObject({
      code: 'required',
      message: 'ไม่ได้จับคู่คอลัมน์ "รหัส" ซึ่งต้องกรอก',
    });
    const p = (
      await a
        .patch(`/v1/imports/${r.id}`)
        .send({ mapping: { code: 'A', taxId: 'B' } })
        .expect(200)
    ).body;
    expect(p).toMatchObject({ mapping: { code: 'A', taxId: 'B' }, errorRows: 0, okRows: 2 });
    expect((await a.post(`/v1/imports/${r.id}/commit`).expect(200)).body.status).toBe('completed');
    expect(written).toEqual(['X1', 'X2']);
  });

  it('CSV จาก Excel ไทย (TIS-620) อ่านภาษาไทยถูก; ไฟล์ผิดรูปแบบ → failed พร้อมเหตุผล', async () => {
    const a = await as(tA, admin);
    const tis = Buffer.concat([
      Buffer.from([0xc3, 0xcb, 0xd1, 0xca]), // "รหัส"
      Buffer.from(',Tax ID\r\nT1,0000000000001\r\n'),
    ]);
    const doc = await upload(a, tis, 'text/csv', 'a.csv');
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    expect(r.headers).toEqual(['รหัส', 'Tax ID']);
    expect(r).toMatchObject({ okRows: 1, mapping: { code: 'รหัส' } });

    const dup = await upload(a, Buffer.from('Code,Code\nA,B\n'), 'text/csv', 'b.csv');
    const f = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: dup }).expect(201)
    ).body;
    expect(f).toMatchObject({ status: 'failed', fileError: 'หัวคอลัมน์ "Code" ซ้ำกันในไฟล์' });
    await a.post(`/v1/imports/${f.id}/commit`).expect(409);
  });

  it('template .xlsx มีหัวคอลัมน์ไทย + sheet คำอธิบาย', async () => {
    const a = await as(tA, admin);
    const kinds = (await a.get('/v1/imports/kinds').expect(200)).body;
    expect(kinds.map((k: { kind: string }) => k.kind)).toContain('test_items');
    const t = await a
      .get('/v1/imports/kinds/test_items/template')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(t.status).toBe(200);
    expect(t.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(t.body);
    expect(wb.worksheets[0]!.getRow(1).values).toEqual([undefined, 'รหัส', 'เลขผู้เสียภาษี']);
    expect(wb.worksheets[1]!.name).toBe('คำอธิบาย');
  });

  it('สิทธิ์และการแยกข้อมูล: ไม่มี scope ของ entity → 404; ไฟล์/งานของ tenant อื่น → 404', async () => {
    const a = await as(tA, admin);
    const doc = await upload(
      a,
      await xlsxOf([
        ['Code', 'Tax ID'],
        ['Z', '0000000000001'],
      ]),
    );
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    const pl = await as(tA, planner, 'documents:write documents:read');
    await pl.get(`/v1/imports/${r.id}`).expect(404);
    await pl.get('/v1/imports/kinds/test_items/template').expect(404);
    expect((await pl.get('/v1/imports/kinds').expect(200)).body).toEqual([]);
    const b = await as(tB, otherAdmin);
    await b.get(`/v1/imports/${r.id}`).expect(404);
    await b.post(`/v1/imports/${r.id}/commit`).expect(404);
    // ไฟล์ของคนอื่น (แม้ tenant เดียวกัน) ใช้นำเข้าไม่ได้
    const other = await as(tA, planner);
    await other.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(422);
    await b.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(422);
    // ไฟล์ตารางใช้ kind อื่นไม่ได้ และ IMPORT รับ PDF ไม่ได้
    await a.post('/v1/documents').send({ kind: 'OTHER', mime: XLSX, bytes: 10 }).expect(422);
    await a
      .post('/v1/documents')
      .send({ kind: 'IMPORT', mime: 'application/pdf', bytes: 10 })
      .expect(422);
    // ประวัติ
    const list = (await a.get('/v1/imports').expect(200)).body;
    expect(list.data.length).toBeGreaterThan(0);
    expect((await b.get('/v1/imports').expect(200)).body.data).toEqual([]);
  });

  it('ไฟล์ใหญ่วิ่งเป็น job: ตรวจ → ยืนยัน → ผู้ทำได้แจ้งเตือน', async () => {
    written.length = 0;
    const a = await as(tA, admin);
    const rows: unknown[][] = [['Code', 'Tax ID']];
    for (let i = 1; i <= 1500; i++) rows.push([`B${i}-${'x'.repeat(150)}`, '0000000000001']);
    const doc = await upload(a, await xlsxOf(rows));
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    expect(r.status).toBe('validating');
    expect(r.jobId).toMatch(/^job_/);
    const queue = app.get(JobQueue);
    while (await queue.runOnce());
    const v = (await a.get(`/v1/imports/${r.id}`).expect(200)).body;
    expect(v).toMatchObject({ status: 'validated', totalRows: 1500, errorRows: 0 });
    const c = (await a.post(`/v1/imports/${r.id}/commit`).expect(200)).body;
    expect(c.status).toBe('importing');
    while (await queue.runOnce());
    expect((await a.get(`/v1/imports/${r.id}`).expect(200)).body).toMatchObject({
      status: 'completed',
      importedRows: 1500,
    });
    expect(written).toHaveLength(1500);
    const n = await db.notification.findMany({ where: { recipientId: admin, channel: 'in_app' } });
    expect(n.map((x) => x.body)).toEqual(
      expect.arrayContaining([
        'รายการทดสอบ (ลูกค้า.xlsx): ผ่าน 1,500 แถว ผิด 0 แถว — เปิดเพื่อยืนยันนำเข้า',
        'รายการทดสอบ (ลูกค้า.xlsx): นำเข้า 1,500 แถว',
      ]),
    );
  });

  it('job นำเข้าล้ม (ระบบขัดข้อง) → งานนำเข้าเป็น failed พร้อมเหตุผล ไม่ค้าง', async () => {
    const a = await as(tA, admin);
    const rows: unknown[][] = [['Code', 'Tax ID']];
    for (let i = 1; i <= 1200; i++) rows.push([`F${i}`, '0000000000001']);
    const doc = await upload(a, await xlsxOf(rows));
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    const queue = app.get(JobQueue);
    while (await queue.runOnce());
    await a.post(`/v1/imports/${r.id}/commit`).expect(200);
    const orig = TEST_SPEC.commit;
    TEST_SPEC.commit = async () => {
      throw new Error('db down');
    };
    try {
      while (await queue.runOnce());
    } finally {
      TEST_SPEC.commit = orig;
    }
    const g = (await a.get(`/v1/imports/${r.id}`).expect(200)).body;
    expect(g.status).toBe('failed');
    expect(g.fileError).toContain('ระบบขัดข้อง');
  });

  it('ยืนยันแล้วตรวจซ้ำพบแถวผิด (all_or_nothing) → ไม่เขียน คืน validated พร้อมผลใหม่', async () => {
    written.length = 0;
    const a = await as(tA, admin);
    const doc = await upload(
      a,
      await xlsxOf([
        ['Code', 'Tax ID'],
        ['R1', '0000000000001'],
      ]),
    );
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    const orig = TEST_SPEC.validate;
    TEST_SPEC.validate = async (_c, rows) =>
      rows.map(() => ({ issues: [{ code: 'duplicate_in_db', message: 'มีแล้วในระบบ' }] }));
    try {
      const c = (await a.post(`/v1/imports/${r.id}/commit`).expect(200)).body;
      expect(c).toMatchObject({ status: 'validated', errorRows: 1, importedRows: 0 });
      expect((await a.get(`/v1/imports/${r.id}`)).body.errorRows).toBe(1);
    } finally {
      TEST_SPEC.validate = orig;
    }
    expect(written).toHaveLength(0);
  });

  it('ยกเลิกต้องมีเหตุผลและลง audit', async () => {
    const a = await as(tA, admin);
    const doc = await upload(
      a,
      await xlsxOf([
        ['Code', 'Tax ID'],
        ['K1', '0000000000001'],
      ]),
    );
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    await a.post(`/v1/imports/${r.id}/cancel`).send({}).expect(422);
    expect(
      (await a.post(`/v1/imports/${r.id}/cancel`).send({ reason: 'ไฟล์ผิด' }).expect(200)).body
        .status,
    ).toBe('cancelled');
    const au = await db.auditLog.findFirst({ where: { action: 'import.cancelled' } });
    expect(au?.reason).toBe('ไฟล์ผิด');
    await a.post(`/v1/imports/${r.id}/commit`).expect(409);
  });

  it('CSV: บรรทัดว่างไม่นับเพดาน 5,000 แต่เกินจริงถูกปฏิเสธ; เลขแถวตาม record (newline ในเซลล์)', async () => {
    const { parseImportFile } = await import('../src/modules/imports/parse');
    const lines = ['Code,Tax ID'];
    for (let i = 1; i <= 5000; i++) {
      lines.push(`C${i},0000000000001`);
      if (i % 500 === 0) lines.push(',,');
    }
    const ok = await parseImportFile(Buffer.from(lines.join('\n')), 'text/csv');
    expect(ok.rows).toHaveLength(5000);
    await expect(
      parseImportFile(Buffer.from([...lines, 'X,1'].join('\n')), 'text/csv'),
    ).rejects.toThrow(/5,000/);
    const q = await parseImportFile(Buffer.from('a,b\n"x\ny",1\nz,2'), 'text/csv');
    expect(q.rowNumbers).toEqual([2, 3]);
    expect(q.rows[0]![0]).toBe('x\ny');
    // xlsx เกิน 5,000 แถว
    const big: unknown[][] = [['Code']];
    for (let i = 0; i < 5001; i++) big.push([`B${i}`]);
    await expect(
      parseImportFile(
        await xlsxOf(big),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).rejects.toThrow(/5,000/);
  });

  it('ไฟล์ผิดรูปแบบอื่น: มีแต่หัวคอลัมน์, เครื่องหมายคำพูดไม่ปิด, สูตรไม่มีค่า, จับคู่ซ้ำ', async () => {
    const { parseImportFile } = await import('../src/modules/imports/parse');
    await expect(parseImportFile(Buffer.from('Code,Tax ID\n'), 'text/csv')).rejects.toThrow(
      /ไม่มีแถวข้อมูล/,
    );
    await expect(parseImportFile(Buffer.from('a,b\nA1,"open\nA2,y\n'), 'text/csv')).rejects.toThrow(
      /ไม่ปิด/,
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('a');
    ws.addRow(['Code', 'Name']);
    ws.addRow(['F1', { formula: '1+1' } as unknown as ExcelJS.CellValue]);
    const p = await parseImportFile(
      Buffer.from(await wb.xlsx.writeBuffer()),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(p.rows[0]).toEqual(['F1', '']);
    const a = await as(tA, admin);
    const doc = await upload(
      a,
      await xlsxOf([
        ['Code', 'Tax ID'],
        ['M1', '0000000000001'],
      ]),
    );
    const r = (
      await a.post('/v1/imports').send({ kind: 'test_items', documentId: doc }).expect(201)
    ).body;
    await a
      .patch(`/v1/imports/${r.id}`)
      .send({ mapping: { code: 'Code', taxId: 'Code' } })
      .expect(422);
    await db.importJob.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await a.patch(`/v1/imports/${r.id}`).send({ errorPolicy: 'skip_invalid_rows' }).expect(409);
    expect((await a.get(`/v1/imports/${r.id}`)).body.status).toBe('expired');
  });

  it('xlsx: ขนาดหลังแตก zip อ่านจาก central directory (กัน zip bomb)', async () => {
    const { zipUncompressedSize } = await import('../src/modules/imports/parse');
    const buf = await xlsxOf([['a'], ['b']]);
    const n = zipUncompressedSize(buf);
    expect(n).toBeGreaterThan(buf.length);
    expect(zipUncompressedSize(Buffer.from('not a zip'))).toBeNull();
  });

  it('วันที่: ปี > 2400 = พ.ศ.; วันที่ไม่มีจริง → null', () => {
    expect(parseImportDate('15/11/2569')).toBe('2026-11-15');
    expect(parseImportDate('2026-11-15')).toBe('2026-11-15');
    expect(parseImportDate('15 พ.ย. 2569')).toBe('2026-11-15');
    expect(parseImportDate('31/02/2569')).toBeNull();
    expect(normalizeTaxId('000000000001').value).toBe('0000000000001');
    expect(normalizeTaxId('000000000001').issue?.severity).toBe('warning');
  });
});
