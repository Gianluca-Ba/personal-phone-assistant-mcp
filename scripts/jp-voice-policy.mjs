// Builds an outbound-only prompt patch. No API calls, telephony or credentials.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const policy = readFileSync(
  new URL("../voice/jp/outbound-policy.txt", import.meta.url),
  "utf8",
).trimEnd();
const endPolicy = readFileSync(
  new URL("../voice/jp/end-call-policy.txt", import.meta.url),
  "utf8",
).trimEnd();
const ivrPolicy = readFileSync(
  new URL("../voice/jp/ivr-policy.txt", import.meta.url),
  "utf8",
).trimEnd();
export const hash = (text) => createHash("sha256").update(text).digest("hex");
export function section(text, start, end) {
  const a = text.indexOf(start),
    b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0)
    throw new Error("Unexpected prompt structure; no changes applied");
  return text.slice(a, b);
}
export function buildCandidate(original) {
  if (original.includes("11. JAPANESE OUTBOUND CONVERSATION"))
    throw new Error("Policy already present; refusing duplicate patch");
  const match =
    /^Introduce yourself naturally as (.+)'s assistant, using the appropriate language\.$/m.exec(
      original,
    );
  if (!match) throw new Error("Original identity rule not recognized");
  const identity = match[0],
    owner = match[1];
  const checks = [
    ["INBOUND MODE\n", "3. OUTBOUND TASK EXECUTION"],
    ["5. INBOUND CALL HANDLING", "6. OUTBOUND AUTHORIZATION AND LIMITS"],
    ["6. OUTBOUND AUTHORIZATION AND LIMITS", "7. CONVERSATIONAL BEHAVIOR"],
    ["8. TOOLS AND REPORTING", "9. ENDING A CALL"],
  ];
  let text = original.replace(
    identity,
    "On inbound calls only, " +
      identity.charAt(0).toLowerCase() +
      identity.slice(1),
  );
  const persona = `You are the multilingual personal telephone assistant of ${owner}, based in Japan.`;
  if (!text.includes(persona)) throw new Error("Original persona changed");
  text = text.replace(
    persona,
    "You are a multilingual telephone assistant based in Japan. The named owner identity below is inbound-only context, never an automatic outbound introduction.",
  );
  const replacements = [
    [
      `Introduce yourself as ${owner}'s assistant.`,
      "For outbound calls, choose the introduction only from the authorized task. Do not inject the owner name from inbound identity rules or examples. If the task forbids the name, do not mention it. Remain truthful about being an automated assistant when asked.",
    ],
    [
      "Ask the first relevant question immediately.",
      "After the authorized opening, yield for the recipient to answer. Ask only one relevant question when it is your turn.",
    ],
    [
      "Begin speaking immediately after the recipient answers, in the specified language.",
      "Use the specified language from the first utterance. If the recipient is giving an audible greeting, let it finish before the authorized opening.",
    ],
    [
      "Do not wait for the recipient to speak before introducing yourself.",
      "Avoid unnecessary introductory delays once the recipient has finished their turn.",
    ],
  ];
  for (const [old, value] of replacements) {
    if (text.split(old).length !== 2)
      throw new Error("Original rule changed; refusing ambiguous patch");
    text = text.replace(old, value);
  }
  const a = text.indexOf("10. OUTBOUND FIRST-GREETING EXAMPLES"),
    b = text.indexOf("FINAL OPERATIONAL RULE:", a);
  if (a < 0 || b < 0)
    throw new Error("Original opening examples not recognized");
  text =
    text.slice(0, a) +
    "10. OUTBOUND OPENING\nUse the task-specific opening in {{outbound_language}}. Introduce only the purpose and identity authorized by the task in section 3; never add a fixed owner-name greeting.\n" +
    text.slice(b).trimEnd() +
    "\n\n" +
    policy +
    "\n\n" +
    endPolicy +
    "\n\n" +
    ivrPolicy +
    "\n";
  text = text.replace(
    /Execute the authorized task provided in\s*{{outbound_task}}\s*\./,
    "Execute only the authorized task in section 3.",
  );
  text = text.replace(
    /FINAL OPERATIONAL RULE: On outbound calls, follow\s*{{outbound_task}}\s*and begin in\s*{{outbound_language}}\s*\./,
    "FINAL OPERATIONAL RULE: On outbound calls, follow the authorized task in section 3 and its required initial language.",
  );
  text = text.replace(
    /Honor an exact opening supplied in {{outbound_task}}/,
    "Honor an exact opening supplied in the authorized task",
  );
  text =
    `CALL ROUTING GUARD — EVALUATE BEFORE ALL PERSONA AND GREETING RULES
Current outbound flag: {{outbound_mode}}. Required outbound language: {{outbound_language}}.
ONLY when the flag is exactly "true": this is an outgoing call, not an incoming one. Use the authorized task in section 3 from the first sentence. Do not use inbound greetings such as 「お電話ありがとうございます」. Do not automatically name the system owner; when the task forbids the name, it must not appear in any introduction, answer or closing. If asked, truthfully identify as an automated assistant without volunteering a forbidden private name. Follow the explicit end-of-call action procedure in section 12.
Otherwise ignore this outbound guard completely and retain the inbound receptionist rules below.

` + text;
  for (const [start, end] of checks)
    if (section(text, start, end) !== section(original, start, end))
      throw new Error("Protected inbound/authorization section changed");
  const variables = (t) =>
    [...t.matchAll(/{{\s*([a-z_]+)\s*}}/g)].map((m) => m[1]);
  if (variables(text).some((v) => !variables(original).includes(v)))
    throw new Error("Unexpected dynamic variable introduced");
  return {
    instructions: text,
    validation: {
      protected_sections_unchanged: checks.length,
      before_sha256: hash(original),
      after_sha256: hash(text),
      audio_settings_changed: false,
      model_behavior_verified: false,
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output)
      throw new Error(
        "Usage: node scripts/jp-voice-policy.mjs original.txt candidate.txt",
      );
    const result = buildCandidate(readFileSync(input, "utf8"));
    writeFileSync(output, result.instructions, { mode: 0o600 });
    console.log(JSON.stringify(result.validation));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
