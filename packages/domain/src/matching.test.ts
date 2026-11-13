import { describe, expect, it } from 'vitest';
import {
  MATCH_AUTO_THRESHOLD,
  buildMatchIndex,
  digitGroups,
  isLearnableKey,
  keyOwners,
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
    expect(matchKey('ซ.5 ถ.สุขุมวิท')).toBe(matchKey('ซอย 5 ถนนสุขุมวิท'));
    // สระอำ 2 แบบ (ำ กับ ํ+า) — NFKC ทำให้เท่ากัน
    expect(matchKey('โรงงานลำพูน')).toBe(matchKey('โรงงานลําพูน'));
  });

  it('ตัดคำเฉพาะเป็นทั้งคำ/หน้า-ท้ายคำ — ไม่ตัดกลางคำหรือชื่อที่บังเอิญขึ้นต้นเหมือน', () => {
    expect(matchKey('ร้านมหาชนก')).toBe('ร้านมหาชนก');
    expect(matchKey('ตลาดถนนทอง')).toBe('ตลาดถนนทอง');
    expect(matchKey('ถนนทอง')).toBe('ถนนทอง');
    expect(matchKey('ABC Co-op')).toBe('abccoop');
    expect(matchKey('ABC Co., Ltd.')).toBe('abc');
    expect(matchKey('ปูนไทยจำกัด')).toBe('ปูนไทย');
    expect(matchKey('บริษัทปูนไทย')).toBe('ปูนไทย');
    expect(matchKey('ห้างหุ้นส่วนจำกัด สมใจการค้า')).toBe('สมใจการค้า');
    expect(matchKey('คลังจำกัดเขต')).toBe('คลังจำกัดเขต'.normalize('NFKC'));
  });

  it('เรียนรู้ได้เฉพาะคีย์ที่มีสาระ: ยาว ≥ 4 และไม่ใช่คำทั่วไป', () => {
    expect(isLearnableKey(matchKey('คลังสินค้า'), 'site')).toBe(false);
    expect(isLearnableKey(matchKey('โกดัง'), 'site')).toBe(false);
    expect(isLearnableKey(matchKey('A1'), 'site')).toBe(false);
    expect(isLearnableKey(matchKey('คลังสินค้า บางนา'), 'site')).toBe(true);
    expect(isLearnableKey(matchKey('Walk-in'), 'customer')).toBe(false);
    expect(isLearnableKey(matchKey('ลูกค้า เงินสด'), 'customer')).toBe(false);
    expect(isLearnableKey(matchKey('CASH'), 'customer')).toBe(false);
    expect(isLearnableKey(matchKey('ร้านสมใจ'), 'customer')).toBe(true);
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
  it('levenshtein แบบมีเพดานตรงกับแบบตรงไปตรงมา (สุ่ม 5,000 คู่)', () => {
    const naive = (a: string, b: string) => {
      const d = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
      );
      for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
          d[i]![j] = Math.min(
            d[i - 1]![j]! + 1,
            d[i]![j - 1]! + 1,
            d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
          );
      return d[a.length]![b.length]!;
    };
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    const al = 'abกขค1';
    const str = () => Array.from({ length: rnd(14) }, () => al[rnd(al.length)]).join('');
    for (let t = 0; t < 5000; t++) {
      const [a, b] = [str(), str()];
      const d = naive(a, b);
      expect(levenshtein(a, b)).toBe(d);
      const len = Math.max(a.length, b.length);
      if (len && a !== b && 1 - d / len >= 0.6)
        expect(keySimilarity(a, b)).toBeGreaterThanOrEqual(Math.round((1 - d / len) * 1000) / 1000);
    }
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
    const dup = [...sites, { id: 's5', name: 'โรงงาน สระบุรี', aliases: [] as string[] }];
    const r = matchText('โรงงานสระบุรี', dup);
    expect(r).toMatchObject({ id: null, ambiguous: true });
    expect(r.candidates.map((c) => c.id).sort()).toEqual(['s2', 's5']);
  });
  it('alias ชี้ B แต่ A ชื่อตรงข้อความ → กำกวม (กัน alias ที่ถูกสอนผิด) · alias อย่างเดียว → ALIAS', () => {
    const t = [
      { id: 'A', name: 'จุดส่งหนึ่ง', aliases: [] },
      { id: 'B', name: 'จุดส่งสอง', aliases: ['จุดส่ง หนึ่ง', 'ประตูหลังโกดังใหญ่'] },
    ];
    const r = matchText('จุดส่งหนึ่ง', t);
    expect(r).toMatchObject({ id: null, ambiguous: true });
    expect(r.candidates.map((c) => c.id)).toEqual(['A', 'B']);
    expect(matchText('ประตูหลัง โกดังใหญ่', t)).toMatchObject({ id: 'B', method: 'ALIAS' });
  });
  it('ชื่อตรงหลายแห่ง: แห่งเดียวที่ preferred (สถานที่ของลูกค้าเอง) ชนะ · preferred หลายแห่ง = กำกวม', () => {
    const t = [
      { id: 'own', name: 'โรงงานสระบุรี', preferred: true },
      { id: 'company', name: 'โรงงาน สระบุรี' },
    ];
    expect(matchText('โรงงานสระบุรี', t)).toMatchObject({ id: 'own', method: 'NAME' });
    expect(
      matchText('โรงงานสระบุรี', [...t, { id: 'own2', name: 'โรงงานสระบุรี', preferred: true }]),
    ).toMatchObject({ id: null, ambiguous: true });
  });
  it('ดัชนีสร้างครั้งเดียวใช้ซ้ำ + keyOwners หาเจ้าของคีย์อื่น', () => {
    const idx = buildMatchIndex(sites);
    expect(matchText('dc bangna', idx).id).toBe('s1');
    expect(keyOwners(idx, matchKey('โรงงานสระบุรี'), 's1')).toEqual(['s2']);
    expect(keyOwners(idx, matchKey('โรงงานสระบุรี'), 's2')).toEqual([]);
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

  it('ประสิทธิภาพ: 5,000 สถานที่ × 20 ข้อความ ใช้ดัชนีเดียว — ภายในเวลาที่กำหนด (หลวม)', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({
      id: `p${i}`,
      name: `คลังสินค้าลูกค้าทดสอบ สาขา ${i}`,
      aliases: [`จุดส่ง ${i} นิคมอุตสาหกรรม`],
    }));
    const t0 = Date.now();
    const idx = buildMatchIndex(many);
    for (let i = 0; i < 20; i++) {
      matchText(`คลังสินค้าลูกค้าทดสอบ สาขา ${i * 37}`, idx);
      matchText(`ข้อความที่ไม่ตรงกับอะไรเลย ${i}`, idx);
    }
    expect(matchText('คลังสินค้าลูกค้าทดสอบ สาขา 4999', idx).id).toBe('p4999');
    expect(Date.now() - t0).toBeLessThan(10000);
  }, 30000);
});
