import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://pullboard.dev";

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
