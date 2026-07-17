import { Type } from "@sinclair/typebox";
import { pullboardRequest, withRequestId, persistMintedToken, type PullboardCfg } from "./client.js";

/** The slice of the OpenClaw plugin API these tools use: config access only. */
export type ToolApi = { config: PullboardCfg };

type Params = Record<string, unknown>;

/** Wrap a payload as an OpenClaw tool result. */
const result = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

const str = (params: Params, key: string) => {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
const need = (params: Params, key: string) => {
  const value = str(params, key);
  if (!value) throw new Error(`pullboard: '${key}' is required`);
  return value;
};
const callerRequestId = (params: Params) => typeof params.requestId === "string" ? params.requestId : undefined;
const requestIdParameter = (description = "Caller idempotency key. Reuse the exact value after a timeout; changed input with the same key is rejected.") => Type.Optional(Type.String({
  description,
  minLength: 1,
  maxLength: 200,
}));

/** Read the board: counts + the priority chain. The only way to SEE work. */
export const pullboardStatus = (api: ToolApi) => ({
  name: "pullboard_status",
  label: "Pullboard: read the board",
  description: "List the shared board — counts and the top actionable items in priority order. Start here to see what work exists and what is waiting to verify.",
  parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "Max items to return.", minimum: 1 })) }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    const q = typeof params.limit === "number" ? `?limit=${params.limit}` : "";
    return result(await pullboardRequest(api.config, `/api/status${q}`));
  },
});

/** Read one item's full detail (criteria, lease, submissions). */
export const pullboardGet = (api: ToolApi) => ({
  name: "pullboard_get",
  label: "Pullboard: read an item",
  description: "Fetch one board item's full detail — its criteria, current lease, submissions, and verification state.",
  parameters: Type.Object({ workId: Type.String({ description: "The item id." }) }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    const payload = await pullboardRequest(api.config, `/api/items/${encodeURIComponent(need(params, "workId"))}`);
    return result(payload.item ?? payload);
  },
});

/** Add a work item (with an observable, checkable "done"). */
export const pullboardCreate = (api: ToolApi) => ({
  name: "pullboard_create",
  label: "Pullboard: add work",
  description: "Create a work item on the board with a title and observable criteria (a checkable definition of done). Prints the new item id.",
  parameters: Type.Object({
    title: Type.String({ description: "Short task title." }),
    description: Type.Optional(Type.String()),
    criteria: Type.Optional(Type.Array(Type.String(), { description: "Checkable done conditions." })),
    priority: Type.Optional(Type.String({ description: "now | next | backlog (default backlog)." })),
    requestId: requestIdParameter(),
  }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    const body: Record<string, unknown> = { title: need(params, "title") };
    if (str(params, "description")) body.description = params.description;
    if (Array.isArray(params.criteria)) body.criteria = params.criteria;
    if (str(params, "priority")) body.priority = params.priority;
    if (callerRequestId(params) !== undefined) body.requestId = callerRequestId(params);
    const payload = await pullboardRequest(api.config, "/api/items", { method: "POST", body: withRequestId(body) });
    return result(payload.item ?? payload);
  },
});

/** Claim an exclusive lease on an item (builder or verifier). */
export const pullboardClaim = (api: ToolApi) => ({
  name: "pullboard_claim",
  label: "Pullboard: claim work",
  description: "Claim an exclusive lease on a ready item as builder or verifier. Returns the leaseId. A foreign holder conflicts with WORK_TAKEN; you can NEVER claim the verifier slot for your own submission.",
  parameters: Type.Object({
    workId: Type.String(),
    role: Type.Optional(Type.String({ description: "builder (default) or verifier." })),
    ttl: Type.Optional(Type.Number({ description: "Lease seconds (default 3600).", minimum: 1 })),
    requestId: requestIdParameter(),
  }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    const body = withRequestId({
      workId: need(params, "workId"),
      role: str(params, "role") || "builder",
      ttl: typeof params.ttl === "number" ? params.ttl : 3600,
      requestId: callerRequestId(params),
    });
    return result(await pullboardRequest(api.config, "/api/claim", { method: "POST", body }));
  },
});

/** Submit completed work as evidence (moves the item to pending-verify). */
export const pullboardSubmit = (api: ToolApi) => ({
  name: "pullboard_submit",
  label: "Pullboard: submit work",
  description: "Submit completed work against a builder lease: bind the commit (baseSHA/headSHA) and a criterionDigest + evidenceDigest. Moves the item to pending-verify for a different principal to verify.",
  parameters: Type.Object({
    leaseId: Type.String(),
    baseSHA: Type.String({ description: "Merge-base commit (40 hex; empty-tree if none)." }),
    headSHA: Type.String({ description: "The exact commit you produced (40 hex)." }),
    criterionDigest: Type.String({ description: "sha256:<sha256 of the item's criteria>." }),
    evidenceDigest: Type.String({ description: "sha256:<sha256 of your proof it passes>." }),
    completionTier: Type.Optional(Type.String({ description: "independent (default) or self-reported." })),
    requestId: requestIdParameter(),
  }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    const body = withRequestId({
      leaseId: need(params, "leaseId"),
      baseSHA: need(params, "baseSHA"),
      headSHA: need(params, "headSHA"),
      criterionDigest: need(params, "criterionDigest"),
      evidenceDigest: need(params, "evidenceDigest"),
      completionTier: str(params, "completionTier") || "independent",
      requestId: callerRequestId(params),
    });
    return result(await pullboardRequest(api.config, "/api/submit", { method: "POST", body }));
  },
});

/** Verify a submission as a DIFFERENT principal (never your own work). */
export const pullboardVerify = (api: ToolApi) => ({
  name: "pullboard_verify",
  label: "Pullboard: verify a submission",
  description: "As a verifier lease holder, record ACCEPT or REJECT on a submission you did NOT build. reason: ACCEPT -> CRITERION_MET; REJECT -> TEST_FAILURE | BEHAVIOR_MISMATCH. Supply your own evidenceDigest.",
  parameters: Type.Object({
    leaseId: Type.String({ description: "Your verifier leaseId." }),
    decision: Type.String({ description: "ACCEPT or REJECT." }),
    reasonCode: Type.String({ description: "CRITERION_MET / TEST_FAILURE / BEHAVIOR_MISMATCH." }),
    evidenceDigest: Type.String({ description: "sha256:<sha256 of your verification proof>." }),
    headSHA: Type.Optional(Type.String({ description: "The submission head (from the item)." })),
    criterionDigest: Type.Optional(Type.String()),
    findingDigest: Type.Optional(Type.String({ description: "REJECT only: sha256 of what failed." })),
    requestId: requestIdParameter(),
  }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    const body: Record<string, unknown> = withRequestId({
      leaseId: need(params, "leaseId"),
      decision: need(params, "decision"),
      reasonCode: need(params, "reasonCode"),
      evidenceDigest: need(params, "evidenceDigest"),
      requestId: callerRequestId(params),
    });
    for (const k of ["headSHA", "criterionDigest", "findingDigest"]) if (str(params, k)) body[k] = params[k];
    return result(await pullboardRequest(api.config, "/api/verify", { method: "POST", body }));
  },
});

/** Mint a second workspace token — a distinct identity, needed to verify your own board's work. */
export const pullboardToken = (api: ToolApi) => ({
  name: "pullboard_token",
  label: "Pullboard: mint a second identity",
  description: "Mint a second workspace token (a distinct principal). This is what verification requires — you can never verify your own submission. The raw token is NOT shown here: it is written to a local 0600 file (path returned) so it can't leak through model-visible output. Point a second identity at that file (PULLBOARD_TOKEN=$(cat <tokenFile>) or a second config) to claim the verifier role and verify.",
  parameters: Type.Object({ label: Type.Optional(Type.String({ description: "Label for the new token." })) }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    // /api/accounts/tokens is STRICT_INPUT — send ONLY the optional label, never a requestId.
    const label = str(params, "label");
    const body = label ? { label } : {};
    const payload = await pullboardRequest(api.config, "/api/accounts/tokens", { method: "POST", body });
    // SECURITY (#732, ext security review 2026-07-17): a minted bearer token must NEVER be echoed
    // in model-visible tool output — a secret in the model's context can be logged, memorized, or
    // exfiltrated downstream. Persist the raw token to a local 0600 file and return only non-secret
    // metadata (the file path + a redacted prefix). The token stays usable via the file.
    const { token, ...rest } = payload as { token?: unknown } & Record<string, unknown>;
    if (typeof token !== "string" || !token) {
      // No token field (unexpected) — return the payload with any token key removed, untouched.
      return result(rest);
    }
    // Belt-and-suspenders: drop any remaining field whose value re-exposes the raw token.
    const safeRest = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => !(typeof value === "string" && value.includes(token))),
    );
    const { tokenFile, redacted } = persistMintedToken(token, label);
    return result({
      ok: true,
      ...safeRest,
      label: label ?? null,
      tokenPrefix: redacted,
      tokenFile,
      note: "The full token was written to the 0600 file above and is NOT shown here. Point a second identity at it (PULLBOARD_TOKEN=$(cat <tokenFile>) or a second config) to claim the verifier role and verify.",
    });
  },
});

/** Append a free-form work-log note to an item — reasoning that reaches the next agent. */
export const pullboardComment = (api: ToolApi) => ({
  name: "pullboard_comment",
  label: "Pullboard: comment on an item",
  description: "Append a free-form work-log note to an item at any time — not lease-bound, allowed in any state. The note persists on the item, so the reasoning, caveat, or hand-off context you leave reaches the next agent (the same purpose as a Quant MCP work-log). Deliberate text only — never source, diffs, secrets, or prompts.",
  parameters: Type.Object({
    workId: Type.String({ description: "The item id to annotate." }),
    text: Type.String({ description: "The note (1..2000 characters).", minLength: 1, maxLength: 2000 }),
  }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    // Comments are append-only: the route rejects requestId, so send only { text }.
    const payload = await pullboardRequest(
      api.config,
      `/api/items/${encodeURIComponent(need(params, "workId"))}/comments`,
      { method: "POST", body: { text: need(params, "text") } },
    );
    return result(payload.comments ?? payload.item ?? payload);
  },
});

/** Read tools are always available; write tools carry side effects and are opt-in. */
export const readTools = [pullboardStatus, pullboardGet];
export const writeTools = [pullboardCreate, pullboardClaim, pullboardSubmit, pullboardVerify, pullboardComment, pullboardToken];
