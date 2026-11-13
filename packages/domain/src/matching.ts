/**
 * จับคู่ข้อความ → ข้อมูลหลักอัตโนมัติ (ST3-T06; docs/04 C "จับคู่อัตโนมัติ" + "เรียนรู้ alias")
 *
 * docs/spec ไม่ได้กำหนดวิธี normalize/เกณฑ์ความคล้าย → ค่าด้านล่างเป็น [DECISION] ของ ST3-T06 (spec/12 §3, PROGRESS #54)
 * - เทียบด้วย "คีย์" (`matchKey`): NFKC + ตัวเล็ก + เลขไทย → อารบิก + ขยายคำย่อ (ถ. ซ. ม. จ. อ. ต.) + ตัดคำนิติบุคคล/สาขา/
 *   เขตปกครอง **เฉพาะเป็นทั้งคำ หรือหน้า/ท้ายคำ** (ไม่ตัดกลางคำ — "มหาชนก", "ถนนทอง", "Co-op" คงอยู่) + ตัดช่องว่าง/เครื่องหมาย
 * - ตรงตัว: alias ที่เรียนรู้ 1 แห่ง (และไม่มีสถานที่อื่นชื่อตรง) → ALIAS · alias ชี้แห่งหนึ่งแต่อีกแห่งชื่อตรง → กำกวม (กัน alias
 *   "วางยา") · ชื่อตรง 1 แห่ง → NAME · ชื่อตรงหลายแห่ง → เลือกแห่งที่ `preferred` (สถานที่ของลูกค้าเองชนะของบริษัท) ถ้ามีแห่งเดียว
 *   ไม่งั้นกำกวม
 * - ไม่ตรงตัว → ความคล้าย (Levenshtein ratio บนคีย์) ≥ `MATCH_AUTO_THRESHOLD` + ห่างอันดับสอง ≥ `MATCH_AUTO_MARGIN`
 *   + ตัวเลขในข้อความตรงกันทุกชุด (กัน "สาขา 2" ≠ "สาขา 3") + คีย์ยาว ≥ `MATCH_MIN_KEY_FUZZY` → จับคู่ (FUZZY)
 * - ไม่ถึงเกณฑ์ → ไม่จับคู่ เก็บรายการแนะนำ (≥ `MATCH_SUGGEST_THRESHOLD`, ≤ `MATCH_MAX_CANDIDATES` รายการ) ให้หน้าใบค้าง (T07)
 * - เรียนรู้ alias ได้เฉพาะคีย์ที่ "มีสาระ" (`isLearnableKey`): ยาว ≥ `MATCH_MIN_LEARN_KEY` และไม่อยู่ในรายการคำทั่วไป
 */

export const MATCH_AUTO_THRESHOLD = 0.9;
export const MATCH_AUTO_MARGIN = 0.05;
export const MATCH_SUGGEST_THRESHOLD = 0.6;
export const MATCH_MAX_CANDIDATES = 5;
export const MATCH_MIN_KEY_FUZZY = 6;
/** คีย์สั้นกว่านี้ไม่เรียนรู้เป็น alias (code point) */
export const MATCH_MIN_LEARN_KEY = 4;
/** ข้อความหนึ่งอยู่ในอีกข้อความ (เช่น ชื่อ + ที่อยู่ยาว) — แนะนำได้ แต่ไม่ถึงเกณฑ์จับคู่เอง */
const CONTAINS_SCORE = 0.8;

const nfkc = (w: string) => w.normalize('NFKC');
/** คำนำหน้าที่ตัดได้ (ทั้งคำ หรือขึ้นต้นคำ) — เรียงยาวก่อนสั้น */
const PREFIX_NOISE = [
  'ห้างหุ้นส่วนจำกัด',
  'ห้างหุ้นส่วนสามัญ',
  'ห้างหุ้นส่วน',
  'บริษัทมหาชนจำกัด',
  'บริษัท',
  'บจก',
  'บมจ',
  'หจก',
  'สาขาที่',
  'สาขา',
  'จังหวัด',
  'อำเภอ',
  'ตำบล',
].map(nfkc);
/** คำต่อท้ายที่ตัดได้ (ทั้งคำ หรือลงท้ายคำ) */
const SUFFIX_NOISE = ['มหาชนจำกัด', 'จำกัด', 'มหาชน'].map(nfkc);
/** คำละตินที่ตัดเมื่อเป็นทั้งคำ (ขีด `-` นับเป็นส่วนของคำ — "co-op" ไม่ถูกตัด) */
const LATIN_NOISE = new Set([
  'co',
  'company',
  'ltd',
  'limited',
  'pcl',
  'plc',
  'inc',
  'corp',
  'corporation',
  'branch',
]);
/** คำย่อที่มีจุด → คำเต็ม (ต้องขึ้นต้นคำ) — "ซ.5" = "ซอย 5", "อ.เมือง" = "อำเภอเมือง" */
const THAI_ABBR: [RegExp, string][] = (
  [
    ['จ', 'จังหวัด'],
    ['อ', 'อำเภอ'],
    ['ต', 'ตำบล'],
    ['ถ', 'ถนน'],
    ['ซ', 'ซอย'],
    ['ม', 'หมู่'],
  ] as const
).map(([a, full]) => [new RegExp(`(^|[\\s(),/])${a}\\.\\s*`, 'g'), `$1${nfkc(full)}`]);

/** คำทั่วไปที่ไม่ใช้เป็น alias (เรียนรู้ไม่ได้ — ใช้ชี้สถานที่/ลูกค้าเจาะจงไม่ได้) */
const GENERIC_SITE = [
  'โกดัง',
  'คลัง',
  'คลังสินค้า',
  'ร้าน',
  'ร้านค้า',
  'บ้าน',
  'โรงงาน',
  'สำนักงาน',
  'สำนักงานใหญ่',
  'ออฟฟิศ',
  'office',
  'warehouse',
  'หน้าร้าน',
  'ไซต์งาน',
  'หน้างาน',
  'ลูกค้า',
  'ปลายทาง',
  'ต้นทาง',
  'จุดส่ง',
  'จุดรับ',
  'ส่งของ',
  'รับของ',
  'ตามที่อยู่',
  'ตามใบสั่ง',
  'ไม่ระบุ',
  'อื่นๆ',
];
const GENERIC_CUSTOMER = [
  'เงินสด',
  'ลูกค้าเงินสด',
  'ลูกค้าทั่วไป',
  'ทั่วไป',
  'ขายสด',
  'ขายปลีก',
  'walkin',
  'cash',
  'cashcustomer',
  'general',
  'ลูกค้า',
  'ไม่ระบุ',
  'อื่นๆ',
];

/** คีย์สำหรับเทียบ (ว่าง = ไม่มีสาระให้จับคู่) */
export function matchKey(text: string | null | undefined): string {
  if (!text) return '';
  let s = text.normalize('NFKC').toLowerCase();
  s = s.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
  s = s.replace(/[​-‏⁠﻿]/g, '');
  for (const [re, full] of THAI_ABBR) s = s.replace(re, full);
  const tokens = s.split(/[\s,()[\]{}"'/.;:]+/u).filter(Boolean);
  const out: string[] = [];
  for (let t of tokens) {
    if (LATIN_NOISE.has(t)) continue;
    for (let again = true; again && t;) {
      again = false;
      for (const w of PREFIX_NOISE)
        if (t.startsWith(w)) {
          t = t.slice(w.length);
          again = true;
          break;
        }
      for (const w of SUFFIX_NOISE)
        if (t.endsWith(w)) {
          t = t.slice(0, -w.length);
          again = true;
          break;
        }
    }
    if (t) out.push(t);
  }
  return out.join('').replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

const GENERIC_KEYS = {
  site: new Set(GENERIC_SITE.map(matchKey)),
  customer: new Set(GENERIC_CUSTOMER.map(matchKey)),
};

/** เรียนรู้เป็น alias ได้ไหม: คีย์ยาวพอ + ไม่ใช่คำทั่วไป ("คลัง", "เงินสด", "walk-in" …) */
export function isLearnableKey(key: string, kind: 'site' | 'customer'): boolean {
  return [...key].length >= MATCH_MIN_LEARN_KEY && !GENERIC_KEYS[kind].has(key);
}

/** ชุดตัวเลขในข้อความ — ใช้กันจับคู่ข้ามสาขา/เลขที่ */
export function digitGroups(key: string): string {
  return (key.match(/\d+/g) ?? []).map((d) => d.replace(/^0+(?=\d)/, '')).join(',');
}

/** ระยะแก้ไข Levenshtein (หน่วย = UTF-16 code unit — อักษรไทยอยู่ใน BMP) */
export function levenshtein(a: string, b: string): number {
  return boundedDistance(a, b, Math.max(a.length, b.length));
}

const ROW = { prev: new Uint32Array(64), cur: new Uint32Array(64) };

/** Levenshtein แบบจำกัดเพดาน `k` — เกิน k คืน k + 1 ทันที (แถบกว้าง 2k+1 + หยุดเมื่อค่าต่ำสุดของแถวเกิน k) */
function boundedDistance(a: string, b: string, k: number): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > k) return k + 1;
  if (!n) return m;
  if (!m) return n;
  if (ROW.prev.length <= m) {
    ROW.prev = new Uint32Array(m + 1);
    ROW.cur = new Uint32Array(m + 1);
  }
  let prev = ROW.prev;
  let cur = ROW.cur;
  const BIG = k + 1;
  for (let j = 0; j <= m; j++) prev[j] = j <= k ? j : BIG;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(m, i + k);
    cur[0] = i <= k ? i : BIG;
    if (lo > 1) cur[lo - 1] = BIG;
    let rowMin = cur[0]!;
    const ca = a.charCodeAt(i - 1);
    for (let j = lo; j <= hi; j++) {
      const sub = prev[j - 1]! + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = (j <= i + k - 1 ? prev[j]! : BIG) + 1;
      const ins = cur[j - 1]! + 1;
      let v = sub < del ? sub : del;
      if (ins < v) v = ins;
      if (v > BIG) v = BIG;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < m) cur[hi + 1] = BIG;
    if (rowMin > k) return BIG;
    [prev, cur] = [cur, prev];
  }
  return Math.min(prev[m]!, BIG);
}

/** ความคล้ายของคีย์ 0–1 (3 ตำแหน่ง) — ต่ำกว่าเกณฑ์แนะนำคืน 0 (ไม่คำนวณเต็ม) เว้นข้อความหนึ่งอยู่ในอีกข้อความ (0.8) */
export function keySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const len = Math.max(a.length, b.length);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const contains = short.length >= MATCH_MIN_KEY_FUZZY && long.includes(short);
  const k = Math.floor(len * (1 - MATCH_SUGGEST_THRESHOLD));
  const d = boundedDistance(a, b, k);
  let score = d > k ? 0 : 1 - d / len;
  if (contains) score = Math.max(score, CONTAINS_SCORE);
  return Math.round(score * 1000) / 1000;
}

export interface MatchTarget {
  id: string;
  /** ชื่อหลัก (ชื่อสถานที่ / ชื่อลูกค้า) */
  name: string;
  /** ข้อความที่เรียนรู้แล้ว (alias) */
  aliases?: readonly string[];
  /** ชนะเมื่อชื่อตรงกันหลายแห่ง (สถานที่ของลูกค้าเองเทียบกับของบริษัท) */
  preferred?: boolean;
}

/** ดัชนีที่คำนวณคีย์ไว้แล้ว (สร้างครั้งเดียวต่อขอบเขต ใช้กับหลายจุดของใบ) */
export interface MatchIndex {
  targets: { id: string; nameKey: string; aliasKeys: string[]; preferred: boolean }[];
  byAlias: Map<string, string[]>;
  byName: Map<string, string[]>;
}

export function buildMatchIndex(targets: readonly MatchTarget[]): MatchIndex {
  const byAlias = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, id: string) => {
    if (!k) return;
    const list = m.get(k) ?? [];
    if (!list.includes(id)) list.push(id);
    m.set(k, list);
  };
  const prepared = targets.map((t) => {
    const nameKey = matchKey(t.name);
    const aliasKeys = [...new Set((t.aliases ?? []).map(matchKey).filter(Boolean))];
    add(byName, nameKey, t.id);
    for (const k of aliasKeys) add(byAlias, k, t.id);
    return { id: t.id, nameKey, aliasKeys, preferred: !!t.preferred };
  });
  return { targets: prepared, byAlias, byName };
}

/** id อื่น (ไม่ใช่ `exceptId`) ที่ใช้คีย์นี้เป็นชื่อหรือ alias อยู่แล้ว — ใช้กันเรียนรู้ alias ที่ชนกับสถานที่อื่น */
export function keyOwners(index: MatchIndex, key: string, exceptId: string): string[] {
  return [...new Set([...(index.byName.get(key) ?? []), ...(index.byAlias.get(key) ?? [])])].filter(
    (id) => id !== exceptId,
  );
}

export type MatchMethod = 'ALIAS' | 'NAME' | 'FUZZY';

export interface MatchCandidate {
  id: string;
  score: number;
}

export interface MatchOutcome {
  /** id ที่จับคู่ได้ (null = ไม่จับคู่ — ไม่พบ หรือกำกวม) */
  id: string | null;
  method: MatchMethod | null;
  score: number | null;
  /** มีหลายรายการเข้าเกณฑ์ → ไม่จับคู่เอง */
  ambiguous: boolean;
  /** รายการแนะนำเมื่อจับคู่เองไม่ได้ (เรียงคะแนนมาก → น้อย) */
  candidates: MatchCandidate[];
}

const NONE: MatchOutcome = {
  id: null,
  method: null,
  score: null,
  ambiguous: false,
  candidates: [],
};

/**
 * จับคู่ข้อความกับรายการเป้าหมาย (ขอบเขต/สถานะใช้งานกรองมาก่อนแล้ว) · `allowFuzzy = false` = ตรงตัวเท่านั้น
 * รับรายการ (สร้างดัชนีให้) หรือดัชนีที่สร้างไว้แล้ว (`buildMatchIndex` — หลายจุดใช้ร่วมกัน)
 */
export function matchText(
  text: string,
  targets: readonly MatchTarget[] | MatchIndex,
  opts: { allowFuzzy?: boolean } = {},
): MatchOutcome {
  const key = matchKey(text);
  if (!key) return NONE;
  const index = Array.isArray(targets)
    ? buildMatchIndex(targets as readonly MatchTarget[])
    : (targets as MatchIndex);
  const ambiguous = (ids: string[]): MatchOutcome => ({
    ...NONE,
    ambiguous: true,
    candidates: [...new Set(ids)].sort().map((id) => ({ id, score: 1 })),
  });

  const aliasIds = index.byAlias.get(key) ?? [];
  const nameIds = index.byName.get(key) ?? [];
  if (aliasIds.length > 1) return ambiguous([...aliasIds, ...nameIds]);
  if (aliasIds.length === 1) {
    // alias ชี้แห่งหนึ่ง แต่อีกแห่งมีชื่อตรงข้อความ → ไม่เชื่อ alias (อาจถูกสอนผิด) ให้คนเลือก
    if (nameIds.some((id) => id !== aliasIds[0])) return ambiguous([...aliasIds, ...nameIds]);
    return { ...NONE, id: aliasIds[0]!, method: 'ALIAS', score: 1 };
  }
  if (nameIds.length === 1) return { ...NONE, id: nameIds[0]!, method: 'NAME', score: 1 };
  if (nameIds.length > 1) {
    const pref = index.targets.filter((t) => t.preferred && nameIds.includes(t.id));
    if (pref.length === 1) return { ...NONE, id: pref[0]!.id, method: 'NAME', score: 1 };
    return ambiguous(nameIds);
  }

  const digits = digitGroups(key);
  const scored = index.targets
    .map((t) => {
      let best = 0;
      let bestKey = '';
      for (const k of [t.nameKey, ...t.aliasKeys]) {
        const s = keySimilarity(key, k);
        if (s > best) [best, bestKey] = [s, k];
      }
      return { id: t.id, score: best, sameDigits: digitGroups(bestKey) === digits };
    })
    .filter((x) => x.score >= MATCH_SUGGEST_THRESHOLD)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const [top, second] = scored;
  if (
    opts.allowFuzzy !== false &&
    top &&
    top.score >= MATCH_AUTO_THRESHOLD &&
    top.sameDigits &&
    [...key].length >= MATCH_MIN_KEY_FUZZY &&
    (!second || top.score - second.score >= MATCH_AUTO_MARGIN)
  )
    return { ...NONE, id: top.id, method: 'FUZZY', score: top.score };
  const candidates = scored.slice(0, MATCH_MAX_CANDIDATES).map(({ id, score }) => ({ id, score }));
  return {
    ...NONE,
    ambiguous:
      !!top &&
      !!second &&
      top.score >= MATCH_AUTO_THRESHOLD &&
      second.score >= MATCH_AUTO_THRESHOLD,
    candidates,
  };
}
