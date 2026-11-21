import { PDFDocument } from 'pdf-lib';

/** วันที่คงที่ในข้อมูลไฟล์รวม — เนื้อไฟล์เดิม = ไฟล์ไบต์เดิม (sha256 เดิม → FileStore ใช้ key เดิม ไม่เก็บซ้ำ) */
const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');

/**
 * รวม PDF หลายไฟล์เป็นไฟล์เดียวตามลำดับที่ส่งมา (ST5-T21 ชุด "ใบวางบิล + ใบแจ้งหนี้") — **ไม่ render ใหม่**:
 * คัดลอกหน้าจากไฟล์ที่เก็บ ณ วันออก (ฟอนต์/ลายน้ำ/ข้อความคงเดิม) · ใช้ pdf-lib (MIT, pure JS)
 */
export async function mergePdfs(parts: readonly Buffer[], title: string): Promise<Buffer> {
  if (!parts.length) throw new Error('no pdf to merge');
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const p of parts) {
    const src = await PDFDocument.load(p, { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  out.setTitle(title);
  out.setProducer('TMS');
  out.setCreator('TMS');
  out.setCreationDate(FIXED_DATE);
  out.setModificationDate(FIXED_DATE);
  return Buffer.from(await out.save({ useObjectStreams: true }));
}

/** จำนวนหน้าของ PDF (ใช้ใน test / ตรวจไฟล์รวม) */
export async function pdfPageCount(pdf: Buffer): Promise<number> {
  return (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
}
