import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { OidcConfig, Principal } from "@microagent/core";

/** Algorithms we are willing to verify with. */
const DEFAULT_ALGORITHMS = ["RS256", "ES256"];

/**
 * How long to wait before refetching the JWKS after a miss.
 *
 * This is the DoS cap: without it, a stream of tokens carrying unknown `kid`
 * values turns every request into an outbound fetch against the IdP, and an
 * unauthenticated caller gets to drive that traffic.
 */
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_CLOCK_SKEW_SEC = 60;

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "AuthError";
  }
}

/** The subset of the IdP's discovery document clients need. */
export interface IdpEndpoints {
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  endSessionEndpoint?: string;
}

interface DiscoveryDocument {
  issuer?: string;
  jwks_uri?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
  end_session_endpoint?: string;
}

/**
 * Verifies bearer JWTs against a realm's JWKS.
 *
 * The verification order matters and is enforced by construction rather than by
 * convention: the algorithm allowlist is fixed at setup, so a token's own `alg`
 * header never gets a say in how it is verified — which is the whole `alg: none`
 * class of bug.
 */
export class Verifier {
  private constructor(
    readonly issuer: string,
    readonly audience: string | undefined,
    readonly endpoints: IdpEndpoints,
    readonly scopes: string[],
    readonly clientIdHint: string | undefined,
    private readonly jwks: JWTVerifyGetKey,
    private readonly algorithms: string[],
    private readonly clockSkewSec: number,
    private readonly authorizedParty: string | undefined,
    private readonly requiredScopes: string[]
  ) {}

  /**
   * Discover the IdP's configuration and build a verifier.
   *
   * Discovery happens here, at startup, so a misconfigured issuer fails the
   * process rather than turning every later request into a confusing 401.
   */
  static async create(
    config: OidcConfig,
    options: { fetch?: typeof fetch } = {}
  ): Promise<Verifier> {
    if (!config.issuer) throw new Error("auth.oidc.issuer is required");

    const algorithms = (config.algorithms ?? DEFAULT_ALGORITHMS).filter(
      (a) => a.toLowerCase() !== "none"
    );
    if (!algorithms.length) {
      throw new Error("auth.oidc.algorithms left no usable algorithm");
    }

    const issuer = config.issuer.replace(/\/$/, "");
    let endpoints: IdpEndpoints = {};
    let jwksUri = config.jwksUri;

    if (!jwksUri || !config.jwksUri) {
      const doc = await fetchDiscovery(issuer, options.fetch);
      // An issuer that does not match the document it serves means the URL and
      // the realm disagree; every `iss` check afterwards would be against the
      // wrong value.
      if (doc.issuer && doc.issuer.replace(/\/$/, "") !== issuer) {
        throw new Error(
          `OIDC discovery mismatch: configured issuer ${issuer} but document reports ${doc.issuer}`
        );
      }
      jwksUri = config.jwksUri ?? doc.jwks_uri;
      endpoints = {
        authorizationEndpoint: doc.authorization_endpoint,
        tokenEndpoint: doc.token_endpoint,
        deviceAuthorizationEndpoint: doc.device_authorization_endpoint,
        endSessionEndpoint: doc.end_session_endpoint,
      };
    }

    if (!jwksUri) {
      throw new Error(
        `OIDC discovery for ${issuer} did not advertise a jwks_uri — set auth.oidc.jwksUri explicitly`
      );
    }

    const jwks = createRemoteJWKSet(new URL(jwksUri), {
      // Refetch on an unknown `kid` so key rotation is picked up without a
      // restart, but not more often than the cooldown allows.
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    });

    return new Verifier(
      issuer,
      config.audience,
      endpoints,
      config.scopes ?? [],
      config.clientIdHint,
      jwks,
      algorithms,
      config.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC,
      config.authorizedParty,
      config.requiredScopes ?? []
    );
  }

  /**
   * Verify a raw token and reduce its claims to a `Principal`.
   *
   * @throws {AuthError} 401 for anything that fails verification.
   */
  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        algorithms: this.algorithms,
        issuer: this.issuer,
        // Only checked when configured. An unset audience is a development
        // convenience, and the discovery document reports it as empty so a
        // client can see the deployment is not audience-scoped.
        ...(this.audience ? { audience: this.audience } : {}),
        clockTolerance: this.clockSkewSec,
      });
      payload = result.payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The cause is kept for a server-side log; only `msg` reaches the client.
      throw new AuthError(401, `invalid token: ${msg}`, { cause: err });
    }

    if (this.authorizedParty && payload.azp !== this.authorizedParty) {
      throw new AuthError(401, "token azp does not match the configured authorized party");
    }

    if (!payload.sub) {
      throw new AuthError(401, "token has no subject");
    }

    const principal = toPrincipal(payload);

    const missing = this.requiredScopes.filter((s) => !principal.scopes.includes(s));
    if (missing.length) {
      throw new AuthError(403, `missing required scope(s): ${missing.join(", ")}`);
    }

    return principal;
  }

  /** Verify the value of an `Authorization` header. */
  async authenticate(header: string | undefined): Promise<Principal> {
    return this.verify(bearerFrom(header));
  }
}

async function fetchDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch
): Promise<DiscoveryDocument> {
  const url = `${issuer}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return (await res.json()) as DiscoveryDocument;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OIDC discovery failed for ${url}: ${msg}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

export function bearerFrom(header: string | undefined): string {
  if (!header) throw new AuthError(401, "missing Authorization header");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new AuthError(401, "Authorization header must be a Bearer token");
  return match[1].trim();
}

/**
 * Reduce verified claims to a principal.
 *
 * Scopes come from `scope` (space-delimited, RFC 8693) or `scp` (an array,
 * Azure-style); groups from `groups`, `roles`, or Keycloak's nested
 * `realm_access.roles`. Supporting all of these here means an authorisation
 * policy never has to know which IdP is in front of it.
 */
export function toPrincipal(payload: JWTPayload): Principal {
  return {
    subject: String(payload.sub),
    email: typeof payload.email === "string" ? payload.email : undefined,
    groups: extractGroups(payload),
    scopes: extractScopes(payload),
    clientId:
      typeof payload.azp === "string"
        ? payload.azp
        : typeof payload.client_id === "string"
          ? payload.client_id
          : undefined,
    claims: payload as Record<string, unknown>,
  };
}

function extractScopes(payload: JWTPayload): string[] {
  const scope = payload.scope;
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  const scp = payload.scp;
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === "string");
  if (typeof scp === "string") return scp.split(/\s+/).filter(Boolean);
  return [];
}

function extractGroups(payload: JWTPayload): string[] {
  const out = new Set<string>();
  for (const key of ["groups", "roles"] as const) {
    const value = payload[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string") out.add(entry);
    }
  }
  const realm = payload.realm_access;
  if (realm && typeof realm === "object" && Array.isArray((realm as { roles?: unknown }).roles)) {
    for (const entry of (realm as { roles: unknown[] }).roles) {
      if (typeof entry === "string") out.add(entry);
    }
  }
  return Array.from(out);
}

// ── Authorisation ──────────────────────────────────────────────────────────

export interface AuthorizeRequest {
  method: string;
  /** Route path, e.g. `/sessions/:id/messages`. */
  path: string;
  /** Session being addressed, when the route names one. */
  sessionId?: string;
}

export type AuthorizeDecision = { allow: true } | { allow: false; reason: string };

/**
 * Authorisation, kept separate from authentication.
 *
 * Deny-by-default and pluggable: a deployment's real policy — which
 * environments or namespaces a caller may touch — is domain knowledge that does
 * not belong in a generic runtime. What belongs here is the hook.
 */
export type Authorize = (
  principal: Principal,
  request: AuthorizeRequest
) => AuthorizeDecision | Promise<AuthorizeDecision>;

/** Requires the scope named for the route, and nothing more. */
export function scopeAuthorizer(routeScopes: Record<string, string>): Authorize {
  return (principal, request) => {
    const key = `${request.method.toUpperCase()} ${request.path}`;
    const required = routeScopes[key];
    if (!required) return { allow: false, reason: `no policy for ${key}` };
    if (!principal.scopes.includes(required)) {
      return { allow: false, reason: `missing scope ${required}` };
    }
    return { allow: true };
  };
}

/** Allows any authenticated caller. The default when no policy is supplied. */
export const allowAuthenticated: Authorize = () => ({ allow: true });
