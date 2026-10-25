import {
  createPublicKey,
  verify,
  timingSafeEqual,
  createHash,
} from "node:crypto";
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export function sameSecret(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    b.length >= 32 &&
    timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)))
  );
}
export function validSignature(headers, content, key, now = Date.now()) {
  try {
    const timestamp = headers.get("telnyx-timestamp") ?? "",
      signature = Buffer.from(
        headers.get("telnyx-signature-ed25519") ?? "",
        "base64",
      ),
      raw = Buffer.from(key ?? "", "base64");
    if (
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(now - Number(timestamp) * 1000) > 300000 ||
      raw.length !== 32 ||
      signature.length !== 64
    )
      return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(timestamp + "|" + content),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}
export function validStreamUpgrade(request, expectedUrl, key, now) {
  const expected = new URL(expectedUrl);
  if (expected.protocol !== "wss:") return false;
  const http = new URL(expected);
  http.protocol = "https:";
  return (
    request.url === http.href &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    validSignature(request.headers, expected.href, key, now)
  );
}
export function parseState(value) {
  try {
    const b = JSON.parse(Buffer.from(value ?? "", "base64").toString("utf8"));
    return /^[a-f0-9-]{36}$/.test(b.request_id) &&
      /^[a-f0-9-]{36}$/.test(b.nonce)
      ? b
      : null;
  } catch {
    return null;
  }
}
