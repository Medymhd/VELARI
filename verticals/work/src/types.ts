/**
 * Work domain contracts — mirrors valeriworkvertical.md §6, §7, §10.
 * Kept in vertical package; shared contracts stay generic in @app/contracts.
 * Uses functional, brand-neutral naming.
 */

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
    allowedDomains: string[]; // default [] blank for now; canonical outlierclone.io when populated
    autoApprove: boolean; // major test with other team — when true, external_write auto-approves if policy allows
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

export function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return false; // blank default for now — nothing allowed until workspace sets policy
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedDomains.some((d) => {
      const norm = d.toLowerCase().replace(/^\*\./, "");
      return host === norm || host.endsWith(`.${norm}`);
    });
  } catch {
    return false;
  }
}

export function requiresApproval(risk: string, autoApprove: boolean): boolean {
  if (risk !== "external_write" && risk !== "sensitive") return false;
  return !autoApprove;
}
