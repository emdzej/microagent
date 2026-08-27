import type { Verifier } from "./auth.js";

/**
 * The scopes this deployment understands.
 *
 * Published in the discovery document so a client can request exactly what it
 * needs, rather than having the list live only in a deployment runbook.
 */
export const MICROAGENT_SCOPES = {
  sessionCreate: "microagent:session:create",
  sessionRead: "microagent:session:read",
  sessionWrite: "microagent:session:write",
  sessionDelete: "microagent:session:delete",
  modelRead: "microagent:model:read",
  modelWrite: "microagent:model:write",
  toolsRead: "microagent:tools:read",
} as const;

export const ALL_MICROAGENT_SCOPES: string[] = Object.values(MICROAGENT_SCOPES);

/** Which scope each route requires. Keys are `METHOD /path`. */
export const ROUTE_SCOPES: Record<string, string> = {
  "POST /sessions": MICROAGENT_SCOPES.sessionCreate,
  "GET /sessions": MICROAGENT_SCOPES.sessionRead,
  "GET /sessions/:id": MICROAGENT_SCOPES.sessionRead,
  "DELETE /sessions/:id": MICROAGENT_SCOPES.sessionDelete,
  "POST /sessions/:id/messages": MICROAGENT_SCOPES.sessionWrite,
  "POST /sessions/:id/messages/stream": MICROAGENT_SCOPES.sessionWrite,
  "POST /chat": MICROAGENT_SCOPES.sessionWrite,
  "POST /chat/stream": MICROAGENT_SCOPES.sessionWrite,
  "GET /tools": MICROAGENT_SCOPES.toolsRead,
  "GET /models": MICROAGENT_SCOPES.modelRead,
  "GET /model": MICROAGENT_SCOPES.modelRead,
  "POST /model": MICROAGENT_SCOPES.modelWrite,
  "GET /stats": MICROAGENT_SCOPES.modelRead,
};

/**
 * The body of `GET /.well-known/microagent-config`.
 *
 * Field names are snake_case to match the OAuth and OIDC documents a client is
 * already parsing alongside this one.
 */
export interface MicroagentDiscoveryDocument {
  issuer: string;
  audience?: string;
  scopes: string[];
  authorization_endpoint?: string;
  token_endpoint?: string;
  device_authorization_endpoint?: string;
  /**
   * A shared OAuth `client_id` that every client of this deployment may use.
   * Optional — a client may bring its own and ignore this.
   */
  client_id_hint?: string;
}

/**
 * Build the discovery document.
 *
 * Why a microagent-specific path rather than reusing the OIDC one: the OIDC
 * spec's `.well-known/openid-configuration` is the *IdP's* document, served by
 * the IdP. This one is served by the agent and carries deployment-specific
 * metadata — the scopes this API understands and the shared `client_id_hint` —
 * that has no place in the IdP's response.
 *
 * The point of publishing it at all is that a CLI should not need the IdP's URL
 * compiled into it. It asks the deployment where to authenticate, then runs the
 * OAuth flow itself.
 */
export function buildDiscoveryDocument(verifier: Verifier): MicroagentDiscoveryDocument {
  return {
    issuer: verifier.issuer,
    ...(verifier.audience ? { audience: verifier.audience } : {}),
    scopes: verifier.scopes.length ? verifier.scopes : ALL_MICROAGENT_SCOPES,
    ...(verifier.endpoints.authorizationEndpoint
      ? { authorization_endpoint: verifier.endpoints.authorizationEndpoint }
      : {}),
    ...(verifier.endpoints.tokenEndpoint
      ? { token_endpoint: verifier.endpoints.tokenEndpoint }
      : {}),
    ...(verifier.endpoints.deviceAuthorizationEndpoint
      ? { device_authorization_endpoint: verifier.endpoints.deviceAuthorizationEndpoint }
      : {}),
    ...(verifier.clientIdHint ? { client_id_hint: verifier.clientIdHint } : {}),
  };
}
