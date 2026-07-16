// Live proof: drive the WHOLE loop through the real plugin tools against a disposable
// board, and assert it reaches independentlyVerified. Run:
//   node --experimental-strip-types test-live.ts
import { createHash, randomBytes } from "node:crypto";
import {
  pullboardStatus, pullboardGet, pullboardCreate, pullboardClaim,
  pullboardSubmit, pullboardVerify, pullboardToken,
} from "./src/tools.ts";

const BASE = process.env.PULLBOARD_URL || "https://pullboard.dev";
const apiFor = (token: string) => ({ config: { plugins: { entries: { pullboard: { config: { token } } } } } });
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);
const digest = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const hex40 = () => randomBytes(20).toString("hex");
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const provision = async () => {
  const res = await fetch(`${BASE}/api/accounts/anon-provision`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "openclaw-plugin-test" }),
  });
  return (await res.json()).token as string;
};

const main = async () => {
  const builder = apiFor(await provision());

  const empty = parse(await pullboardStatus(builder).execute("t", {}));
  console.log("status: board starts with", empty.counts?.total ?? empty.triage?.total ?? "?", "items");

  const workId = parse(await pullboardCreate(builder).execute("t", { title: "OpenClaw plugin probe", criteria: ["the plugin tools drove the loop"] })).workId;
  console.log("create:", workId);

  const item = parse(await pullboardGet(builder).execute("t", { workId }));
  const claim = parse(await pullboardClaim(builder).execute("t", { workId, role: "builder" }));
  console.log("claim builder lease:", claim.leaseId);

  const submit = parse(await pullboardSubmit(builder).execute("t", {
    leaseId: claim.leaseId, baseSHA: EMPTY_TREE, headSHA: hex40(),
    criterionDigest: item.criterionDigest, evidenceDigest: digest("build-" + workId), completionTier: "independent",
  }));
  console.log("submit:", submit.state, submit.assurance);

  const verifierToken = parse(await pullboardToken(builder).execute("t", { label: "verifier" })).token;
  const verifier = apiFor(verifierToken);
  console.log("token: minted a distinct verifier identity");

  const vlease = parse(await pullboardClaim(verifier).execute("t", { workId, role: "verifier" }));
  console.log("claim verifier lease:", vlease.leaseId);

  const detailForVerify = parse(await pullboardGet(verifier).execute("t", { workId }));
  await pullboardVerify(verifier).execute("t", {
    leaseId: vlease.leaseId, decision: "ACCEPT", reasonCode: "CRITERION_MET",
    evidenceDigest: digest("verify-" + workId), headSHA: detailForVerify.headSHA, criterionDigest: detailForVerify.criterionDigest,
  });

  const final = parse(await pullboardGet(builder).execute("t", { workId }));
  console.log("final:", { state: final.state, verificationState: final.verificationState, independentlyVerified: final.independentlyVerified });
  if (final.state !== "closed" || final.independentlyVerified !== true) {
    throw new Error("PLUGIN TOOLS did NOT reach independentlyVerified");
  }
  console.log("\nPASS — the real plugin tools drove create -> claim -> submit -> token -> verify -> closed / independentlyVerified.");
};

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
