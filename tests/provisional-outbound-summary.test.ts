import { expect, it } from "vitest";
import vm from "node:vm";
const {
  patchOutboundSummaryProvisional,
  restoreOutboundSummaryProvisional,
  provisionalSummary,
} = await import(
  new URL("../scripts/patch-outbound-summary-provisional.mjs", import.meta.url)
    .href
);
const original = `function save(db, callId, summary) {
  const stmts = [];
  stmts.push(db.prepare("INSERT OR IGNORE INTO call_summaries (id, call_id, summary_it) VALUES (?, ?, ?)").bind(crypto.randomUUID(), callId, summary));
  return stmts;
}`;
it("replaces only the outbound v2 stored value while preserving all other entry code", () => {
  const patched = patchOutboundSummaryProvisional(original);
  expect(restoreOutboundSummaryProvisional(patched)).toBe(original);
  const expression = patched.match(
    /callId, (resolved\.direction === 'outbound'[^\n]+?)\)\); \/\/ OUTBOUND_PROVISIONAL_SUMMARY/,
  )?.[1];
  expect(expression).toBeTruthy();
  for (const direction of ["inbound", "outbound"])
    for (const format of ["v2", "legacy"]) {
      const result = vm.runInNewContext(expression!, {
        resolved: { direction },
        env: { CALL_SUMMARY_FORMAT: format },
        summary: "Provider claims stock confirmed",
      });
      expect(result).toBe(
        direction === "outbound" && format === "v2"
          ? provisionalSummary
          : "Provider claims stock confirmed",
      );
    }
  expect(() => patchOutboundSummaryProvisional(patched)).toThrow();
  expect(() =>
    patchOutboundSummaryProvisional("unrecognized source"),
  ).toThrow();
});
