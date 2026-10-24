// TEST ONLY. Never referenced by a production Wrangler file or bundled for deployment.
// Simulates a trusted future host adapter, NOT a feature or guarantee of ChatGPT.
export { default, ApprovalServer } from "../workers/mcp/src/index";
import {
  OutboundGate as ProductionGate,
  type Snapshot,
  type VerifiedConsent,
  type Principal,
} from "../workers/mcp/src/outbound";
export class OutboundGate extends ProductionGate {
  async installTestReceipt(invalid = false) {
    const s = await this.ctx.storage.get<Snapshot>("snapshot");
    if (!s) throw new Error("Missing test snapshot");
    await this.ctx.storage.put("test-receipt", {
      owner: s.owner,
      clientId: s.clientId,
      request_digest: invalid ? "0".repeat(64) : s.request_digest,
      approval_nonce: s.approval_nonce,
      expires_at: s.expires_at,
    } satisfies VerifiedConsent);
  }
  async expireTestRequest() {
    const s = await this.ctx.storage.get<Snapshot>("snapshot");
    await this.ctx.storage.put("snapshot", {
      ...s,
      expires_at: Date.now() - 1,
    });
  }
  protected override async verifiedNativeConsent(_s: Snapshot, _p: Principal) {
    return (
      (await this.ctx.storage.get<VerifiedConsent>("test-receipt")) ?? null
    );
  }
}
