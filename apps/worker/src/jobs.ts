import { PrismaClient } from "@prisma/client";
import { logger } from "@app/observability";
import { offlineSummary } from "@app/vertical-interview-intelligence";

const log = logger({ svc: "worker" });

const prisma = new PrismaClient();

function deadlineFor(policy: string, endedAt: Date): number {
  switch (policy) {
    case "delete_on_end":
      return endedAt.getTime();
    case "retain_30d":
      return endedAt.getTime() + 30 * 24 * 3600 * 1000;
    case "retain_90d":
    default:
      return endedAt.getTime() + 90 * 24 * 3600 * 1000;
  }
}

export async function postSessionSummary(sessionId: string): Promise<{ summaryId: string }> {
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error("session not found");
  const segments = await prisma.transcriptSegment.findMany({ where: { sessionId, isFinal: true }, orderBy: { sequenceNo: "asc" } });
  const transcript = segments.map((s) => s.text).join("\n");
  const contentJson = offlineSummary(transcript) as Record<string, unknown>;
  const row = await prisma.sessionInsight.create({
    data: {
      sessionId,
      type: "summary",
      sourceSegmentIds: segments.slice(-5).map((s) => s.id),
      contentJson: contentJson as any,
      modelTraceId: null,
    },
  });
  await prisma.auditEvent.create({
    data: {
      workspaceId: session.workspaceId,
      actorType: "service",
      actorId: "summary-reducer",
      eventType: "session.summarized",
      resourceType: "interview_session",
      resourceId: sessionId,
      metadataJson: { insightId: row.id } as any,
    },
  });
  log.info("post-session summary created", { sessionId, summaryId: row.id });
  return { summaryId: row.id };
}

export async function retentionSweep(): Promise<{ deleted: number }> {
  const now = Date.now();
  const candidates = await prisma.interviewSession.findMany({
    where: { status: { in: ["completed", "failed"] }, endedAt: { not: null } },
    take: 500,
  });

  let deleted = 0;
  for (const s of candidates) {
    if (!s.endedAt) continue;
    if (deadlineFor(s.retentionPolicy, s.endedAt) > now) continue;

    log.info("retention sweep deleting session", { sessionId: s.id, policy: s.retentionPolicy });
    await prisma.$transaction([
      prisma.transcriptSegment.deleteMany({ where: { sessionId: s.id } }),
      prisma.sessionInsight.deleteMany({ where: { sessionId: s.id } }),
      prisma.artifact.deleteMany({ where: { sessionId: s.id } }),
      prisma.usageRecord.deleteMany({ where: { sessionId: s.id } }),
      prisma.interviewSession.delete({ where: { id: s.id } }),
    ]);
    await prisma.auditEvent.create({
      data: {
        workspaceId: s.workspaceId,
        actorType: "service",
        actorId: "retention-sweeper",
        eventType: "retention.purged",
        resourceType: "interview_session",
        resourceId: s.id,
        metadataJson: { retentionPolicy: s.retentionPolicy } as any,
      },
    });
    deleted++;
  }
  if (deleted > 0) log.info("retention sweep complete", { deleted });
  return { deleted };
}
