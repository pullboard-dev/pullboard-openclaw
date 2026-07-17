import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { register } from "node:module";
import { once } from "node:events";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";

// A deliberately distinctive minted bearer token so the leak assertion is unambiguous: #732 requires
// that this exact secret NEVER appears in the model-visible output of pullboard_token.
const VERIFIER_TOKEN = "pbt-verifier-9f8e7d6c5b4a3210-SECRET";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const json = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};
const toolPayload = (result) => JSON.parse(result.content[0].text);
const assertExactKeys = (input, keys) => assert.deepEqual(Object.keys(input).toSorted(), [...keys].toSorted());
const assertRequestId = (input) => {
  assert.equal(typeof input.requestId, "string");
  assert.ok(input.requestId.trim().length >= 1 && [...input.requestId].length <= 200);
};
const assertDigest = (value) => assert.match(value, /^sha256:[0-9a-f]{64}$/);
const assertSha = (value) => assert.match(value, /^[0-9a-f]{40}$/);

const scratchBoard = async () => {
  const state = {
    item: null,
    leases: new Map(),
    submission: null,
    verification: null,
    calls: [],
  };
  const tokens = new Map([["builder-token", "builder"]]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://scratch.invalid");
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      const principal = tokens.get(token);
      state.calls.push(`${request.method} ${url.pathname} ${principal || "anonymous"}`);
      if (!principal) return json(response, 401, { error: "UNAUTHENTICATED" });
      if (request.method === "POST") assert.equal(request.headers["content-type"], "application/json");
      else assert.equal(request.headers["content-type"], undefined);

      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(response, 200, { counts: { total: state.item ? 1 : 0 }, items: state.item ? [state.item] : [] });
      }
      if (request.method === "POST" && url.pathname === "/api/items") {
        const input = await body(request);
        assertExactKeys(input, ["title", "criteria", "requestId"]);
        assert.equal(input.title, "Compiled artifact workflow");
        assert.deepEqual(input.criteria, ["the distributed plugin closes through a distinct verifier"]);
        assertRequestId(input);
        state.item = {
          workId: "compiled-artifact-work", title: input.title, criteria: input.criteria,
          criterionDigest: digest(JSON.stringify(input.criteria || [])), state: "open",
          verificationState: null, independentlyVerified: false,
        };
        return json(response, 201, { item: state.item });
      }
      if (request.method === "GET" && url.pathname === "/api/items/compiled-artifact-work") {
        return json(response, 200, { item: state.item });
      }
      if (request.method === "POST" && url.pathname === "/api/claim") {
        const input = await body(request);
        assertExactKeys(input, ["workId", "role", "ttl", "requestId"]);
        assert.equal(input.workId, state.item?.workId);
        assert.ok(["builder", "verifier"].includes(input.role));
        assert.equal(input.ttl, 3600);
        assertRequestId(input);
        const eligible = input.workId === state.item?.workId
          && ((input.role === "builder" && principal === "builder" && state.item.state === "open")
            || (input.role === "verifier" && principal === "verifier" && state.item.state === "pending-verify"));
        if (!eligible) return json(response, 409, { error: "ROLE_NOT_ELIGIBLE" });
        const lease = { leaseId: `${input.role}-lease`, workId: input.workId, role: input.role, principal };
        state.leases.set(lease.leaseId, lease);
        state.item.state = input.role === "builder" ? "in-progress" : "pending-verify";
        return json(response, 200, lease);
      }
      if (request.method === "POST" && url.pathname === "/api/submit") {
        const input = await body(request);
        assertExactKeys(input, [
          "leaseId", "baseSHA", "headSHA", "criterionDigest", "evidenceDigest", "completionTier", "requestId",
        ]);
        assertSha(input.baseSHA);
        assertSha(input.headSHA);
        assert.notEqual(input.baseSHA, input.headSHA);
        assertDigest(input.criterionDigest);
        assertDigest(input.evidenceDigest);
        assert.equal(input.completionTier, "independent");
        assertRequestId(input);
        const lease = state.leases.get(input.leaseId);
        if (lease?.principal !== principal || lease.role !== "builder") return json(response, 403, { error: "LEASE_NOT_OWNED" });
        assert.equal(input.criterionDigest, state.item.criterionDigest);
        state.submission = { submissionId: "compiled-submission", builderId: principal, ...input };
        Object.assign(state.item, { state: "pending-verify", verificationState: "submitted", headSHA: input.headSHA });
        return json(response, 200, { ...state.submission, state: state.item.state, assurance: "DEMO_UNTRUSTED" });
      }
      if (request.method === "POST" && url.pathname === "/api/accounts/tokens") {
        const input = await body(request);
        assertExactKeys(input, ["label"]);
        assert.equal(input.label, "compiled verifier");
        assert.equal(principal, "builder");
        tokens.set(VERIFIER_TOKEN, "verifier");
        return json(response, 201, { token: VERIFIER_TOKEN });
      }
      if (request.method === "POST" && url.pathname === "/api/verify") {
        const input = await body(request);
        assertExactKeys(input, [
          "leaseId", "decision", "reasonCode", "evidenceDigest", "headSHA", "criterionDigest", "requestId",
        ]);
        assert.equal(input.decision, "ACCEPT");
        assert.equal(input.reasonCode, "CRITERION_MET");
        assertSha(input.headSHA);
        assertDigest(input.criterionDigest);
        assertDigest(input.evidenceDigest);
        assertRequestId(input);
        const lease = state.leases.get(input.leaseId);
        if (lease?.principal !== principal || lease.role !== "verifier") return json(response, 403, { error: "LEASE_NOT_OWNED" });
        assert.notEqual(principal, state.submission.builderId);
        assert.equal(input.submissionId ?? state.submission.submissionId, state.submission.submissionId);
        assert.equal(input.headSHA, state.submission.headSHA);
        assert.equal(input.criterionDigest, state.submission.criterionDigest);
        state.verification = { verificationId: "compiled-verification", verifierId: principal, ...input };
        Object.assign(state.item, { state: "closed", verificationState: "verified", independentlyVerified: true });
        return json(response, 200, { ...state.verification, state: state.item.state, independentlyVerified: true });
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      json(response, 500, { error: "SCRATCH_ASSERTION_FAILED", message: error.message });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, server, state };
};

const registerTools = async (baseUrl, token) => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.openclaw.extensions, ["./dist/index.js"]);
  assert.ok(manifest.files.includes("dist"));
  const entry = new URL(`../${manifest.openclaw.extensions[0]}`, import.meta.url);
  assert.match(entry.pathname, /\/dist\/index\.js$/);
  register(new URL("./openclaw-loader.mjs", import.meta.url), import.meta.url);
  const { default: plugin } = await import(entry);
  const tools = new Map();
  plugin.register({
    config: { plugins: { entries: { pullboard: { config: { baseUrl, token } } } } },
    registerTool: (tool, options = {}) => tools.set(tool.name, { tool, options }),
  });
  assert.deepEqual([...tools.keys()].toSorted(), [
    "pullboard_claim", "pullboard_comment", "pullboard_create", "pullboard_get", "pullboard_status",
    "pullboard_submit", "pullboard_token", "pullboard_verify",
  ]);
  assert.deepEqual([...tools].filter(([, { options }]) => options.optional).map(([name]) => name).toSorted(), [
    "pullboard_claim", "pullboard_comment", "pullboard_create", "pullboard_submit", "pullboard_token", "pullboard_verify",
  ]);
  return tools;
};

const invoke = async (tools, name, input) => {
  const { tool } = tools.get(name);
  const errors = [...Value.Errors(tool.parameters, input)];
  assert.deepEqual(errors, [], `${name} input must pass the registered TypeBox schema before execute`);
  return toolPayload(await tool.execute(`compiled-${name}`, input));
};

test("the exact compiled ClawHub artifact registers and independently verifies work over scratch HTTP", async (t) => {
  const scratch = await scratchBoard();
  // Redirect the plugin's minted-token file into a scratch dir so the real ~/.pullboard is untouched.
  const tokenHome = mkdtempSync(join(tmpdir(), "pb-openclaw-token-"));
  const priorTokenDir = process.env.PULLBOARD_TOKEN_DIR;
  process.env.PULLBOARD_TOKEN_DIR = tokenHome;
  t.after(async () => {
    if (priorTokenDir === undefined) delete process.env.PULLBOARD_TOKEN_DIR;
    else process.env.PULLBOARD_TOKEN_DIR = priorTokenDir;
    rmSync(tokenHome, { recursive: true, force: true });
    scratch.server.close();
    await once(scratch.server, "close");
  });
  const builder = await registerTools(scratch.baseUrl, "builder-token");
  assert.match(
    builder.get("pullboard_create").tool.parameters.properties.requestId.description,
    /idempotency key.*exact value after a timeout.*changed input/is,
    "the compiled create schema must teach callers safe timeout replay",
  );
  assert.deepEqual((await invoke(builder, "pullboard_status", {})).counts, { total: 0 });
  const created = await invoke(builder, "pullboard_create", {
    title: "Compiled artifact workflow", criteria: ["the distributed plugin closes through a distinct verifier"],
  });
  const initial = await invoke(builder, "pullboard_get", { workId: created.workId });
  const claim = await invoke(builder, "pullboard_claim", { workId: created.workId, role: "builder" });
  const submission = await invoke(builder, "pullboard_submit", {
    leaseId: claim.leaseId,
    baseSHA: "1".repeat(40),
    headSHA: "2".repeat(40),
    criterionDigest: initial.criterionDigest,
    evidenceDigest: digest("compiled builder evidence"),
  });
  assert.equal(submission.state, "pending-verify");
  const provision = await invoke(builder, "pullboard_token", { label: "compiled verifier" });
  // #732 (ext security review): the minted bearer token must NEVER appear in model-visible output.
  assert.ok(
    !JSON.stringify(provision).includes(VERIFIER_TOKEN),
    "pullboard_token output must not contain the raw minted token",
  );
  assert.equal(provision.token, undefined, "no raw `token` field is surfaced");
  assert.match(provision.tokenPrefix, /…$/, "only a short redacted prefix is surfaced");
  assert.ok(provision.tokenFile, "the raw token is written to a local file instead");
  // ...but the full token is still usable — read it back from the 0600 file the tool wrote.
  const verifierToken = readFileSync(provision.tokenFile, "utf8").trim();
  assert.equal(verifierToken, VERIFIER_TOKEN, "the persisted file holds the real, usable token");
  const verifier = await registerTools(scratch.baseUrl, verifierToken);
  const verifierClaim = await invoke(verifier, "pullboard_claim", { workId: created.workId, role: "verifier" });
  const pending = await invoke(verifier, "pullboard_get", { workId: created.workId });
  await invoke(verifier, "pullboard_verify", {
    leaseId: verifierClaim.leaseId,
    decision: "ACCEPT",
    reasonCode: "CRITERION_MET",
    headSHA: pending.headSHA,
    criterionDigest: pending.criterionDigest,
    evidenceDigest: digest("compiled verifier evidence"),
  });
  const final = await invoke(builder, "pullboard_get", { workId: created.workId });
  assert.deepEqual({
    state: final.state,
    verificationState: final.verificationState,
    independentlyVerified: final.independentlyVerified,
  }, { state: "closed", verificationState: "verified", independentlyVerified: true });
  assert.notEqual(scratch.state.submission.builderId, scratch.state.verification.verifierId);
  assert.deepEqual(scratch.state.calls.map((call) => call.split(" ").slice(0, 2).join(" ")), [
    "GET /api/status", "POST /api/items", "GET /api/items/compiled-artifact-work", "POST /api/claim",
    "POST /api/submit", "POST /api/accounts/tokens", "POST /api/claim",
    "GET /api/items/compiled-artifact-work", "POST /api/verify", "GET /api/items/compiled-artifact-work",
  ]);
});
