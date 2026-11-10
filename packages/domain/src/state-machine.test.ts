import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  canTransition,
  transition,
  type TransitionTable,
} from './state-machine';

type S = 'DRAFT' | 'ISSUED' | 'CANCELLED';
type E = 'finalize' | 'cancel';
const table: TransitionTable<S, E> = {
  DRAFT: { finalize: 'ISSUED', cancel: 'CANCELLED' },
  // ISSUED แก้ไม่ได้ (ใช้ใบลด/เพิ่มหนี้) — ไม่มี transition
};

describe('transition', () => {
  it('เดินตามตาราง', () => {
    expect(transition('doc', table, 'DRAFT', 'finalize')).toBe('ISSUED');
  });
  it('transition ที่ไม่มีในตารางโยน invalid_state_transition', () => {
    expect(() => transition('doc', table, 'ISSUED', 'cancel')).toThrow(InvalidTransitionError);
    expect(canTransition(table, 'ISSUED', 'cancel')).toBe(false);
  });
});
