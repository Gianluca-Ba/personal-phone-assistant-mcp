import { WorkerEntrypoint } from "cloudflare:workers";
// Compatibility tombstone: the already-deployed auth Worker still binds this entrypoint.
// Retaining it lets us deploy MCP alone while permanently disabling old web approvals.
export class ApprovalServer extends WorkerEntrypoint {
  async describeTicket() {
    throw new Error("WEB_APPROVAL_REMOVED");
  }
  async confirmTicket() {
    throw new Error("WEB_APPROVAL_REMOVED");
  }
}
