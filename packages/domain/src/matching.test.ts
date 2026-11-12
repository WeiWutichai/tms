import { describe, expect, it } from 'vitest';
import {
  MATCH_AUTO_THRESHOLD,
  digitGroups,
  keySimilarity,
  levenshtein,
  matchKey,
  matchText,
} from './matching';

describe('matchKey (normalize ข้อความไทย)', () => {
  it('ช่องว่าง/เครื่องหมาย/ตัวพิมพ์/เลขไทย/zero-width ไม่มีผล', () => {
    const k = matchKey('คลังสินค้า บางนา กม.๕');
    expect(matchKey('  คลังสินค้าบางนา   กม. 5 ')).toBe(k);
    expect(matchKey('คลัง​สินค้า-บางนา (กม.5)')).toBe(k);
    expect(matchKey('WAREHOUSE A')).toBe(matchKey('warehouse-a'));
  });

  it('ตัดคำนิติบุคคล/สาขา/เขตปกครอง (บริษัท … จำกัด, บจก., สาขา, จ./อ./ต./ถ.)', () => {
    const k = matchKey('ปูนไทย บางซื่อ');
    expect(matchKey('บริษัท ปูนไทย จำกัด สาขาบางซื่อ')).toBe(k);
    expect(matchKey('บจก. ปูนไทย (สาขา บางซื่อ)')).toBe(k);
    expect(matchKey('ปูนไทย Co., Ltd. บางซื่อ')).toBe(k);
    expect(matchKey('ตลาดไท อ.คลองหลวง จ.ปทุมธานี')).toBe(matchKey('ตลาดไท คลองหลวง ปทุมธานี'));
    expect(matchKey('ตลาดไท อำเภอคลองหลวง จังหวัดปทุมธานี')).toBe(
      matchKey('ตลาดไท คลองหลวง ปทุมธานี'),
    );
    // สระอำ 2 แบบ (ำ กับ ํ+า) — NFKC ทำให้เท่ากัน
    expect(matchKey('โรงงานลำพูน')).toBe(matchKey('โรงงานลําพูน'));
  });

  it('ข้อความว่าง/มีแต่คำทั่วไป → คีย์ว่าง', () => {
    expect(matchKey('')).toBe('');
    expect(matchKey(null)).toBe('');
    expect(matchKey(' บริษัท จำกัด ')).toBe('');
  });
});

describe('similarity', () => {
  it('levenshtein + ratio', () => {
    expect(levenshtein('กขค', 'กขค')).toBe(0);
    expect(levenshtein('กขค', 'กคค')).toBe(1);
    expect(keySimilarity('abc', '')).toBe(0);
    expect(keySimilarity('abcdefghij', 'abcdefghix')).toBe(0.9);
  });
  it('ตัวเลขแยกชุด (ตัด 0 นำหน้า)', () => {
    expect(digitGroups(matchKey('คลัง 2 ซอย 07'))).toBe('2,7');
  });
});

describe('matchText', () => {
  const sites = [
    { id: 's1', name: 'คลังสินค้าบางนา กม.5', aliases: ['DC Bangna'] },
    { id: 's2', name: 'โรงงานสระบุรี', aliases: [] },
    { id: 's3', name: 'ตลาดไท สาขา 2', aliases: [] },
    { id: 's4', name: 'ตลาดไท สาขา 3', aliases: [] },
  ];

  it('alias ที่เรียนรู้ตรงตัว (ไม่สนช่องว่าง/ตัวพิมพ์) → ALIAS', () => {
    expect(matchText(' dc  bangna ', sites)).toMatchObject({ id: 's1', method: 'ALIAS', score: 1 });
  });
  it('ชื่อตรงตัวหลัง normalize → NAME', () => {
    expect(matchText('บจก. โรงงาน สระบุรี', sites)).toMatchObject({ id: 's2', method: 'NAME' });
  });
  it('พิมพ์ผิด 1 ตัว (ข้อความยาวพอ) → FUZZY ≥ เกณฑ์', () => {
    const r = matchText('คลังสินค้าบางน่า กม.5', sites);
    expect(r).toMatchObject({ id: 's1', method: 'FUZZY' });
    expect(r.score!).toBeGreaterThanOrEqual(MATCH_AUTO_THRESHOLD);
  });
  it('ตัวเลขต่างกัน (สาขา 2 vs 4) → ไม่จับคู่เองแม้คล้ายมาก แต่แนะนำ', () => {
    const r = matchText('ตลาดไท สาขา 4', sites);
    expect(r.id).toBeNull();
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['s3', 's4']);
  });
  it('ชื่อตรงกันหลายแห่ง → กำกวม ไม่จับคู่ + รายการให้เลือก', () => {
    const dup = [...sites, { id: 's5', name: 'โรงงาน สระบุรี', aliases: [] }];
    const r = matchText('โรงงานสระบุรี', dup);
    expect(r).toMatchObject({ id: null, ambiguous: true });
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['s2', 's5']);
  });
  it('alias มาก่อนชื่อ: ข้อความเป็นชื่อของ A แต่คนสอนให้เป็น alias ของ B → B', () => {
    const t = [
      { id: 'A', name: 'จุดส่งหนึ่ง', aliases: [] },
      { id: 'B', name: 'จุดส่งสอง', aliases: ['จุดส่ง หนึ่ง'] },
    ];
    expect(matchText('จุดส่งหนึ่ง', t)).toMatchObject({ id: 'B', method: 'ALIAS' });
  });
  it('ไม่คล้ายเลย → ไม่มีรายการแนะนำ; คล้ายปานกลาง → แนะนำเท่านั้น', () => {
    expect(matchText('สนามบินเชียงใหม่', sites)).toMatchObject({ id: null, candidates: [] });
    const r = matchText('คลังสินค้าบางนา กม.5 ถนนบางนาตราด ขาออก', sites);
    expect(r.id).toBeNull();
    expect(r.candidates[0]).toMatchObject({ id: 's1' });
  });
  it('คล้ายเกณฑ์ทั้งสองแห่ง (ห่างกันน้อย) → ไม่จับคู่เอง', () => {
    const t = [
      { id: 'x', name: 'ศูนย์กระจายสินค้าลาดกระบังเอ', aliases: [] },
      { id: 'y', name: 'ศูนย์กระจายสินค้าลาดกระบังบี', aliases: [] },
    ];
    const r = matchText('ศูนย์กระจายสินค้าลาดกระบัง', t);
    expect(r.id).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });
  it('allowFuzzy=false → ตรงตัวเท่านั้น', () => {
    expect(matchText('คลังสินค้าบางน่า กม.5', sites, { allowFuzzy: false }).id).toBeNull();
  });
});
