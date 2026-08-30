/**
 * Work domain contracts — mirrors valeriworkvertical.md §6, §7, §10.
 * Type definitions live here; shared helpers (domain gate, approval gate)
 * are re-exported from agent-sdk to avoid duplication across verticals.
 */
export {
  isDomainAllowed as isAllowedDomain,
  needsApproval as requiresApproval,
  canAccessWorkspace,
} from "@app/agent-sdk";

export type TaskStatus = "draft" | "assigned" | "in_progress" | "submitted" | "in_review" | "approved" | "returned" | "escalated" | "completed" | "archived";
export type TaskType =
  | "text_classification"
  | "document_extraction"
  | "image_annotation"
  | "video_annotation"
  | "audio_transcription"
  | "audio_quality_review"
  | "rubric_based_assessment"
  | "research_synthesis"
  | "policy_compliance_review"
  | "data_validation"
  | "customer_workflow_execution"
  | "code_review"
  | "workflow_execution"
  | "browser_task_execution";

export interface WorkTask {
  id: string;
  workspaceId: string;
  templateId: string;
  type: TaskType;
  status: TaskStatus;
  title: string;
  instructions: string;
  inputs: unknown[];
  rubricVersionId?: string;
  assignmentPolicy: { mode: "single" | "multi"; maxAssignees?: number };
  automationPolicy: {
    allowedTools: string[];
    allowedDomains: string[];
    autoApprove: boolean;
    budget?: { maxActions?: number; maxDurationMs?: number };
  };
  simulationTag?: "realistic_synthetic" | "simulation_adversarial" | "client_authorized";
  policyVersion: string;
  createdAt: string;
  dueAt?: string;
}

export interface SubmissionProvenance {
  origin: "human" | "agent" | "human_with_agent_assist" | "simulation_adversarial";
  agentRunId?: string;
  modelProfileId?: string;
  toolTraceId?: string;
  reviewState: "unreviewed" | "reviewed" | "approved";
  policyVersion: string;
}
