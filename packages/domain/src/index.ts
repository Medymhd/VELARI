/**
 * App domain layer: entities' invariants, pure use-case logic.
 * No IO here â€” everything is testable and portable (desktop reuse later).
 */
import type { ConsentStatus, SessionStatus, TranscriptSegmentDto } from "@app/contracts";

export class DomainError extends Error {
  constructor(
    public readonly code:
      | "consent_required"
      | "invalid_transition"
      | "out_of_order_segment"
      | "policy_denied",
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/* â”€â”€ Session lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  draft: ["live", "failed"],
  live: ["paused", "completed", "failed"],
  paused: ["live", "completed", "failed"],
  completed: [],
  failed: [],
};

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new DomainError("invalid_transition", `cannot transition ${from} â†’ ${to}`);
  }
}

export function assertStartAllowed(consent: ConsentStatus): void {
  if (consent === "pending") {
    throw new DomainError("consent_required", "recording consent must be confirmed before start");
  }
}

/* â”€â”€ Transcript assembler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export interface AssemblerState {
  nextSequenceNo: number;
  seenEventIds: Set<string>;
  partials: Map<number, TranscriptSegmentDto>;
  finals: TranscriptSegmentDto[];
}

export function newAssemblerState(): AssemblerState {
  return { nextSequenceNo: 0, seenEventIds: new Set(), partials: new Map(), finals: [] };
}

/**
 * Idempotent, ordered ingest of realtime transcript segments:
 * dedupes by eventId, rejects backwards sequences, keeps latest partial
 * per sequence, appends finals once.
 */
export function ingestSegment(state: AssemblerState, segment: TranscriptSegmentDto, eventId: string): void {
  if (state.seenEventIds.has(eventId)) return;
  state.seenEventIds.add(eventId);

  if (segment.sequenceNo < state.nextSequenceNo - 1) {
    throw new DomainError("out_of_order_segment", `sequence ${segment.sequenceNo} already superseded`);
  }
  state.nextSequenceNo = Math.max(state.nextSequenceNo, segment.sequenceNo + 1);

  if (segment.isFinal) {
    state.partials.delete(segment.sequenceNo);
    if (!state.finals.some((f) => f.sequenceNo === segment.sequenceNo)) {
      state.finals.push(segment);
      state.finals.sort((a, b) => a.sequenceNo - b.sequenceNo);
    }
  } else {
    state.partials.set(segment.sequenceNo, segment);
  }
}

/** Verbatim window for the coach prompt: last N finals + current partials. */
export function verbatimWindow(state: AssemblerState, maxSegments = 24): string {
  const finals = state.finals.slice(-maxSegments).map((s) => s.text);
  const partials = [...state.partials.values()].sort((a, b) => a.sequenceNo - b.sequenceNo).map((s) => s.text);
  return [...finals, ...partials].join("\n").slice(-12_000);
}

/* â”€â”€ Context window manager â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export interface ContextWindowState {
  verbatimSegmentIds: string[];
  rollingSummary: string;
}

export class ContextWindowManager {
  private state: ContextWindowState = { verbatimSegmentIds: [], rollingSummary: "" };
  constructor(private readonly verbatimBudgetChars = 8_000) {}

  pushFinal(segment: TranscriptSegmentDto): void {
    this.state.verbatimSegmentIds.push(segment.id);
    // Compact older verbatim content into the incremental summary.
    let total = 0;
    const kept: string[] = [];
    for (let i = this.state.verbatimSegmentIds.length - 1; i >= 0; i--) {
      total += segment.text.length; // approximation; real impl tracks per-segment lengths
      if (total > this.verbatimBudgetChars) break;
      kept.unshift(this.state.verbatimSegmentIds[i]!);
    }
    this.state.verbatimSegmentIds = kept;
    if (this.state.rollingSummary.length < 2_000) {
      this.state.rollingSummary += ` [${new Date().toISOString()}] discussed: ${segment.text.slice(0, 80)}â€¦`;
    }
  }

  snapshot(): ContextWindowState {
    return { ...this.state };
  }
}

/* â”€â”€ Retention policy resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

export function retentionDeadlineMs(policy: string, now = Date.now()): number {
  switch (policy) {
    case "delete_on_end":
      return now;
    case "retain_30d":
      return now + 30 * 24 * 3600 * 1000;
    case "retain_90d":
    default:
      return now + 90 * 24 * 3600 * 1000;
  }
}


