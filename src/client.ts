import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://pullboard.dev";

// Hosts for which plaintext http:// is tolerated — a developer running the API on their own
// machine. Anything else MUST be https://, because every request carries the bearer token in an
// Authorization header and http:// to a remote host puts that token on the wire in cleartext (and
// invites a downgrade/redirect to an attacker-chosen destination).
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Reject a baseUrl that would leak the bearer token to an insecure or unexpected destination.
 * https:// is always allowed; http:// is allowed ONLY for a loopback host (local dev). Every other
 * scheme (http:// to a remote host, and non-http(s) schemes like file://, ftp://, ws://) throws.
 * Mirrors the CLI/client finding-#4 fix so no Pullboard surface sends a token in cleartext.
 */
export function assertSafeBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(`Pullboard baseUrl must be an absolute URL, received: ${JSON.stringify(baseUrl)}`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return baseUrl;
  throw new TypeError(
    `Pullboard refuses to send your bearer token to ${url.protocol}//${url.host} — use https:// ` +
      "(plain http:// is allowed only for localhost/127.0.0.1 during development).",
  );
}

/**
 * Redact a bearer token to a short, non-reconstructable prefix for display only. The full token is
 * written to a 0600 file and stays usable — it is just never echoed in model-visible tool output.
 */
export const redactToken = (token: string): string => `${String(token || "").slice(0, 6)}…`;

/** Directory where minted secondary tokens land. Overridable (mainly for tests) via env. */
const tokenDir = (): string => process.env.PULLBOARD_TOKEN_DIR || join(homedir(), ".pullboard", "tokens");

/**
 * Persist a freshly minted bearer token to a local 0600 file and return ONLY non-secret metadata
 * (the absolute path + a redacted prefix). The raw token is written to disk — so a second identity
 * can still use it — but is NEVER returned to the model. Mirrors the CLI's finding-#2 fix, where the
 * full token lives in ~/.pullboard/config.json (0600) and only a redacted prefix is printed.
 */
export function persistMintedToken(token: string, label?: string): { tokenFile: string; redacted: string } {
  const dir = tokenDir();
  mkdirSync(dir, { recursive: true });
  const safeLabel = (label || "verifier").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40) || "verifier";
  const tokenFile = join(dir, `${safeLabel}-${Date.now().toString(36)}.token`);
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return { tokenFile, redacted: redactToken(token) };
}

/** Minimal shape of the OpenClaw config we read — the plugin's own entry config. */
export type PullboardCfg =
  | { plugins?: { entries?: { pullboard?: { config?: { token?: string; baseUrl?: string } } } } }
  | undefined;

/**
 * Resolve the workspace token + base URL from the plugin's config, falling back to
 * environment variables — the same precedence the CLI uses. The token is a secret
 * (declared `sensitive` in the manifest) and is never returned in a tool result.
 */
export function resolvePullboardConfig(cfg: PullboardCfg): { baseUrl: string; token?: string } {
  const entry = cfg?.plugins?.entries?.pullboard?.config ?? {};
  const token = entry.token || process.env.PULLBOARD_TOKEN;
  const baseUrl = (entry.baseUrl || process.env.PULLBOARD_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  return { baseUrl, token };
}

/** A caller request id or a fresh one, for mutation replay safety (idempotency). */
export const withRequestId = <T extends Record<string, unknown>>(input: T): T & { requestId: string } => ({
  ...input,
  requestId: (input.requestId as string) || randomUUID(),
});

/**
 * Issue one authenticated Pullboard API request and surface stable error metadata
 * (message + server `fix`) so a tool can report the remedy, not a bare status code.
 */
export async function pullboardRequest(
  cfg: PullboardCfg,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const { baseUrl, token } = resolvePullboardConfig(cfg);
  // Guard the destination before the token ever leaves this process: a config/env baseUrl of
  // http://<remote> or a non-web scheme would leak the bearer token, so fail closed here — this is
  // the single choke point every authenticated tool call flows through.
  assertSafeBaseUrl(baseUrl);
  if (!token) {
    throw new Error(
      `No Pullboard token. Set PULLBOARD_TOKEN or plugins.entries.pullboard.config.token. ` +
        `No signup needed — mint one: POST ${baseUrl}/api/accounts/anon-provision {"label":"your-agent"}.`,
    );
  }
  const { method = "GET", body } = init;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message = (payload.message as string) || (payload.error as string) || `Pullboard request failed (${response.status})`;
    const fix = payload.fix ? ` (fix: ${payload.fix})` : "";
    const error = new Error(`${message}${fix}`);
    (error as Error & { code?: unknown }).code = payload.error;
    throw error;
  }
  return payload;
}
