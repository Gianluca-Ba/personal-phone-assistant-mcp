import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { verifyOwnerSignature } from "../workers/mcp/src/consent";
import { generateKeyPairSync, sign } from "node:crypto";
import type { Snapshot } from "../workers/mcp/src/outbound";
const s: Snapshot = {
  id: crypto.randomUUID(),
  destination: "+819012345678",
  language: "it",
  instructions: "Only a local test, never call.",
  owner: "owner",
  clientId: "test-client",
  created_at: Date.now(),
  expires_at: Date.now() + 600000,
  approval_nonce: crypto.randomUUID(),
  request_digest: "1".repeat(64),
  state: "pending_approval",
};
it("signature verifier fails closed on expiry, missing key, malformed signature and wrong public key", async () => {
  const keys = generateKeyPairSync("ed25519");
  const pub = keys.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64url");
  expect(await verifyOwnerSignature(s, undefined, pub)).toBeNull();
  expect(
    await verifyOwnerSignature(s, "ppa1." + "a".repeat(86), pub),
  ).toBeNull();
  expect(
    await verifyOwnerSignature(s, "ppa1." + "a".repeat(86), "bad"),
  ).toBeNull();
  const expired = {
    ...s,
    created_at: Date.now() - 700000,
    expires_at: Date.now() - 100000,
  };
  const out = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {consentPayload} from './scripts/owner-consent.mjs';process.stdout.write(consentPayload(JSON.parse(process.argv[1])))",
      JSON.stringify(expired),
    ],
    { encoding: "utf8" },
  );
  const receipt =
    "ppa1." +
    sign(null, Buffer.from(out.stdout), keys.privateKey).toString("base64url");
  expect(await verifyOwnerSignature(expired, receipt, pub)).toBeNull();
});
it("local helper validates request expiry and refuses hidden terminal control characters", () => {
  const out = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {validateRequest} from './scripts/owner-consent.mjs';const s=JSON.parse(process.argv[1]);validateRequest(s);for (const bad of [{...s,instructions:'\\u001b[2JHIDE'}, {...s,instructions:'\\u202ehidden'}, {...s,expires_at:0}]) {let denied=false;try{validateRequest(bad)}catch{denied=true}if(!denied)process.exit(1)}`,
      JSON.stringify(s),
    ],
    { encoding: "utf8" },
  );
  expect(out.status, out.stderr).toBe(0);
});
