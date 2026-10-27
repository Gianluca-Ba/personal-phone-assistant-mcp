// TEST ONLY: controlled clock/config mutation, never deployed.
export { default, ApprovalServer } from "../workers/mcp/src/index";
import {
  OutboundGate as ProductionGate,
  type Snapshot,
} from "../workers/mcp/src/outbound";
export class OutboundGate extends ProductionGate {
  async setApprovalTestTtl(value: string | undefined) {
    this.env.OUTBOUND_APPROVAL_TTL_MINUTES = value;
  }
  async setCreationTestSecret(secret: string) {
    this.env.OUTBOUND_API_SECRET = secret;
  }
  async setDestinationTestPolicy(policy: string, prefixes: string) {
    this.env.OUTBOUND_DESTINATION_POLICY = policy;
    this.env.OUTBOUND_BLOCKED_PREFIXES = prefixes;
  }
  async expireTestRequest() {
    const s = await this.ctx.storage.get<Snapshot>("snapshot");
    await this.ctx.storage.put("snapshot", {
      ...s,
      expires_at: Date.now() - 1,
    });
  }
}
