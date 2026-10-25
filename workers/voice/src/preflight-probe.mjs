// Authenticated ops-only probe: actual production credentials/runtime, synthetic D1,
// and an explicit egress allowlist that cannot issue a phone API command.
import { VoiceBridge } from "./bridge.mjs";
export async function probePreflight(env, storage, sourceId) {
  const data = new Map(),
    events = [];
  const row = {
    id: crypto.randomUUID(),
    status: "dialing",
    callback_token: crypto.randomUUID(),
    language: "ja",
    destination_number: "+819022222222",
    instructions:
      "仮想の接続確認です。発信せず、電話番号も操作しないでください。",
  };
  if (sourceId) {
    const original = await env.DB.prepare(
      "SELECT status, instructions, language FROM outbound_requests WHERE id = ?",
    )
      .bind(sourceId)
      .first();
    if (original?.status !== "failed")
      return { status: 409, ready: false, events, real_calls: 0 };
    row.instructions = original.instructions;
    row.language = original.language;
  }
  const nativeTransport = new VoiceBridge({}, env);
  const bridge = new VoiceBridge(
    storage ?? {
      get: async (k) => data.get(k),
      put: async (k, v) => {
        data.set(k, v);
      },
    },
    {
      ...env,
      DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
    },
    {
      providerFetch: async (url, init = {}) => {
        const u = new URL(url);
        const assistant = "/v2/ai/assistants/" + env.OUTBOUND_ASSISTANT_ID;
        const stage =
          u.pathname === assistant
            ? "assistant"
            : u.pathname === assistant + "/conversation"
              ? "voice"
              : u.pathname === "/v2/speech-to-text/transcription"
                ? "stt"
                : /^\/v2\/ai\/conversations\/[a-f0-9-]{36}$/.test(u.pathname) &&
                    init.method === "PUT"
                  ? "metadata"
                  : null;
        if (u.origin !== "https://api.telnyx.com" || !stage)
          throw Error("PROBE_NETWORK_DENIED");
        try {
          const r = await nativeTransport.providerFetch(url, init);
          events.push({ stage, status: r.status, websocket: !!r.webSocket });
          return r;
        } catch (e) {
          events.push({
            stage,
            category: e.name === "TypeError" ? "TypeError" : "network_error",
          });
          throw e;
        }
      },
    },
  );
  try {
    const r = await bridge.register({
      request_id: row.id,
      callback_token: row.callback_token,
      destination: row.destination_number,
      from: env.OUTBOUND_FROM,
    });
    return {
      status: r.status,
      ready: !!bridge.voiceReady,
      stage: bridge.preflightStage ?? null,
      failure: bridge.context?.failure ?? null,
      events,
      real_calls: 0,
    };
  } catch (e) {
    return {
      status: 503,
      ready: false,
      stage: bridge.preflightStage ?? null,
      failure: bridge.context?.failure ?? null,
      category: e.name === "TypeError" ? "TypeError" : "preflight_error",
      events,
      real_calls: 0,
    };
  } finally {
    bridge.ended = true;
    bridge.cleanup();
    if (storage) await storage.deleteAll();
  }
}
