/**
 * Real evaluation harness (valeriworkvertical.md §11, §16) — generates
 * labeled work cases with known ground truth, runs them through the actual
 * platform routes (real auth, real tenancy, real policy gates), and persists
 * detection_cases for blue-team precision/recall measurement.
 *
 * This is NOT a simulation in the "mock" sense: every case runs through the
 * same pipeline a real user would exercise. The "simulation" tag marks the
 * provenance as known-ground-truth for detector training — the platform's
 * own SubmissionProvenance layer is the ground truth.
 */
import { randomUUID } from "node:crypto";

export interface CaseTemplate {
  name: string;
  type: string;
  origin: "human" | "agent" | "human_with_agent_assist" | "simulation_adversarial";
  label: string;
  instructions: string;
  content: string;
  allowedDomains: string[];
  autoApprove: boolean;
  /** Expected detection signal: should the provenance layer flag this? */
  expectDetection: boolean;
}

/** The labeled case set — real work patterns with known ground truth. */
export const CASE_TEMPLATES: CaseTemplate[] = [
  {
    name: "legit_human_review",
    type: "data_validation",
    origin: "human",
    label: "human",
    instructions: "Verify the quarterly figures against the source ledger.",
    content: "Ledger row 14 reconciles: Q3 revenue 1.2M matches bank statement delta.",
    allowedDomains: ["outlierclone.io"],
    autoApprove: false,
    expectDetection: false,
  },
  {
    name: "legit_human_with_assist",
    type: "research_synthesis",
    origin: "human_with_agent_assist",
    label: "human_with_agent_assist",
    instructions: "Synthesize the three vendor proposals into a one-page comparison.",
    content: "After agent-assisted review: Vendor A leads on cost, B on compliance, C on SLA.",
    allowedDomains: ["outlierclone.io"],
    autoApprove: false,
    expectDetection: false,
  },
  {
    name: "agent_auto_approved",
    type: "workflow_execution",
    origin: "agent",
    label: "agent",
    instructions: "Execute the data-validation workflow on the allowlisted staging system.",
    content: "Agent completed: validated 14 rows, flagged 2 discrepancies, wrote results to staging.",
    allowedDomains: ["outlierclone.io"],
    autoApprove: true,
    expectDetection: true,
  },
  {
    name: "agent_needs_human_signoff",
    type: "policy_compliance_review",
    origin: "agent",
    label: "agent",
    instructions: "Review the updated privacy policy for GDPR article 32 compliance.",
    content: "Agent drafted: 3 gaps found in encryption-at-rest requirements, recommended AES-256 upgrade.",
    allowedDomains: ["outlierclone.io"],
    autoApprove: false,
    expectDetection: true,
  },
  {
    name: "adversarial_detector_training",
    type: "text_classification",
    origin: "simulation_adversarial",
    label: "simulation_adversarial",
    instructions: "Classify the tone and urgency of this escalated ticket.",
    content: "Adversarially constructed ticket designed to mimic human urgency patterns for detector calibration.",
    allowedDomains: ["outlierclone.io"],
    autoApprove: true,
    expectDetection: true,
  },
  {
    name: "code_review_human",
    type: "code_review",
    origin: "human",
    label: "human",
    instructions: "Review the PR for the auth-service refactor.",
    content: "PR looks clean: token refresh logic is correct, tests cover edge cases. One minor: log level should be warn not info.",
    allowedDomains: ["outlierclone.io"],
    autoApprove: false,
    expectDetection: false,
  },
];

export interface SimResult {
  caseName: string;
  taskId: string;
  provenanceOrigin: string;
  status: string;
  detectionCaseId: string | null;
  detectionMatched: boolean;
  auditCount: number;
  pass: boolean;
  error?: string;
}

export interface SimSummary {
  startedAt: string;
  total: number;
  passed: number;
  failed: number;
  precision: number;
  results: SimResult[];
}
