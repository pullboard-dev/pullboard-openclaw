import { Type } from "@sinclair/typebox";
import { pullboardRequest, withRequestId, type PullboardCfg } from "./client.js";

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
  description: "Mint a second workspace token (a distinct principal). This is what verification requires — you can never verify your own submission, so use the returned token to claim the verifier role and verify.",
  parameters: Type.Object({ label: Type.Optional(Type.String({ description: "Label for the new token." })) }, { additionalProperties: false }),
  execute: async (_id: string, params: Params) => {
    // /api/accounts/tokens is STRICT_INPUT — send ONLY the optional label, never a requestId.
    const body = str(params, "label") ? { label: params.label } : {};
    return result(await pullboardRequest(api.config, "/api/accounts/tokens", { method: "POST", body }));
  },
});

/** Read tools are always available; write tools carry side effects and are opt-in. */
export const readTools = [pullboardStatus, pullboardGet];
export const writeTools = [pullboardCreate, pullboardClaim, pullboardSubmit, pullboardVerify, pullboardToken];
