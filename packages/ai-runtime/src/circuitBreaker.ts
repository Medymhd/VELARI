/**
 * Per-(workspace, provider, model, taskClass) circuit breaker.
 * Architecture doc §5:
 *   open   after 5 transient failures in 60s
 *   half-open after 30s with one probe
 *   closed after 3 successful probes
 */
export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerConfig {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  probesToClose: number;
}

export const DEFAULT_BREAKER: BreakerConfig = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
  probesToClose: 3,
};

interface Entry {
  failures: number[];
  state: BreakerState;
  openedAt: number;
  successfulProbes: number;
  penalty: number;
}

export class CircuitBreakerRegistry {
  private entries = new Map<string, Entry>();

  private key(ws: string, providerId: string, model: string, taskClass: string): string {
    return `${ws}:${providerId}:${model}:${taskClass}`;
  }

  private entry(k: string): Entry {
    let e = this.entries.get(k);
    if (!e) {
      e = { failures: [], state: "closed", openedAt: 0, successfulProbes: 0, penalty: 0 };
      this.entries.set(k, e);
    }
    return e;
  }

  check(workspaceId: string, providerId: string, model: string, taskClass: string): { allowed: boolean; state: BreakerState } {
    const k = this.key(workspaceId, providerId, model, taskClass);
    const e = this.entry(k);
    const now = Date.now();

    if (e.state === "open" && now - e.openedAt >= DEFAULT_BREAKER.cooldownMs) {
      e.state = "half_open";
      e.successfulProbes = 0;
    }
    if (e.state === "open") return { allowed: false, state: e.state };
    if (e.state === "half_open") return { allowed: e.successfulProbes < 1 ? true : false, state: e.state };
    // closed: drop old failures
    e.failures = e.failures.filter((t) => now - t <= DEFAULT_BREAKER.windowMs);
    return { allowed: e.failures.length < DEFAULT_BREAKER.failureThreshold, state: e.state };
  }

  recordSuccess(workspaceId: string, providerId: string, model: string, taskClass: string): void {
    const e = this.entry(this.key(workspaceId, providerId, model, taskClass));
    e.penalty = Math.max(0, e.penalty - 0.1);
    if (e.state === "half_open") {
      e.successfulProbes += 1;
      if (e.successfulProbes >= DEFAULT_BREAKER.probesToClose) {
        e.state = "closed";
        e.failures = [];
        e.penalty = 0;
      }
    } else {
      e.failures = [];
    }
  }

  recordFailure(workspaceId: string, providerId: string, model: string, taskClass: string): void {
    const k = this.key(workspaceId, providerId, model, taskClass);
    const e = this.entry(k);
    const now = Date.now();
    if (e.state === "half_open") {
      e.state = "open";
      e.openedAt = now;
      e.penalty += 0.2;
      return;
    }
    e.failures.push(now);
    e.failures = e.failures.filter((t) => now - t <= DEFAULT_BREAKER.windowMs);
    if (e.failures.length >= DEFAULT_BREAKER.failureThreshold) {
      e.state = "open";
      e.openedAt = now;
      e.penalty += 0.3;
    }
  }

  penaltyFor(workspaceId: string, providerId: string, model: string, taskClass: string): number {
    return this.entry(this.key(workspaceId, providerId, model, taskClass)).penalty;
  }
}
