import { type Satang } from './money';

/**
 * จำนวนเงินเป็นตัวอักษรไทย (BahtText) — spec/05 §16 BIL-193 (ใต้ยอดรวมของใบแจ้งหนี้/ใบวางบิล)
 * - "เอ็ด" เมื่อหลักหน่วย = 1 และมีหลักอื่นนำหน้า (ในกลุ่มล้านเดียวกัน หรือมีกลุ่มล้านนำหน้า)
 * - "ยี่สิบ" สำหรับ 2 ที่หลักสิบ · ละ "หนึ่ง" ในหลักสิบ ("สิบ")
 * - "บาทถ้วน" เมื่อไม่มีสตางค์ · มีสตางค์ → "…บาท…สตางค์" · ไม่มีบาท → "…สตางค์"
 * - เกินล้านวนซ้ำด้วย "ล้าน" · ยอดติดลบ → นำหน้า "ลบ"
 */
const DIGIT = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACE = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

/** 0..999,999 → คำ (ไม่มีหน่วยเงิน) · `leadingWords` = มีคำนำหน้า (หลักหน่วย 1 → "เอ็ด") */
function chunk(n: number, leadingWords: boolean): string {
  if (n === 0) return '';
  const ds = String(n).split('').map(Number).reverse();
  let out = '';
  for (let p = ds.length - 1; p >= 0; p--) {
    const d = ds[p]!;
    if (d === 0) continue;
    if (p === 0) {
      out += d === 1 && (leadingWords || ds.slice(1).some((x) => x > 0)) ? 'เอ็ด' : DIGIT[d]!;
    } else if (p === 1) {
      out += (d === 1 ? '' : d === 2 ? 'ยี่' : DIGIT[d]!) + 'สิบ';
    } else {
      out += DIGIT[d]! + PLACE[p]!;
    }
  }
  return out;
}

/** จำนวนเต็มบวก → คำ (วน "ล้าน") */
function integerWords(n: bigint): string {
  if (n === 0n) return 'ศูนย์';
  const groups: number[] = [];
  let x = n;
  while (x > 0n) {
    groups.push(Number(x % 1_000_000n));
    x /= 1_000_000n;
  }
  let out = '';
  for (let i = groups.length - 1; i >= 0; i--) {
    out += chunk(groups[i]!, out !== '');
    if (i > 0) out += 'ล้าน';
  }
  return out;
}

/** สตางค์ → คำอ่านไทย เช่น 1107000n → "หนึ่งหมื่นหนึ่งพันเจ็ดสิบบาทถ้วน" */
export function bahtText(amount: Satang): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const baht = abs / 100n;
  const satang = abs % 100n;
  let out: string;
  if (satang === 0n) out = `${integerWords(baht)}บาทถ้วน`;
  else if (baht === 0n) out = `${integerWords(satang)}สตางค์`;
  else out = `${integerWords(baht)}บาท${integerWords(satang)}สตางค์`;
  return neg ? `ลบ${out}` : out;
}
