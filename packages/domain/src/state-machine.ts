/**
 * ตัวช่วย state machine แบบตาราง (docs/01 §4) — ใช้กับ SO/DO/เที่ยว/เอกสารภาษี
 * ตาราง transition ของแต่ละเอกสารจะถูกเพิ่มใน stage ที่เกี่ยวข้อง (ST3–ST6) พร้อม test ทุก transition
 */
export type TransitionTable<S extends string, E extends string> = {
  readonly [From in S]?: { readonly [Ev in E]?: S };
};

export class InvalidTransitionError<S extends string, E extends string> extends Error {
  readonly code = 'invalid_state_transition' as const;
  constructor(
    readonly entity: string,
    readonly from: S,
    readonly event: E,
  ) {
    super(`${entity}: cannot apply '${event}' from '${from}'`);
  }
}

export function transition<S extends string, E extends string>(
  entity: string,
  table: TransitionTable<S, E>,
  from: S,
  event: E,
): S {
  const next = table[from]?.[event];
  if (next === undefined) throw new InvalidTransitionError(entity, from, event);
  return next;
}

export function canTransition<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  from: S,
  event: E,
): boolean {
  return table[from]?.[event] !== undefined;
}
