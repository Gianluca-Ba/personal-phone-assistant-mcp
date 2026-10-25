import type { Snapshot, VerifiedConsent } from "./outbound";

// Domain separation prevents signatures being reused by a different application.
export const consentPayload = (s: Snapshot) =>
  JSON.stringify({
    purpose: "personal-phone-assistant:approve:v1",
    resource:
      "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp",
    id: s.id,
    destination: s.destination,
    language: s.language,
    instructions: s.instructions,
    owner: s.owner,
    clientId: s.clientId,
    created_at: s.created_at,
    expires_at: s.expires_at,
    approval_nonce: s.approval_nonce,
    request_digest: s.request_digest,
  });
const decode = (v: string) =>
  Uint8Array.from(atob(v.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
export async function verifyOwnerSignature(
  s: Snapshot,
  receipt?: string,
  publicKey?: string,
): Promise<VerifiedConsent | null> {
  if (
    !receipt ||
    !publicKey ||
    !/^ppa1\.[A-Za-z0-9_-]{86}$/.test(receipt) ||
    !/^[A-Za-z0-9_-]{43}$/.test(publicKey)
  )
    return null;
  if (s.expires_at <= Date.now() || s.expires_at - s.created_at !== 600000)
    return null;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      decode(publicKey),
      "Ed25519",
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        "Ed25519",
        key,
        decode(receipt.slice(5)),
        new TextEncoder().encode(consentPayload(s)),
      ))
    )
      return null;
    return {
      owner: s.owner,
      clientId: s.clientId,
      request_digest: s.request_digest,
      approval_nonce: s.approval_nonce,
      expires_at: s.expires_at,
    };
  } catch {
    return null;
  }
}
