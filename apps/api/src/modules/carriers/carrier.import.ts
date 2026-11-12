import { iEquals } from '../../common/ilike';
import { ADDRESS_COLUMNS, readAddress, readBranch, readTaxId } from '../customers/customer.import';
import { byCode, defineMasterImport, group, put } from '../imports/master-import';
import { BANK_CODES, CreateCarrierDto, UpdateCarrierDto } from './carrier.dto';
import type { CarriersService } from './carriers.service';

const TYPES = {
  INDIVIDUAL: ['บุคคลธรรมดา', 'บุคคล'],
  JURISTIC: ['นิติบุคคล', 'บริษัท'],
};
const WHT = { '1.00': ['1%', '1'], '3.00': ['3%', '3'] };
/** ชื่อธนาคาร (เหมือนหน้าจอ car.bank.*) → รหัส */
const BANK_TH: Record<(typeof BANK_CODES)[number], string[]> = {
  KBANK: ['กสิกรไทย', 'กสิกร'],
  SCB: ['ไทยพาณิชย์'],
  BBL: ['กรุงเทพ'],
  KTB: ['กรุงไทย'],
  BAY: ['กรุงศรีอยุธยา', 'กรุงศรี'],
  TTB: ['ทีทีบี', 'ทหารไทยธนชาต'],
  GSB: ['ออมสิน'],
  BAAC: ['ธ.ก.ส.', 'ธกส'],
  GHB: ['อาคารสงเคราะห์', 'ธอส'],
  KKP: ['เกียรตินาคินภัทร'],
  CIMBT: ['ซีไอเอ็มบี ไทย', 'ซีไอเอ็มบี'],
  UOBT: ['ยูโอบี'],
  TISCO: ['ทิสโก้'],
  LHFG: ['แลนด์ แอนด์ เฮ้าส์'],
  ICBCT: ['ไอซีบีซี (ไทย)', 'ไอซีบีซี'],
  TCRB: ['ไทยเครดิต'],
  IBANK: ['อิสลามแห่งประเทศไทย'],
};
const label = (m: Record<string, string[]>) => Object.values(m).map((l) => l[0]!);

/**
 * ผู้รับเหมา / รถร่วม (ST2-T05) — POST/PATCH /v1/carriers
 * เลขบัตรประชาชน (บุคคลธรรมดา) และเลขบัญชี = ข้อมูลอ่อนไหว: service เข้ารหัส (FieldCipher) เหมือน API ·
 * รายงานตรวจ/ไฟล์แถวผิดแสดง 4 หลักท้าย · บัญชีธนาคารต้องมีสิทธิ์ settlements:pay (service ตรวจ)
 */
export function carrierImportSpec(svc: CarriersService) {
  return defineMasterImport({
    kind: 'carrier',
    label: 'ผู้รับเหมา',
    scope: 'master:write',
    modes: ['create_only', 'upsert_by_code', 'update_only'],
    createDto: CreateCarrierDto,
    updateDto: UpdateCarrierDto,
    identity: 'code',
    // ต้นแบบ vWiz: ชื่อ · เลขผู้เสียภาษี · ประเภท · (จำนวนรถ = นับจากทะเบียนรถ ไม่นำเข้า) · LINE ID
    columns: [
      {
        key: 'legalName',
        header: 'ชื่อ',
        aliases: ['Vendor', 'Name', 'ชื่อผู้รับเหมา'],
        required: true,
        example: 'นายสมมติ ใจดี',
      },
      {
        key: 'taxId',
        header: 'เลขผู้เสียภาษี',
        aliases: ['Tax ID', 'เลขบัตรประชาชน'],
        required: true,
        sensitive: true,
        example: '1050000003016',
        hint: '13 หลัก · บุคคลธรรมดา = เลขบัตรประชาชน (เก็บแบบเข้ารหัส)',
      },
      {
        key: 'entityType',
        header: 'ประเภท',
        aliases: ['Kind', 'Type'],
        required: true,
        example: 'บุคคลธรรมดา',
        options: label(TYPES),
      },
      {
        key: 'lineContact',
        header: 'LINE ID',
        aliases: ['LINE', 'Line'],
        example: '@somsmut',
      },
      {
        key: 'code',
        header: 'รหัส',
        aliases: ['Code', 'รหัสผู้รับเหมา'],
        example: 'SUB-0101',
        hint: 'ว่าง = ระบบออกเลขถัดไป',
      },
      { key: 'phone', header: 'เบอร์โทร', aliases: ['Phone', 'Mobile'], example: '0811112222' },
      {
        key: 'branchCode',
        header: 'สาขา',
        aliases: ['Branch'],
        example: '',
        hint: 'นิติบุคคล: 00000 = สำนักงานใหญ่ · บุคคลธรรมดาเว้นว่าง',
      },
      {
        key: 'whtRate',
        header: 'หัก ณ ที่จ่าย',
        aliases: ['WHT'],
        fields: ['whtRate'],
        example: '1%',
        options: label(WHT),
      },
      {
        key: 'paymentTermDays',
        header: 'เครดิต (วัน)',
        aliases: ['Payment term', 'เครดิต'],
        example: '15',
      },
      {
        key: 'requirePodToPay',
        header: 'ต้องมี POD ก่อนจ่าย',
        aliases: ['POD'],
        example: 'ใช่',
        options: ['ใช่', 'ไม่'],
      },
      {
        key: 'parent',
        header: 'ผู้รับเหมาหลัก',
        aliases: ['Parent'],
        fields: ['parentCarrierId'],
        hint: 'รหัสหรือชื่อของผู้รับเหมาที่สังกัด',
      },
      {
        key: 'bankCode',
        header: 'ธนาคาร',
        aliases: ['Bank'],
        fields: ['bankAccount.bankCode'],
        example: 'กสิกรไทย',
        options: label(BANK_TH),
        hint: 'ต้องมีสิทธิ์จ่ายเงินรถร่วม (settlements:pay)',
      },
      {
        key: 'bankAccountNo',
        header: 'เลขบัญชี',
        aliases: ['Account no', 'เลขที่บัญชี'],
        fields: ['bankAccount.accountNo'],
        sensitive: true,
        example: '1234567890',
        hint: '10–15 หลัก (เก็บแบบเข้ารหัส)',
      },
      {
        key: 'bankAccountName',
        header: 'ชื่อบัญชี',
        aliases: ['Account name'],
        fields: ['bankAccount.accountName'],
        example: 'นายสมมติ ใจดี',
      },
      ...ADDRESS_COLUMNS('address'),
      { key: 'externalId', header: 'รหัสในระบบอื่น', aliases: ['External ID', 'externalId'] },
    ],
    uniqueInFile: [
      { column: 'code', label: 'รหัส', key: (v) => v.code?.toUpperCase() || null },
      {
        column: 'taxId',
        label: 'เลขผู้เสียภาษี',
        key: (v) => v.taxId?.replace(/[\s-]/g, '').padStart(13, '0') || null,
      },
    ],
    findExisting: byCode((tx, code) =>
      tx.carrier.findFirst({
        where: { code: iEquals(code), deletedAt: null },
        select: { id: true },
      }),
    ),
    async build(r, op) {
      const b: Record<string, unknown> = {};
      if (op === 'create') put(b, 'code', r.text('code') ?? undefined);
      put(b, 'legalName', r.text('legalName'));
      put(b, 'taxId', readTaxId(r));
      put(b, 'entityType', r.pick('entityType', TYPES));
      put(b, 'lineContact', r.text('lineContact'));
      put(b, 'phone', r.text('phone'));
      put(b, 'branchCode', readBranch(r));
      put(b, 'whtRate', r.pick('whtRate', WHT));
      put(b, 'paymentTermDays', r.int('paymentTermDays'));
      put(b, 'requirePodToPay', r.bool('requirePodToPay'));
      put(b, 'parentCarrierId', await r.ref('parent', 'carrier'));
      put(
        b,
        'bankAccount',
        group({
          bankCode: r.pick('bankCode', BANK_TH),
          accountNo: r.text('bankAccountNo'),
          accountName: r.text('bankAccountName'),
        }),
      );
      put(b, 'address', readAddress(r));
      put(b, 'externalId', r.text('externalId'));
      return b;
    },
    create: (dto) => svc.create(dto as CreateCarrierDto),
    update: (id, dto) => svc.update(id, dto as UpdateCarrierDto),
  });
}
