import type { StopEvent, StopEventResolution } from '@prisma/client';
import type {
  StopEventDecision,
  StopEventLateReason,
  StopOutcome,
  StopSeqEvent,
  StopSeqResolution,
} from '@tms/domain';

export type StopEventWithResolution = StopEvent & { resolutions: StopEventResolution[] };

/** แถว → อินพุตของ domain `effectiveStopSequence` (การตัดสินทุกแถว — domain เลือกตัวที่ธงตรง) */
export function toSeqEvent<E extends StopEventWithResolution>(
  e: E,
): E & StopSeqEvent<StopEventResolution & StopSeqResolution> {
  return {
    ...e,
    type: e.type,
    outcome: e.outcome as StopOutcome | null,
    lateReason: e.lateReason as StopEventLateReason | null,
    resolutions: e.resolutions.map((r) => ({
      ...r,
      decision: r.decision as StopEventDecision,
      at: r.createdAt,
    })),
  };
}
