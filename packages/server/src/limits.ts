import type { PrincipalLimits } from "@microagent/core";

interface Bucket {
  windowStart: number;
  requests: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

export interface LimitDecision {
  allowed: boolean;
  reason?: string;
  /** Seconds until the current window resets, for a `Retry-After` header. */
  retryAfterSec?: number;
}

/**
 * Per-principal rate and cost limits.
 *
 * Per principal rather than per process: a process-wide limit means the busiest
 * caller sets everyone else's ceiling, and one caller can starve the rest
 * without exceeding any limit of their own.
 *
 * A fixed window rather than a token bucket, deliberately — the point is to
 * bound one caller's share, and a burst at a window edge is a smaller problem
 * than the extra state a smoother algorithm needs. Swap it out if that stops
 * being true.
 */
export class PrincipalRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly limits: PrincipalLimits = {}) {}

  get enabled(): boolean {
    return Boolean(this.limits.requestsPerMinute || this.limits.tokensPerMinute);
  }

  /** Check and count one request. */
  admit(subject: string, now = Date.now()): LimitDecision {
    if (!this.limits.requestsPerMinute) return { allowed: true };

    const bucket = this.bucket(subject, now);
    if (bucket.requests >= this.limits.requestsPerMinute) {
      return {
        allowed: false,
        reason: `request rate limit exceeded (${this.limits.requestsPerMinute}/min)`,
        retryAfterSec: this.retryAfter(bucket, now),
      };
    }
    bucket.requests++;
    return { allowed: true };
  }

  /**
   * Check the token budget before spending it.
   *
   * Called before admitting a turn, so a caller already over budget is turned
   * away rather than being allowed one more expensive run.
   */
  checkTokens(subject: string, now = Date.now()): LimitDecision {
    if (!this.limits.tokensPerMinute) return { allowed: true };

    const bucket = this.bucket(subject, now);
    if (bucket.tokens >= this.limits.tokensPerMinute) {
      return {
        allowed: false,
        reason: `token rate limit exceeded (${this.limits.tokensPerMinute}/min)`,
        retryAfterSec: this.retryAfter(bucket, now),
      };
    }
    return { allowed: true };
  }

  /** Record tokens actually spent. */
  recordTokens(subject: string, tokens: number, now = Date.now()): void {
    if (!this.limits.tokensPerMinute) return;
    this.bucket(subject, now).tokens += tokens;
  }

  private bucket(subject: string, now: number): Bucket {
    const existing = this.buckets.get(subject);
    if (existing && now - existing.windowStart < WINDOW_MS) return existing;

    const fresh: Bucket = { windowStart: now, requests: 0, tokens: 0 };
    this.buckets.set(subject, fresh);

    // Opportunistic cleanup: without it a process serving many short-lived
    // subjects accumulates a bucket per subject forever.
    if (this.buckets.size > 10_000) {
      for (const [key, value] of this.buckets) {
        if (now - value.windowStart >= WINDOW_MS) this.buckets.delete(key);
      }
    }

    return fresh;
  }

  private retryAfter(bucket: Bucket, now: number): number {
    return Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
  }
}
