import { VoiceBridge } from "./bridge.mjs";
import {
  sameSecret,
  validSignature,
  validStreamUpgrade,
  parseState,
} from "./security.mjs";
const reply = (body, status = 200) => Response.json(body, { status });
const ready = (env) =>
  env.VOICE_EXECUTION_ENABLED === "true" &&
  env.PREWARM_BEFORE_DIAL === "true" &&
  env.EXTERNAL_STT === "true" &&
  env.CONTROLLED_FAREWELL === "true" &&
  [
    "VOICE_CONTROL_API_SECRET",
    "TELNYX_API_KEY",
    "TELNYX_PUBLIC_KEY",
    "OUTBOUND_ASSISTANT_ID",
    "OUTBOUND_ASSISTANT_VERSION",
    "OUTBOUND_FROM",
    "VOICE_APP_ID",
    "VOICE_ORIGIN",
  ].every((k) => typeof env[k] === "string" && env[k].length > 0);
const uuid = /^[a-f0-9-]{36}$/;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return reply({
        service: "outbound-voice-control",
        ready: ready(env),
        pstn_pilot_verified: env.PSTN_PILOT_VERIFIED === "true",
      });
    if (url.pathname === "/register" && request.method === "POST") {
      if (
        !sameSecret(
          request.headers.get("Authorization")?.replace(/^Bearer /, ""),
          env.VOICE_CONTROL_API_SECRET,
        )
      )
        return reply({ error: "Unauthorized" }, 401);
      if (!ready(env))
        return reply({ error: "Voice control disabled or incomplete" }, 503);
      const raw = await request.text();
      if (raw.length > 8192) return reply({ error: "Payload too large" }, 413);
      let b;
      try {
        b = JSON.parse(raw);
      } catch {
        return reply({ error: "Invalid request" }, 400);
      }
      if (!uuid.test(b.request_id ?? ""))
        return reply({ error: "Invalid request" }, 400);
      return env.VOICE_SESSIONS.get(
        env.VOICE_SESSIONS.idFromName(b.request_id),
      ).fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: raw,
      });
    }
    if (url.pathname === "/webhooks/telnyx" && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > 262144)
        return reply({ error: "Payload too large" }, 413);
      if (!validSignature(request.headers, raw, env.TELNYX_PUBLIC_KEY))
        return reply({ error: "Invalid signature" }, 403);
      let event;
      try {
        event = JSON.parse(raw).data;
      } catch {
        return reply({ error: "Invalid JSON" }, 400);
      }
      if (
        ![
          "call.initiated",
          "call.answered",
          "call.hangup",
          "call.speak.ended",
        ].includes(event?.event_type)
      )
        return reply({ received: true, ignored: true });
      const state = parseState(event.payload?.client_state);
      if (!state || !uuid.test(event.id ?? ""))
        return reply({ error: "Invalid context" }, 400);
      return env.VOICE_SESSIONS.get(
        env.VOICE_SESSIONS.idFromName(state.request_id),
      ).fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: raw,
      });
    }
    if (url.pathname === "/insights" && request.method === "POST") {
      const raw = await request.text();
      if (raw.length > 262144) return reply({ error: "Too large" }, 413);
      if (!validSignature(request.headers, raw, env.TELNYX_PUBLIC_KEY))
        return reply({ error: "Invalid signature" }, 403);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply({ error: "Invalid JSON" }, 400);
      }
      const cid =
        body.data?.payload?.conversation_id ??
        body.payload?.conversation_id ??
        body.conversation_id;
      if (typeof cid !== "string" || !/^[a-f0-9-]{36}$/.test(cid))
        return reply({ error: "Invalid conversation" }, 400);
      const r = await fetch(
        "https://api.telnyx.com/v2/ai/conversations/" + encodeURIComponent(cid),
        {
          headers: { Authorization: "Bearer " + env.TELNYX_API_KEY },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!r.ok) return reply({ error: "Conversation unavailable" }, 503);
      const result = await r.json(),
        id = (result.data ?? result).metadata?.outbound_request_id;
      if (!uuid.test(id ?? "")) return reply({ received: true, ignored: true });
      return env.VOICE_SESSIONS.get(env.VOICE_SESSIONS.idFromName(id)).fetch(
        env.VOICE_ORIGIN + "/insights",
        { method: "POST", headers: request.headers, body: raw },
      );
    }
    const match = /^\/media\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(
      url.pathname,
    );
    if (
      match &&
      request.method === "GET" &&
      !validSignature(
        request.headers,
        request.url.replace(/^https:/, "wss:"),
        env.TELNYX_PUBLIC_KEY,
      )
    )
      return reply({ error: "Invalid signature" }, 403);
    if (match && request.method === "GET")
      return env.VOICE_SESSIONS.get(
        env.VOICE_SESSIONS.idFromName(match[1]),
      ).fetch(request);
    return reply({ error: "Not found" }, 404);
  },
};
export class VoiceSession {
  async alarm() {
    this.bridge.ended = true;
    this.bridge.cleanup();
    await this.state.storage.deleteAll();
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.bridge = new VoiceBridge(state.storage, env);
    this.bridge.background = (p) =>
      state.waitUntil(p.catch(() => this.bridge.fail("background_error")));
  }
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/register") {
        if (
          !sameSecret(
            request.headers.get("Authorization")?.replace(/^Bearer /, ""),
            this.env.VOICE_CONTROL_API_SECRET,
          ) ||
          !ready(this.env)
        )
          return reply({ error: "Unauthorized" }, 401);
        const result = await this.bridge.register(await request.json());
        if (result.ok) await this.state.storage.setAlarm(Date.now() + 86400000);
        return result;
      }
      if (url.pathname === "/webhooks/telnyx") {
        const raw = await request.text();
        if (!validSignature(request.headers, raw, this.env.TELNYX_PUBLIC_KEY))
          return reply({ error: "Invalid signature" }, 403);
        return await this.bridge.onWebhook(JSON.parse(raw).data);
      }
      if (url.pathname === "/insights") {
        const raw = await request.text();
        if (!validSignature(request.headers, raw, this.env.TELNYX_PUBLIC_KEY))
          return reply({ error: "Invalid signature" }, 403);
        const body = JSON.parse(raw),
          cid =
            body.data?.payload?.conversation_id ??
            body.payload?.conversation_id ??
            body.conversation_id,
          ctx = await this.bridge.load();
        if (!ctx || ctx.conversation_id !== cid)
          return reply({ error: "Conversation mismatch" }, 403);
        return this.bridge.forwardInsight(
          new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: raw,
          }),
        );
      }
      const match = /^\/media\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(
          url.pathname,
        ),
        context = await this.bridge.load();
      if (
        !ready(this.env) ||
        !match ||
        !context ||
        context.request_id !== match[1] ||
        !validStreamUpgrade(
          request,
          context.stream_url,
          this.env.TELNYX_PUBLIC_KEY,
        )
      )
        return reply({ error: "Invalid stream authorization" }, 403);
      if (!(await this.bridge.reserveStream(match[2])))
        return reply({ error: "Stream already claimed or expired" }, 409);
      const pair = new WebSocketPair(),
        [client, server] = Object.values(pair);
      server.accept();
      await this.bridge.attachMedia(server);
      server.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || event.data.length > 131072) {
          void this.bridge.fail("invalid_media_frame");
          return;
        }
        try {
          void this.bridge
            .onMedia(JSON.parse(event.data))
            .catch(() => this.bridge.fail("media_event_failed"));
        } catch {
          void this.bridge.fail("invalid_media_json");
        }
      });
      server.addEventListener("error", () => {
        void this.bridge.fail("media_error");
      });
      server.addEventListener("close", () => {
        setTimeout(() => {
          if (!this.bridge.ended) void this.bridge.disconnected();
        }, 1000);
      });
      return new Response(null, { status: 101, webSocket: client });
    } catch {
      return reply({ error: "Voice operation unavailable" }, 503);
    }
  }
}
