import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "./env.js";
import { constantTimeEqual } from "@app/security";

export interface AuthUser {
  userId: string;
}

declare module "fastify" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface FastifyRequest {
    user?: AuthUser | undefined;
  }
}

export function issueToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: "12h", jwtid: randomUUID() });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { sub?: string };
    return payload.sub ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const queryToken = (req.query as Record<string, string> | undefined)?.token;
  const token = bearer ?? queryToken;

  const user = token ? verifyToken(token) : null;
  if (!user) {
    void constantTimeEqual(token ?? "", "");
    await reply.status(401).send({ error: "unauthorized" });
    return reply as never; // unreachable; satisfies strict returns
  }
  req.user = user;
}

/** Protects every /v1 route except /v1/auth/* and the self-authenticating STT relay WS. */
export function registerAuth(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/v1/") || req.url.startsWith("/v1/auth") || req.url.startsWith("/v1/stt/relay")) return;
    await requireAuth(req, reply);
  });
}

