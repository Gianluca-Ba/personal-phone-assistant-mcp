// Real Telnyx voice WS; simulated phone leg, marks, DTMF and hangup.
// The egress allowlist below cannot create or modify any actual phone call.
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { VoiceBridge } from "../workers/voice/src/bridge.mjs";
import { MuLawEncoder } from "../workers/voice/src/audio.mjs";
const variant = process.env.JP_LAB_VARIANT ?? "bridge-jp";
if (!/^[a-z0-9-]+$/.test(variant)) throw Error("Invalid variant");
const config = JSON.parse(
  readFileSync(".wrangler/jp-voice/lab-" + variant + ".json", "utf8"),
);
if (
  config.telephony_settings.default_texml_app_id ||
  config.insight_settings.insight_group_id ||
  config.telephony_settings.recording_settings.enabled ||
  config.tools.some((t) => t.type !== "client_side_tool")
)
  throw Error("Isolated assistant required");
const cases = JSON.parse(
    readFileSync("voice/jp/bridge-scenarios.json"),
  ).scenarios,
  selected = (process.argv[3] ?? cases.map((s) => s.id).join(",")).split(",");
const out = join(".wrangler/jp-voice", process.argv[2] ?? "bridge-runs");
mkdirSync(out, { recursive: true, mode: 0o700 });
function pcm(path) {
  const b = readFileSync(path);
  for (let p = 12; p + 8 <= b.length;) {
    const n = b.readUInt32LE(p + 4);
    if (b.toString("ascii", p, p + 4) === "data")
      return b.subarray(p + 8, p + 8 + n);
    p += 8 + n + (n % 2);
  }
  throw Error("PCM required");
}
class Memory {
  data = new Map();
  lock = Promise.resolve();
  async get(k) {
    return structuredClone(this.data.get(k));
  }
  async put(k, v) {
    this.data.set(k, structuredClone(v));
  }
  transaction(fn) {
    const p = this.lock.then(() => fn(this));
    this.lock = p.catch(() => {});
    return p;
  }
}
for (const s of cases.filter((s) => selected.includes(s.id))) {
  const file = join(out, s.id + ".json");
  if (existsSync(file)) {
    console.log(JSON.stringify(JSON.parse(readFileSync(file)).summary));
    continue;
  }
  const synth = (text, index) => {
    const stem = join(out, s.id + "-" + index);
    execFileSync("/usr/bin/say", [
      "-v",
      "Kyoko",
      "-r",
      "165",
      "-o",
      stem + ".aiff",
      text,
    ]);
    execFileSync("/usr/bin/afconvert", [
      "-f",
      "WAVE",
      "-d",
      "LEI16@8000",
      "-c",
      "1",
      stem + ".aiff",
      stem + ".wav",
    ]);
    const enc = new MuLawEncoder(8000);
    return Buffer.concat([
      ...enc.append(pcm(stem + ".wav")),
      ...enc.drain(true),
    ]);
  };
  const clips = [s.text, ...(s.followups ?? [])].map(synth),
    interrupt = s.interrupt ? synth(s.interrupt, "interrupt") : null;
  const events = [],
    start = Date.now(),
    record = (e) => events.push({ at_ms: Date.now() - start, ...e });
  let audio = clips.shift(),
    offset = 0,
    inputEnded = null,
    firstOutput = null,
    interruptAt = null,
    interruptFinished = false,
    hangup = false,
    forced = false;
  const rid = crypto.randomUUID(),
    callback = crypto.randomUUID(),
    row = {
      id: rid,
      status: "dialing",
      callback_token: callback,
      telnyx_call_id: null,
      destination_number: "+819022222222",
      language: "ja",
      instructions: s.task,
    };
  const env = {
    VOICE_ORIGIN: "https://virtual.invalid",
    VOICE_APP_ID: "123456",
    OUTBOUND_FROM: "+819011111111",
    OUTBOUND_ASSISTANT_ID: config.id,
    OUTBOUND_ASSISTANT_VERSION: config.version_id,
    TELNYX_API_KEY: process.env.TELNYX_API_KEY,
    PREWARM_BEFORE_DIAL: "true",
    EXTERNAL_STT: process.env.JP_EXTERNAL_STT ?? "false",
    CONTROLLED_FAREWELL: process.env.JP_CONTROLLED_FAREWELL ?? "false",
    DB: {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => ({ ...row }),
          run: async () => {
            if (sql.includes("SET telnyx_call_id"))
              row.telnyx_call_id = args[0];
            return { success: true };
          },
        }),
      }),
    },
    PHONE_API: {
      fetch: async (_url, options) => {
        record({
          type: "mock.status",
          fields: Object.fromEntries(new URLSearchParams(options.body)),
        });
        return Response.json({ received: true });
      },
    },
  };
  let bridge, media, finish;
  const done = new Promise((r) => (finish = r));
  let playbackEnd = 0,
    markTimers = new Map(),
    inputTimer,
    deadline;
  const provider = async (url, options = {}) => {
    const u = new URL(url),
      method = options.method ?? "GET";
    if (u.origin !== "https://api.telnyx.com") throw Error("NETWORK_FORBIDDEN");
    if (u.pathname === "/v2/ai/assistants/" + config.id && method === "GET")
      return fetch(url, {
        ...options,
        headers: { Authorization: "Bearer " + process.env.TELNYX_API_KEY },
      });
    if (
      u.pathname === "/v2/ai/assistants/" + config.id + "/conversation" &&
      options.headers?.Upgrade
    ) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url.replace(/^https:/, "wss:"), {
          headers: { Authorization: "Bearer " + process.env.TELNYX_API_KEY },
        });
        ws.accept = () => {};
        ws.on("message", (raw) => {
          const e = JSON.parse(raw.toString());
          if (!/audio\.delta$/.test(e.type)) record(e);
        });
        ws.once("open", () => resolve({ status: 101, webSocket: ws }));
        ws.once("error", () => reject(Error("Virtual voice unavailable")));
      });
    }
    if (
      /^\/v2\/ai\/conversations\/[a-f0-9-]+$/.test(u.pathname) &&
      method === "PUT"
    ) {
      record({ type: "mock.metadata_bound" });
      return Response.json({ data: {} });
    }
    if (
      u.pathname === "/v2/speech-to-text/transcription" &&
      options.headers?.Upgrade
    ) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url.replace(/^https:/, "wss:"), {
          headers: { Authorization: "Bearer " + process.env.TELNYX_API_KEY },
        });
        ws.accept = () => {};
        ws.on("message", (raw) => {
          const e = JSON.parse(raw.toString());
          record({ source: "stt", ...e });
        });
        ws.once("open", () => resolve({ status: 101, webSocket: ws }));
        ws.once("error", () => reject(Error("STT unavailable")));
      });
    }
    const match =
      /^\/v2\/calls\/offline-[a-f0-9-]+\/actions\/(send_dtmf|hangup|speak|playback_stop)$/.exec(
        u.pathname,
      );
    if (match && method === "POST") {
      const body = JSON.parse(options.body);
      record({
        type: "mock." + match[1],
        ...(match[1] === "send_dtmf"
          ? {
              digits: body.digits,
              caller_clip_complete: offset >= audio.length,
            }
          : {}),
      });
      if (match[1] === "send_dtmf" && clips.length) {
        audio = clips.shift();
        offset = 0;
        inputEnded = null;
        record({ type: "mock.next_caller_clip" });
      }
      if (match[1] === "hangup") {
        hangup = true;
        setTimeout(() => finish(), 30);
      }
      if (match[1] === "speak") {
        const state = JSON.parse(
          Buffer.from(body.client_state, "base64").toString(),
        );
        record({
          type:
            state.phase === "closing"
              ? "phone.controlled_farewell_started"
              : "mock.technical_fallback",
        });
        setTimeout(() => {
          record({ type: "phone.controlled_farewell_completed" });
          void bridge.onWebhook({
            id: crypto.randomUUID(),
            event_type: "call.speak.ended",
            occurred_at: new Date().toISOString(),
            payload: {
              connection_id: env.VOICE_APP_ID,
              call_control_id: "offline-" + rid,
              client_state: body.client_state,
              status: "completed",
            },
          });
        }, 1500);
      }
      return Response.json({ data: { result: "ok" } });
    }
    throw Error("NETWORK_FORBIDDEN");
  };
  bridge = new VoiceBridge(new Memory(), env, { providerFetch: provider });
  media = {
    readyState: 1,
    send(raw) {
      const m = JSON.parse(raw);
      if (m.event === "media") {
        const n = Buffer.from(m.media.payload, "base64").length;
        playbackEnd = Math.max(playbackEnd, Date.now()) + (n / 8000) * 1000;
        firstOutput ??= Date.now();
        if (interrupt && interruptAt === null) interruptAt = Date.now() + 600;
        record({ type: "phone.output_audio", bytes: n });
      } else if (m.event === "mark") {
        record({ type: "phone.mark_queued" });
        const timer = setTimeout(
          () => {
            markTimers.delete(m.mark.name);
            record({ type: "phone.playback_mark" });
            void bridge.onMedia({
              event: "mark",
              stream_id: "mock-stream",
              mark: m.mark,
            });
          },
          Math.max(0, playbackEnd - Date.now()),
        );
        markTimers.set(m.mark.name, timer);
      } else if (m.event === "clear") {
        record({
          type: "phone.playback_clear",
          during_interrupt: interruptAt !== null && Date.now() >= interruptAt,
          interrupt_kind: s.interrupt_kind ?? null,
        });
        playbackEnd = Date.now();
        for (const [name, timer] of markTimers) {
          clearTimeout(timer);
          void bridge.onMedia({
            event: "mark",
            stream_id: "mock-stream",
            mark: { name },
          });
        }
        markTimers.clear();
      }
    },
    close() {
      this.readyState = 3;
    },
  };
  try {
    const registered = await bridge.register({
      request_id: rid,
      callback_token: callback,
      destination: row.destination_number,
      from: env.OUTBOUND_FROM,
    });
    if (!registered.ok) throw Error("Registration failed");
    const registration = await registered.json();
    await bridge.attachMedia(media);
    const originalController = bridge.controller.command.bind(
      bridge.controller,
    );
    bridge.controller.command = async (...args) => {
      const result = await originalController(...args);
      record({ type: "controller.result", name: args[1], result });
      return result;
    };
    await bridge.onMedia({
      event: "start",
      stream_id: "mock-stream",
      start: {
        client_state: registration.payload.client_state,
        call_control_id: "offline-" + rid,
        from: env.OUTBOUND_FROM,
        to: row.destination_number,
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
    });
    bridge.context.answered_at = new Date().toISOString();
    await bridge.persist();
    inputTimer = setInterval(() => {
      if (bridge.ended) return;
      if (
        interrupt &&
        interruptAt !== null &&
        Date.now() >= interruptAt &&
        !interruptFinished
      ) {
        audio = interrupt;
        offset = 0;
        interruptFinished = true;
        record({ type: "phone.interrupt_clip", kind: s.interrupt_kind });
      }
      let b = Buffer.alloc(160, 255);
      if (offset < audio.length) {
        b = audio.subarray(offset, offset + 160);
        offset += 160;
        if (offset >= audio.length) {
          inputEnded = Date.now();
          record({ type: "phone.caller_clip_complete" });
        }
      }
      void bridge
        .onMedia({
          event: "media",
          stream_id: "mock-stream",
          media: {
            track: "inbound",
            chunk: String((media.chunk = (media.chunk ?? 0) + 1)),
            payload: b.toString("base64"),
          },
        })
        .catch(() => {
          record({ type: "bridge_error" });
          finish();
        });
    }, 20);
    deadline = setTimeout(
      () => {
        forced = true;
        finish();
      },
      s.terminal ? 75000 : 25000,
    );
    await done;
  } catch (error) {
    record({ type: "harness_error", category: error.name });
  } finally {
    clearInterval(inputTimer);
    clearTimeout(deadline);
    for (const t of markTimers.values()) clearTimeout(t);
    bridge.ended = true;
    bridge.cleanup();
  }
  const digits = events
      .filter((e) => e.type === "mock.send_dtmf")
      .map((e) => e.digits),
    clears = events.filter((e) => e.type === "phone.playback_clear"),
    errors = events.filter(
      (e) =>
        e.type === "harness_error" ||
        e.type === "bridge_error" ||
        e.type === "mock.technical_fallback",
    );
  const issue = [];
  if (JSON.stringify(digits) !== JSON.stringify(s.expected_digits))
    issue.push("DTMF_SEQUENCE");
  if (s.terminal && !hangup) issue.push("NOT_CLOSED");
  if (!s.terminal && hangup) issue.push("UNEXPECTED_CLOSE");
  if (errors.length) issue.push("TRANSPORT_ERROR");
  if (
    s.interrupt_kind === "backchannel" &&
    clears.some((e) => e.during_interrupt)
  )
    issue.push("AIZUCHI_CUT");
  if (s.interrupt_kind === "request" && !clears.some((e) => e.during_interrupt))
    issue.push("REQUEST_NOT_YIELDED");
  if (hangup && Date.now() < playbackEnd) issue.push("AUDIO_NOT_DRAINED");
  const summary = {
    scenario: s.id,
    assistant_version: config.version_id,
    model: config.model,
    voice: config.voice_settings.voice,
    provider_interruption_enabled: config.interruption_settings.enable,
    external_stt: env.EXTERNAL_STT === "true",
    passed: issue.length === 0,
    issues: issue,
    dtmf_digits: digits,
    hangup,
    forced_test_timeout: forced,
    unplayed_followups: clips.length,
    playback_clears: clears.length,
    server_cancellations: events.filter(
      (e) => e.type === "response.done" && e.response?.status === "cancelled",
    ).length,
    elapsed_ms: Date.now() - start,
    transport:
      "real Telnyx AI WebSocket; simulated PCMU phone, DTMF, playback marks and hangup",
    real_calls: 0,
    production_ready: false,
  };
  writeFileSync(file, JSON.stringify({ summary, events }, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(summary));
}
