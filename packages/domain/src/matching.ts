/**
 * จับคู่ข้อความ → ข้อมูลหลักอัตโนมัติ (ST3-T06; docs/04 C "จับคู่อัตโนมัติ" + "เรียนรู้ alias")
 *
 * docs/spec ไม่ได้กำหนดวิธี normalize/เกณฑ์ความคล้าย → ค่าด้านล่างเป็น [DECISION] ของ ST3-T06 (spec/12 §3, PROGRESS #54)
 * - เทียบด้วย "คีย์" (`matchKey`): NFKC + ตัวเล็ก + เลขไทย → อารบิก + ตัดคำนำหน้า/คำต่อท้ายนิติบุคคล/สาขา/คำบอกเขตปกครอง
 *   + ตัดช่องว่างและเครื่องหมายทั้งหมด (ภาษาไทยไม่เว้นวรรคระหว่างคำ — ต้นทางเว้นไม่เหมือนกัน)
 * - ตรงตัว (คีย์เท่ากัน) กับ alias ที่เรียนรู้ > ชื่อสถานที่ → ได้ 1 แห่ง = จับคู่, > 1 แห่ง = กำกวม (ไม่จับคู่ ให้คนเลือก)
 * - ไม่ตรงตัว → ความคล้าย (Levenshtein ratio บนคีย์) ≥ `MATCH_AUTO_THRESHOLD` + ห่างอันดับสอง≥ `MATCH_AUTO_MARGIN`
 *   + ตัวเลขในข้อความตรงกันทุกชุด (กัน "สาขา 2" ≠ "สาขา 3") + คีย์ยาว ≥ `MATCH_MIN_KEY_FUZZY` → จับคู่ (FUZZY)
 * - ไม่ถึงเกณฑ์ → ไม่จับคู่ เก็บรายการแนะนำ (≥ `MATCH_SUGGEST_THRESHOLD`, ≤ `MATCH_MAX_CANDIDATES` รายการ) ให้หน้าใบค้าง (T07)
 */

export const MATCH_AUTO_THRESHOLD = 0.9;
export const MATCH_AUTO_MARGIN = 0.05;
export const MATCH_SUGGEST_THRESHOLD = 0.6;
export const MATCH_MAX_CANDIDATES = 5;
export const MATCH_MIN_KEY_FUZZY = 6;
/** ข้อความหนึ่งอยู่ในอีกข้อความ (เช่น ชื่อ + ที่อยู่ยาว) — แนะนำได้ แต่ไม่ถึงเกณฑ์จับคู่เอง */
const CONTAINS_SCORE = 0.8;

/** คำ/คำย่อที่ไม่ช่วยแยกสถานที่หรือลูกค้า (ตัดทิ้งก่อนเทียบ) — เรียงยาวก่อนสั้น */
const THAI_NOISE = [
  'ห้างหุ้นส่วนจำกัด',
  'ห้างหุ้นส่วน',
  'บริษัทมหาชน',
  'บริษัท',
  'จำกัด',
  'มหาชน',
  'บจก',
  'บมจ',
  'หจก',
  'สาขาที่',
  'สาขา',
  'จังหวัด',
  'อำเภอ',
  'ตำบล',
  'ถนน',
].map((w) => w.normalize('NFKC'));
const LATIN_NOISE = /\b(?:co|company|ltd|limited|pcl|plc|inc|corp|corporation|branch)\b/g;
/** คำย่อเขตปกครอง/ถนนที่มีจุด (จ. อ. ต. ถ. ซ. ม.) — ต้องขึ้นต้นคำ (ต้นข้อความ/หลังช่องว่างหรือเครื่องหมาย) */
const THAI_ABBR = /(^|[\s(),/-])(?:จ|อ|ต|ถ|ซ|ม)\.\s*/g;

/** คีย์สำหรับเทียบ (ว่าง = ไม่มีสาระให้จับคู่) */
export function matchKey(text: string | null | undefined): string {
  if (!text) return '';
  let s = text.normalize('NFKC').toLowerCase();
  s = s.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
  s = s.replace(/[​-‏⁠﻿]/g, '');
  s = s.replace(THAI_ABBR, '$1 ');
  s = s.replace(LATIN_NOISE, ' ');
  for (const w of THAI_NOISE) s = s.split(w).join(' ');
  return s.replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/** ชุดตัวเลขในข้อความ (เรียงแล้ว) — ใช้กันจับคู่ข้ามสาขา/เลขที่ */
export function digitGroups(key: string): string {
  return (key.match(/\d+/g) ?? []).map((d) => d.replace(/^0+(?=\d)/, '')).join(',');
}

/** ระยะแก้ไข Levenshtein (หน่วย = code point) */
export function levenshtein(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[y.length]!;
}

/** ความคล้ายของคีย์ 0–1 (3 ตำแหน่ง) */
export function keySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const len = Math.max([...a].length, [...b].length);
  let score = 1 - levenshtein(a, b) / len;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if ([...short].length >= MATCH_MIN_KEY_FUZZY && long.includes(short))
    score = Math.max(score, CONTAINS_SCORE);
  return Math.round(score * 1000) / 1000;
}

export interface MatchTarget {
  id: string;
  /** ชื่อหลัก (ชื่อสถานที่ / ชื่อลูกค้า) */
  name: string;
  /** ข้อความที่เรียนรู้แล้ว (alias) */
  aliases?: readonly string[];
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
  /** มีหลายรายการเข้าเกณฑ์เท่ากัน → ไม่จับคู่เอง */
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
 * จับคู่ข้อความกับรายการเป้าหมาย (สถานที่ในขอบเขตเดียวกันแล้ว — ผู้เรียกกรองขอบเขต/สถานะใช้งานมาก่อน)
 * `allowFuzzy = false` = ตรงตัวเท่านั้น (ความคล้ายใช้แค่แนะนำ)
 */
export function matchText(
  text: string,
  targets: readonly MatchTarget[],
  opts: { allowFuzzy?: boolean } = {},
): MatchOutcome {
  const key = matchKey(text);
  if (!key) return NONE;
  const prepared = targets.map((t) => ({
    id: t.id,
    nameKey: matchKey(t.name),
    aliasKeys: (t.aliases ?? []).map(matchKey).filter(Boolean),
  }));

  const exact = (pick: (t: (typeof prepared)[number]) => boolean) => [
    ...new Set(prepared.filter(pick).map((t) => t.id)),
  ];
  for (const [method, ids] of [
    ['ALIAS', exact((t) => t.aliasKeys.includes(key))],
    ['NAME', exact((t) => t.nameKey === key)],
  ] as const) {
    if (ids.length === 1) return { ...NONE, id: ids[0]!, method, score: 1 };
    if (ids.length > 1)
      return { ...NONE, ambiguous: true, candidates: ids.map((id) => ({ id, score: 1 })) };
  }

  const digits = digitGroups(key);
  const scored = prepared
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
  const ambiguous =
    !!top && !!second && top.score >= MATCH_AUTO_THRESHOLD && second.score >= MATCH_AUTO_THRESHOLD;
  return { ...NONE, ambiguous, candidates };
}
