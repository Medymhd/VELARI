/**
 * Provider scope policy — port of reference `provider-scope-policy.ts` +
 * `context-os/SourceAuthorityKernel.ts`. Single mapping `scopesForPayload`.
 */
export type Scope = "profile" | "meeting" | "screen" | "knowledge" | "browser";

export interface ScopePolicy {
  allowed: Set<Scope>;
  denied: Set<Scope>;
}

export function scopesForPayload(payload: { hasProfile?: boolean; hasMeeting?: boolean; hasScreen?: boolean }): Scope[] {
  const out: Scope[] = [];
  if (payload.hasProfile) out.push("profile");
  if (payload.hasMeeting) out.push("meeting");
  if (payload.hasScreen) out.push("screen");
  return out;
}

export function isScopeAllowed(policy: ScopePolicy, scope: Scope): boolean {
  return policy.allowed.has(scope) && !policy.denied.has(scope);
}

export function filterByPolicy<T extends { scope: Scope }>(items: T[], policy: ScopePolicy): T[] {
  return items.filter((i) => isScopeAllowed(policy, i.scope));
}
