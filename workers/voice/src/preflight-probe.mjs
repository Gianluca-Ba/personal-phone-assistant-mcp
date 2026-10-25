// Authenticated ops-only probe: actual production credentials/runtime, synthetic D1,
// and an explicit egress allowlist that cannot issue a phone API command.
import { VoiceBridge } from "./bridge.mjs";
export async function probePreflight(
  env,
  storage,
  sourceId,
  audio = new Uint8Array(),
) {
  let silencePump;
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
    const simulated = { dtmf: [], closed: false };
    let playbackEnd = Date.now();
    await bridge.attachMedia({
      readyState: 1,
      close() {},
      send(raw) {
        const frame = JSON.parse(raw);
        if (frame.event === "media")
          playbackEnd =
            Math.max(playbackEnd, Date.now()) +
            Buffer.from(frame.media.payload, "base64").length / 8;
        if (frame.event === "mark")
          setTimeout(
            () => bridge.marks.acknowledge(frame.mark.name),
            Math.max(0, playbackEnd - Date.now()),
          );
      },
    });
    clearInterval(bridge.inputPump);
    bridge.controller.sendDigit = async (digit) => {
      simulated.dtmf.push(digit);
      return { ok: true };
    };
    bridge.controller.close = async () => {
      simulated.closed = true;
    };
    bridge.controller.playFarewell = async () => {
      setTimeout(
        () => bridge.controller.event({ type: "system_farewell_completed" }),
        250,
      );
    };
    const onVoice = bridge.onVoice.bind(bridge);
    bridge.onVoice = async (frame) => {
      if (frame.type === "error")
        events.push({
          stage: "voice_error_response",
          code: /^[a-zA-Z0-9_]{1,64}$/.test(frame.error?.code ?? "")
            ? frame.error.code
            : "unknown",
        });
      return onVoice(frame);
    };
    let offset = 0,
      transcriptSeen = false;
    bridge.stt?.addEventListener("message", (e) => {
      try {
        const raw =
          typeof e.data === "string"
            ? e.data
            : new TextDecoder().decode(e.data);
        const frame = JSON.parse(raw);
        if (frame.transcript && !transcriptSeen) {
          transcriptSeen = true;
          events.push({ stage: "stt_speech_recognized" });
        }
        if (frame.errors)
          events.push({
            stage: "stt_error_response",
            codes: frame.errors
              .map((x) => String(x.code ?? "unknown"))
              .filter((x) => /^[a-zA-Z0-9_]{1,50}$/.test(x)),
          });
      } catch {
        events.push({ stage: "stt_unreadable_frame" });
      }
    });
    silencePump = setInterval(() => {
      if (bridge.stt?.readyState !== 1) return;
      const frame = Buffer.alloc(160, 255);
      if (audio.length)
        for (let i = 0; i < 160; i++) frame[i] = audio[offset++ % audio.length];
      bridge.stt.send(frame);
    }, 20);
    const connectionStart = Date.now();
    for (const [name, socket] of [
      ["voice", bridge.voice],
      ["stt", bridge.stt],
    ])
      socket?.addEventListener("close", (e) =>
        events.push({
          stage: name + "_closed",
          elapsed_ms: Date.now() - connectionStart,
          code: e.code,
          reason: /timeout|idle/i.test(e.reason ?? "")
            ? "timeout"
            : /abort/i.test(e.reason ?? "")
              ? "abort"
              : "other",
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return {
      status: bridge.context?.failure ? 503 : r.status,
      ready: !!bridge.voiceReady && !bridge.context?.failure,
      connection_held_ms: 30000,
      simulated_dtmf: simulated.dtmf,
      simulated_closed: simulated.closed,
      stt_final_received: bridge.controller.lastTranscript !== null,
      menu_complete: !!bridge.controller.menu?.complete,
      advertised_digits: bridge.controller.menu?.digits ?? [],
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
    clearInterval(silencePump);
    bridge.ended = true;
    bridge.cleanup();
    if (storage) await storage.deleteAll();
  }
}
