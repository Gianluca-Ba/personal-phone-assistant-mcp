import { readFileSync } from "node:fs";
export function patchAppsScript(source) {
  const marker = "  // Payload validation.";
  if (
    source.split(marker).length !== 2 ||
    source.includes("handleSummaryV2") ||
    source.indexOf("data.token !== expectedToken") < 0 ||
    source.indexOf("data.token !== expectedToken") > source.indexOf(marker)
  )
    throw new Error("Unexpected Apps Script source");
  return (
    source.replace(
      marker,
      "  if (data.version === 2) return handleSummaryV2(data, properties);\n\n" +
        marker,
    ) +
    "\n" +
    readFileSync(
      new URL("../apps-script/summary-v2.gs", import.meta.url),
      "utf8",
    )
  );
}
