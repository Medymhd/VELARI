/**
 * Assessment engine — rubric and scoring logic + calibration.
 * Port of valeriworkvertical.md §7 rubric architecture.
 * Concise, senior-grade: strict types, handled errors.
 */

export interface ScoreBand {
  min: number;
  max: number;
  label: string;
}

export interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  scoreBands: ScoreBand[];
  requiredEvidence: string[];
}

export interface Rubric {
  id: string;
  version: number;
  title: string;
  criteria: RubricCriterion[];
  gradingPolicy: { passThreshold: number };
  status: "draft" | "active" | "retired";
}

export interface AssessmentEvidence {
  criterionId: string;
  score: number;
  evidence: string[];
  confidence: number;
}

export interface Assessment {
  rubricId: string;
  taskId: string;
  evidences: AssessmentEvidence[];
  totalScore: number;
  normalized: number;
  pass: boolean;
}

export function scoreAssessment(rubric: Rubric, evidences: AssessmentEvidence[]): Assessment {
  let totalScore = 0;
  let maxScore = 0;

  for (const c of rubric.criteria) {
    const ev = evidences.find((e) => e.criterionId === c.id);
    const bandMax = Math.max(...c.scoreBands.map((b) => b.max));
    maxScore += bandMax * c.weight;
    if (ev) {
      const clamped = Math.max(0, Math.min(bandMax, ev.score));
      totalScore += clamped * c.weight;
    }
  }

  const normalized = maxScore === 0 ? 0 : totalScore / maxScore;
  return {
    rubricId: rubric.id,
    taskId: "",
    evidences,
    totalScore,
    normalized,
    pass: normalized >= (rubric.gradingPolicy.passThreshold ?? 0.6),
  };
}

export function calibrationDrift(current: number[], baseline: number[]): number {
  if (current.length === 0 || baseline.length === 0) return 0;
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.abs(avg(current) - avg(baseline));
}
