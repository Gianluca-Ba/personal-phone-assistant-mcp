import { WorkerEntrypoint } from "cloudflare:workers";
import { approveInput, type OutboundEnv } from "./outbound";
// This entrypoint is reachable only through the auth Worker's service binding, never public HTTP.
export class ApprovalServer extends WorkerEntrypoint<OutboundEnv> {
  private gate(id: string, ticket: string) {
    approveInput.parse({ id });
    if (!/^[a-f0-9-]{72}$/.test(ticket)) throw new Error("Invalid ticket");
    return this.env.OUTBOUND_GATE.get(
      this.env.OUTBOUND_GATE.idFromName(`approval:${id}`),
    );
  }
  describeTicket(id: string, ticket: string) {
    return this.gate(id, ticket).describe(ticket);
  }
  confirmTicket(id: string, ticket: string) {
    return this.gate(id, ticket).confirm(ticket);
  }
}
