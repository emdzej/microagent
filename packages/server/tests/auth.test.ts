import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject } from "jose";
import { Verifier, AuthError, toPrincipal, bearerFrom, scopeAuthorizer } from "../src/auth.js";

const ISSUER = "https://idp.example.test/realms/microagent";
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;
const AUDIENCE = "microagent";

let privateKey: KeyObject;
let publicJwk: JWK;
/** A second key the IdP does not publish, for the wrong-key case. */
let attackerKey: KeyObject;

let jwksFetches = 0;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as KeyObject;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  const attacker = await generateKeyPair("RS256", { extractable: true });
  attackerKey = attacker.privateKey as KeyObject;
});

/**
 * Serve the IdP's discovery document and JWKS from a stubbed fetch.
 *
 * This is what makes the verification order testable without a live Keycloak:
 * the verifier has to discover `jwks_uri` from the issuer, then fetch keys from
 * it, and both steps are observable here.
 */
function stubIdp(options: { jwks?: { keys: JWK[] }; discovery?: Record<string, unknown> } = {}) {
  jwksFetches = 0;
  const discovery = options.discovery ?? {
    issuer: ISSUER,
    jwks_uri: JWKS_URI,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    device_authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth/device`,
  };
  const jwks = options.jwks ?? { keys: [publicJwk] };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(JSON.stringify(discovery), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === JWKS_URI) {
        jwksFetches++;
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

interface TokenOverrides {
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  scope?: string;
  expiresIn?: string;
  notBefore?: string;
  kid?: string;
  key?: KeyObject;
  azp?: string;
  extra?: Record<string, unknown>;
}

async function token(overrides: TokenOverrides = {}): Promise<string> {
  const jwt = new SignJWT({
    scope: overrides.scope ?? "microagent:session:create microagent:session:write",
    ...(overrides.azp ? { azp: overrides.azp } : {}),
    ...overrides.extra,
  })
    .setProtectedHeader({ alg: "RS256", kid: overrides.kid ?? "test-key" })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? "user-123")
    .setExpirationTime(overrides.expiresIn ?? "5m");

  if (overrides.notBefore) jwt.setNotBefore(overrides.notBefore);
  return jwt.sign(overrides.key ?? privateKey);
}

function verifier(overrides: Record<string, unknown> = {}) {
  return Verifier.create({ issuer: ISSUER, audience: AUDIENCE, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery at startup", () => {
  it("resolves jwks_uri and the client-facing endpoints from the issuer", async () => {
    stubIdp();
    const v = await verifier();

    expect(v.issuer).toBe(ISSUER);
    expect(v.audience).toBe(AUDIENCE);
    expect(v.endpoints.tokenEndpoint).toBe(`${ISSUER}/protocol/openid-connect/token`);
    expect(v.endpoints.deviceAuthorizationEndpoint).toBe(
      `${ISSUER}/protocol/openid-connect/auth/device`
    );
  });

  /**
   * A misconfigured issuer must fail the process at startup, not turn every
   * later request into a confusing 401.
   */
  it("fails when discovery is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(verifier()).rejects.toThrow(/OIDC discovery failed/);
  });

  it("rejects an issuer that disagrees with the document it serves", async () => {
    stubIdp({ discovery: { issuer: "https://other.example.test", jwks_uri: JWKS_URI } });
    await expect(verifier()).rejects.toThrow(/OIDC discovery mismatch/);
  });

  it("fails when the IdP advertises no jwks_uri", async () => {
    stubIdp({ discovery: { issuer: ISSUER } });
    await expect(verifier()).rejects.toThrow(/did not advertise a jwks_uri/);
  });

  it("skips discovery when jwksUri is configured explicitly", async () => {
    stubIdp();
    const v = await Verifier.create({ issuer: ISSUER, audience: AUDIENCE, jwksUri: JWKS_URI });
    await expect(v.verify(await token())).resolves.toMatchObject({ subject: "user-123" });
  });
});

describe("token verification", () => {
  it("accepts a well-formed token and builds a principal", async () => {
    stubIdp();
    const v = await verifier();
    const principal = await v.verify(await token({ extra: { email: "a@example.test" } }));

    expect(principal.subject).toBe("user-123");
    expect(principal.email).toBe("a@example.test");
    expect(principal.scopes).toEqual([
      "microagent:session:create",
      "microagent:session:write",
    ]);
  });

  it("rejects a token signed by a key the IdP does not publish", async () => {
    stubIdp();
    const v = await verifier();
    await expect(v.verify(await token({ key: attackerKey }))).rejects.toThrow(AuthError);
  });

  /**
   * The `alg: none` class of bug. The allowlist is fixed at construction, so
   * the token's own header never gets a say in how it is verified.
   */
  it("refuses an unsigned token", async () => {
    stubIdp();
    const v = await verifier();

    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: "user-123", exp: 9999999999 })
    ).toString("base64url");

    await expect(v.verify(`${header}.${payload}.`)).rejects.toThrow(AuthError);
  });

  it("refuses to be configured with none as an algorithm", async () => {
    stubIdp();
    await expect(verifier({ algorithms: ["none"] })).rejects.toThrow(
      /left no usable algorithm/
    );
  });

  it("rejects a mismatched issuer", async () => {
    stubIdp();
    const v = await verifier();
    await expect(v.verify(await token({ issuer: "https://evil.example.test" }))).rejects.toThrow(
      /invalid token/
    );
  });

  it("rejects a mismatched audience", async () => {
    stubIdp();
    const v = await verifier();
    await expect(v.verify(await token({ audience: "some-other-api" }))).rejects.toThrow(
      /invalid token/
    );
  });

  it("accepts a token whose audience list contains the configured value", async () => {
    stubIdp();
    const v = await verifier();
    await expect(
      v.verify(await token({ audience: ["account", AUDIENCE] }))
    ).resolves.toMatchObject({ subject: "user-123" });
  });

  it("rejects an expired token", async () => {
    stubIdp();
    const v = await verifier();
    await expect(v.verify(await token({ expiresIn: "-10m" }))).rejects.toThrow(/invalid token/);
  });

  it("rejects a token that is not yet valid", async () => {
    stubIdp();
    const v = await verifier();
    await expect(v.verify(await token({ notBefore: "10m" }))).rejects.toThrow(/invalid token/);
  });

  /** Small skew allowance, so a slightly fast clock is not an outage. */
  it("tolerates clock skew within the allowance", async () => {
    stubIdp();
    const v = await verifier({ clockSkewSec: 120 });
    await expect(v.verify(await token({ expiresIn: "-30s" }))).resolves.toMatchObject({
      subject: "user-123",
    });
  });

  it("enforces azp when configured", async () => {
    stubIdp();
    const v = await verifier({ authorizedParty: "microagent-cli" });
    await expect(v.verify(await token({ azp: "microagent-cli" }))).resolves.toBeDefined();
    await expect(v.verify(await token({ azp: "other-app" }))).rejects.toThrow(/azp/);
  });

  it("returns 403, not 401, when a required scope is missing", async () => {
    stubIdp();
    const v = await verifier({ requiredScopes: ["microagent:admin"] });
    await expect(v.verify(await token())).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("microagent:admin"),
    });
  });

  /**
   * Key rotation without a restart. The cooldown that makes this safe is the
   * same mechanism that stops an unknown-`kid` flood from turning every request
   * into an outbound fetch.
   */
  it("caches keys across verifications", async () => {
    stubIdp();
    const v = await verifier();
    await v.verify(await token());
    await v.verify(await token());
    expect(jwksFetches).toBe(1);
  });
});

describe("claim extraction", () => {
  it("reads space-delimited scope and Azure-style scp", () => {
    expect(toPrincipal({ sub: "a", scope: "one two" }).scopes).toEqual(["one", "two"]);
    expect(toPrincipal({ sub: "a", scp: ["one", "two"] }).scopes).toEqual(["one", "two"]);
  });

  it("reads groups, roles, and Keycloak realm_access.roles", () => {
    expect(toPrincipal({ sub: "a", groups: ["g1"] }).groups).toEqual(["g1"]);
    expect(
      toPrincipal({ sub: "a", realm_access: { roles: ["ops", "dev"] } }).groups
    ).toEqual(["ops", "dev"]);
  });

  it("takes the client id from azp or client_id", () => {
    expect(toPrincipal({ sub: "a", azp: "cli" }).clientId).toBe("cli");
    expect(toPrincipal({ sub: "a", client_id: "svc" }).clientId).toBe("svc");
  });
});

describe("bearerFrom", () => {
  it("extracts the token", () => {
    expect(bearerFrom("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerFrom("bearer abc")).toBe("abc");
  });

  it("rejects a missing or malformed header", () => {
    expect(() => bearerFrom(undefined)).toThrow(/missing Authorization/);
    expect(() => bearerFrom("Basic dXNlcjpwYXNz")).toThrow(/must be a Bearer token/);
  });
});

describe("scopeAuthorizer", () => {
  const authorize = scopeAuthorizer({ "POST /sessions": "microagent:session:create" });
  const principal = {
    subject: "a",
    groups: [],
    scopes: ["microagent:session:create"],
  };

  it("allows a route the principal has the scope for", async () => {
    expect(await authorize(principal, { method: "POST", path: "/sessions" })).toEqual({
      allow: true,
    });
  });

  it("denies when the scope is absent", async () => {
    expect(
      await authorize({ ...principal, scopes: [] }, { method: "POST", path: "/sessions" })
    ).toEqual({ allow: false, reason: "missing scope microagent:session:create" });
  });

  /** Deny-by-default: an unmapped route is refused, not waved through. */
  it("denies a route with no policy entry", async () => {
    expect(await authorize(principal, { method: "GET", path: "/secret" })).toEqual({
      allow: false,
      reason: "no policy for GET /secret",
    });
  });
});
