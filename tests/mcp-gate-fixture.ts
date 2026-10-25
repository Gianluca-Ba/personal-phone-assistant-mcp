// TEST ONLY: controlled clock/config mutation, never deployed.
export { default, ApprovalServer } from "../workers/mcp/src/index";
import {
  OutboundGate as ProductionGate,
  type Snapshot,
} from "../workers/mcp/src/outbound";
export class OutboundGate extends ProductionGate {
  async setCreationTestSecret(secret: string) {
    this.env.OUTBOUND_API_SECRET = secret;
  }
  async expireTestRequest() {
    const s = await this.ctx.storage.get<Snapshot>("snapshot");
    await this.ctx.storage.put("snapshot", {
      ...s,
      expires_at: Date.now() - 1,
    });
  }
}
