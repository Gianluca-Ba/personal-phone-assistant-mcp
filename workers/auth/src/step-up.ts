import { DurableObject } from "cloudflare:workers";
// Strongly consistent, short-lived intent to obtain fresh OAuth consent.
// Not consent to a phone call, and never a means of granting extra scopes.
export class OAuthStepUpState extends DurableObject {
  async requireConsent(scopes: string[]) {
    if (
      !scopes.length ||
      scopes.some(
        (s) => !["calls:read", "calls:write", "calls:execute"].includes(s),
      )
    )
      throw new Error("INVALID_STEP_UP_SCOPES");
    await this.ctx.storage.put("pending", {
      scopes: [...new Set(scopes)],
      expiresAt: Date.now() + 600000,
    });
  }
  async requiresConsent(granted: string[]) {
    const pending = await this.ctx.storage.get<{
      scopes: string[];
      expiresAt: number;
    }>("pending");
    if (!pending) return false;
    if (pending.expiresAt <= Date.now()) {
      await this.ctx.storage.delete("pending");
      return false;
    }
    return pending.scopes.some((s) => !granted.includes(s));
  }
  async clear() {
    await this.ctx.storage.delete("pending");
  }
}
export async function stepUpKey(
  userId: string,
  clientId: string,
  resource: string,
) {
  const value = new TextEncoder().encode(
    JSON.stringify([userId, clientId, resource]),
  );
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
