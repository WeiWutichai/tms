import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTING_KEYS } from '../src/modules/settings/registry';

/**
 * ST9-T12 (K5 "ทุก setting ตั้งได้จาก UI"): checklist ใน plan/12-settings-checklist.md ต้องตรงกับ registry
 * — key ใหม่ต้องลงตาราง (สถานะ UI / API-only) · สถานะ UI ต้องมีโค้ดหน้าเว็บที่ใช้ key นั้นจริง
 * · API-only ต้องไม่มีโค้ดหน้าเว็บ (ถ้าทำ UI แล้ว ให้แก้ checklist เป็น UI)
 */
const repo = join(__dirname, '../../..');
const doc = readFileSync(join(repo, 'plan/12-settings-checklist.md'), 'utf8');
const rows = new Map<string, string>();
for (const m of doc.matchAll(
  /^\|[^|\n]*\|[^|\n]*\| `([a-z]+\.[A-Za-z0-9]+)` \|[^|\n]*\| (UI|API-only) \|/gm,
))
  rows.set(m[1]!, m[2]!);

const webSrc: string[] = [];
(function walk(d: string) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) {
      if (!p.endsWith('/i18n')) walk(p);
    } else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) webSrc.push(readFileSync(p, 'utf8'));
  }
})(join(repo, 'apps/web/src'));
const usedInWeb = (k: string) => webSrc.some((s) => s.includes(`'${k}'`));

describe('ST9-T12 checklist ค่าตั้งองค์กร', () => {
  it('ทุก key ใน registry อยู่ใน checklist (และไม่มี key ที่ registry ไม่มี)', () => {
    expect(SETTING_KEYS.filter((k) => !rows.has(k))).toEqual([]);
    expect([...rows.keys()].filter((k) => !(SETTING_KEYS as string[]).includes(k))).toEqual([]);
  });

  it('สถานะ UI = หน้าเว็บใช้ key นั้นจริง · API-only = หน้าเว็บยังไม่ใช้', () => {
    const wrong = [...rows].filter(([k, st]) => (st === 'UI') !== usedInWeb(k));
    expect(wrong).toEqual([]);
  });
});
