import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.js";

const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

const TOKEN_FILE = "github-copilot-token.json";

interface OAuthToken {
  access_token: string;
  token_type: string;
  scope: string;
}

interface CopilotSessionToken {
  token: string;
  expires_at: number; // unix timestamp
}

interface CachedAuth {
  oauthToken: string;
  sessionToken: string;
  expiresAt: number;
}

/** Callbacks for the device flow UI */
export interface DeviceFlowCallbacks {
  /** Show the user code and verification URL */
  onUserCode: (code: string, verificationUri: string) => void;
  /** Called when polling for authorization */
  onPolling: () => void;
  /** Called when auth is complete */
  onComplete: () => void;
  /** Called on error */
  onError: (message: string) => void;
}

function tokenPath(): string {
  return join(paths.data(), TOKEN_FILE);
}

function loadCachedAuth(): CachedAuth | null {
  const p = tokenPath();
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as CachedAuth;
    return data;
  } catch {
    return null;
  }
}

function saveCachedAuth(auth: CachedAuth): void {
  const dir = paths.data();
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

/** Get a Copilot session token from an OAuth token */
async function getCopilotSessionToken(oauthToken: string): Promise<CopilotSessionToken> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${oauthToken}`,
      Accept: "application/json",
      "User-Agent": "microagent/0.1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to get Copilot token: ${res.status} ${await res.text()}`);
  }

  return (await res.json()) as CopilotSessionToken;
}

/**
 * Get a valid Copilot API token.
 * Returns cached session token if still valid, otherwise:
 * - If we have a cached OAuth token, refresh the session token
 * - Otherwise, run the device OAuth flow
 */
export async function getCopilotToken(callbacks?: DeviceFlowCallbacks): Promise<string> {
  const cached = loadCachedAuth();

  // Cached session token still valid (with 5 min buffer)
  if (cached && cached.expiresAt > Date.now() / 1000 + 300) {
    return cached.sessionToken;
  }

  // Have OAuth token — just refresh session
  if (cached?.oauthToken) {
    try {
      const session = await getCopilotSessionToken(cached.oauthToken);
      const auth: CachedAuth = {
        oauthToken: cached.oauthToken,
        sessionToken: session.token,
        expiresAt: session.expires_at,
      };
      saveCachedAuth(auth);
      return session.token;
    } catch {
      // OAuth token may be revoked — fall through to device flow
    }
  }

  // Full device flow
  return runDeviceFlow(callbacks);
}

async function runDeviceFlow(callbacks?: DeviceFlowCallbacks): Promise<string> {
  // Step 1: Request device code
  const codeRes = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "microagent/0.1.0",
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!codeRes.ok) {
    throw new Error(`Device code request failed: ${codeRes.status} ${await codeRes.text()}`);
  }

  const codeData = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };

  callbacks?.onUserCode(codeData.user_code, codeData.verification_uri);

  // Step 2: Poll for authorization
  const interval = (codeData.interval || 5) * 1000;
  const deadline = Date.now() + codeData.expires_in * 1000;
  let oauthToken: OAuthToken | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    callbacks?.onPolling();

    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "microagent/0.1.0",
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: codeData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const tokenData = (await tokenRes.json()) as Record<string, string>;

    if (tokenData.access_token) {
      oauthToken = tokenData as unknown as OAuthToken;
      break;
    }

    if (tokenData.error === "authorization_pending") continue;
    if (tokenData.error === "slow_down") {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (tokenData.error === "expired_token") {
      throw new Error("Device code expired. Please try again.");
    }
    if (tokenData.error === "access_denied") {
      throw new Error("Authorization denied by user.");
    }
    if (tokenData.error) {
      throw new Error(`OAuth error: ${tokenData.error} — ${tokenData.error_description ?? ""}`);
    }
  }

  if (!oauthToken) {
    throw new Error("Device flow timed out. Please try again.");
  }

  // Step 3: Get Copilot session token
  const session = await getCopilotSessionToken(oauthToken.access_token);

  const auth: CachedAuth = {
    oauthToken: oauthToken.access_token,
    sessionToken: session.token,
    expiresAt: session.expires_at,
  };
  saveCachedAuth(auth);

  callbacks?.onComplete();
  return session.token;
}
