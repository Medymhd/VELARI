import type { PrismaClient } from "@prisma/client";

export type AuditInput = {
  workspaceId?: string | null;
  actorType: "user" | "agent" | "service";
  actorId?: string | null;
  eventType: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadataJson?: Record<string, unknown>;
};

/** Append-only audit trail (doc §11) — access, exports, deletions, changes. */
export function writeAudit(db: PrismaClient, input: AuditInput): Promise<unknown> {
  return db.auditEvent.create({
    data: {
      workspaceId: input.workspaceId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      eventType: input.eventType,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      metadataJson: (input.metadataJson ?? {}) as any,
    },
  } as any);
}
