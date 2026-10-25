import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { patchPhone } from "./patch-phone-voice.mjs";
mkdirSync(".wrangler", { recursive: true });
const dir = mkdtempSync(resolve(".wrangler/phone-voice-check-"));
try {
  const result = patchPhone(
    readFileSync("tests/fixtures/phone-outbound.original.mjs", "utf8"),
  );
  const file = join(dir, "phone.mjs");
  writeFileSync(file, result.source);
  for (const args of [[], ["--guarded"]])
    process.stdout.write(
      execFileSync(
        process.execPath,
        ["scripts/test-phone-contract.mjs", file, ...args],
        { encoding: "utf8" },
      ),
    );
  console.log(JSON.stringify(result.validation));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
