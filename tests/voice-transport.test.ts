import { expect, it, afterEach, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
const { validSignature, validStreamUpgrade } = await import(
  new URL("../workers/voice/src/security.mjs", import.meta.url).href
);
const { decodeMuLaw, MuLawEncoder } = await import(
  new URL("../workers/voice/src/audio.mjs", import.meta.url).href
);
const { VoiceBridge } = await import(
  new URL("../workers/voice/src/bridge.mjs", import.meta.url).href
);
const {
  appointmentMismatch,
  playedAppointmentQuestion,
  recipientAppointmentOffer,
} = await import(
  new URL("../workers/voice/src/appointment-evidence.mjs", import.meta.url).href
);
const { default: worker } = await import(
  new URL("../workers/voice/src/index.mjs", import.meta.url).href
);
const rid = "00000000-0000-4000-8000-000000000001",
  callback = "00000000-0000-4000-8000-000000000002";
class Memory {
  data = new Map<string, any>();
  lock = Promise.resolve();
  async get(k: string) {
    return structuredClone(this.data.get(k));
  }
  async put(k: string, v: any) {
    this.data.set(k, structuredClone(v));
  }
  async transaction(fn: any) {
    const r = this.lock.then(() => fn(this));
    this.lock = r.catch(() => {});
    return r;
  }
}
class Socket {
  readyState = 1;
  frames: any[] = [];
  accept() {}
  addEventListener() {}
  send(s: string) {
    this.frames.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
}
const bridges: any[] = [];
afterEach(() => {
  for (const b of bridges) {
    b.ended = true;
    b.cleanup();
  }
  bridges.length = 0;
  vi.useRealTimers();
});
function fixture(provider?: any) {
  let now = Date.now();
  const storage = new Memory(),
    network: any[] = [],
    statuses: any[] = [];
  const row = {
    id: rid,
    status: "dialing",
    callback_token: callback,
    telnyx_call_id: null as string | null,
    conversation_id: null as string | null,
    destination_number: "+819022222222",
    language: "ja",
    instructions:
      "予約の変更可能な時刻を問い合わせてください。名前は言わないでください。",
  };
  const env: any = {
    VOICE_ORIGIN: "https://voice.example",
    VOICE_APP_ID: "123456",
    OUTBOUND_FROM: "+819011111111",
    OUTBOUND_ASSISTANT_ID: "isolated-assistant",
    VOICE_EXECUTION_ENABLED: "true",
    TELNYX_API_KEY: "local-provider-fixture",
    TELNYX_PUBLIC_KEY: "local-public-fixture",
    VOICE_CONTROL_API_SECRET: "local-controller-secret-32-characters",
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => ({ ...row }),
          run: async () => {
            if (sql.includes("SET telnyx_call_id"))
              row.telnyx_call_id = args[0];
            if (sql.includes("SET conversation_id"))
              row.conversation_id = args[0];
            return { success: true };
          },
        }),
      }),
    },
    PHONE_API: {
      fetch: async (url: string, options: any) => {
        statuses.push({
          url,
          fields: Object.fromEntries(new URLSearchParams(options.body)),
        });
        return Response.json({ received: true });
      },
    },
  };
  const b = new VoiceBridge(storage, env, {
    now: () => now,
    providerFetch:
      provider ??
      (async (url: string, options: any = {}) => {
        network.push({
          url,
          method: options.method ?? "GET",
          body: options.body ? JSON.parse(options.body) : null,
        });
        if (options.headers?.Upgrade)
          return { status: 101, webSocket: new Socket() };
        return Response.json({ data: { is_alive: false } });
      }),
  });
  bridges.push(b);
  const register = () =>
    b.register({
      request_id: rid,
      callback_token: callback,
      destination: row.destination_number,
      from: env.OUTBOUND_FROM,
    });
  return {
    b,
    row,
    env,
    storage,
    network,
    statuses,
    register,
    advance: (n: number) => (now += n),
  };
}
it("verifies signed raw webhooks and exact media URLs, rejects replay windows and foreign keys", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64");
  const now = Date.now(),
    time = String(Math.floor(now / 1000));
  const header = (text: string) =>
    new Headers({
      "telnyx-timestamp": time,
      "telnyx-signature-ed25519": sign(
        null,
        Buffer.from(time + "|" + text),
        privateKey,
      ).toString("base64"),
    });
  const body = '{"data":{"event_type":"call.hangup"}}';
  expect(validSignature(header(body), body, pub, now)).toBe(true);
  expect(validSignature(header(body), body + " ", pub, now)).toBe(false);
  expect(validSignature(header(body), body, pub, now + 301000)).toBe(false);
  const url = "wss://voice.example/media/" + rid + "/" + callback,
    h = header(url);
  h.set("Upgrade", "websocket");
  expect(
    validStreamUpgrade(
      new Request(url.replace("wss:", "https:"), { headers: h }),
      url,
      pub,
      now,
    ),
  ).toBe(true);
  expect(
    validStreamUpgrade(
      new Request(url.replace("wss:", "https:") + "?x=1", { headers: h }),
      url,
      pub,
      now,
    ),
  ).toBe(false);
});
it("creates only a bound dial contract for already-approved Japanese requests, with one stream nonce", async () => {
  const f = fixture();
  f.row.status = "pending_approval";
  expect((await f.register()).status).toBe(409);
  f.row.status = "dialing";
  const a = await (await f.register()).json(),
    b = await (await f.register()).json();
  expect(a.payload.stream_url).toBe(b.payload.stream_url);
  expect(a.payload.to).toBe(f.row.destination_number);
  expect(a.payload.command_id).toBe(rid);
  expect(a.payload.time_limit_secs).toBe(300);
  expect(a.payload.connection_id).toBe("123456");
  expect(f.network).toEqual([]);
  const claims = await Promise.all([
    f.b.reserveStream(f.b.context.stream_nonce),
    f.b.reserveStream(f.b.context.stream_nonce),
  ]);
  expect(claims).toEqual([true, false]);
  f.row.instructions += "modified";
  expect((await f.register()).status).toBe(409);
});
it("requires server authentication before any registration or unsigned webhook reaches a session", async () => {
  const f = fixture();
  f.env.VOICE_SESSIONS = {
    idFromName: () => {
      throw Error("Must not be reached");
    },
  };
  expect(
    (
      await worker.fetch(
        new Request("https://voice.example/register", {
          method: "POST",
          body: "{}",
        }),
        f.env,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await worker.fetch(
        new Request("https://voice.example/webhooks/telnyx", {
          method: "POST",
          body: "{}",
        }),
        f.env,
      )
    ).status,
  ).toBe(403);
});
it("opens verified Japanese Nova-3 recognition without unsupported Flux parameters and retains an explicit rollback model", async () => {
  const f = fixture();
  await f.register();
  await f.b.openStt();
  const url = new URL(
    f.network.find((n: any) => n.url.includes("/speech-to-text/")).url,
  );
  expect(url.searchParams.get("model")).toBe("nova-3");
  expect(url.searchParams.get("language")).toBe("ja");
  expect(url.searchParams.get("input_format")).toBe("linear16");
  expect(url.searchParams.get("sample_rate")).toBe("8000");
  expect(url.searchParams.has("eot_threshold")).toBe(false);
  expect(url.searchParams.has("eot_timeout_ms")).toBe(false);
  expect(
    (
      await (
        await worker.fetch(new Request("https://voice.example/health"), f.env)
      ).json()
    ).recognition_model,
  ).toBe("nova-3");
  const g = fixture();
  g.env.OUTBOUND_STT_MODEL = "flux-multi";
  await g.register();
  await g.b.openStt();
  const previous = new URL(
    g.network.find((n: any) => n.url.includes("/speech-to-text/")).url,
  );
  expect(previous.searchParams.get("model")).toBe("flux-multi");
  expect(previous.searchParams.get("eot_timeout_ms")).toBe("2000");
  const bad = fixture();
  bad.env.OUTBOUND_STT_MODEL = "unverified-model";
  await expect(bad.register()).rejects.toThrow(
    "Unsupported outbound recognition model",
  );
  expect(bad.network).toEqual([]);
});
it("decodes each live recognition frame into paced 8kHz little-endian PCM, padding silence", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.env.EXTERNAL_STT = "true";
  await f.register();
  const frames: Buffer[] = [];
  f.b.stt = {
    readyState: 1,
    send: (data: Buffer) => frames.push(Buffer.from(data)),
  };
  await f.b.attachMedia(new Socket());
  f.b.sttQueue = [0, 128, 255];
  await vi.advanceTimersByTimeAsync(40);
  expect(frames).toHaveLength(2);
  expect(frames[0].length).toBe(320);
  expect([0, 2, 4].map((offset) => frames[0].readInt16LE(offset))).toEqual([
    -32124, 32124, 0,
  ]);
  expect(frames[0].subarray(6).every((value) => value === 0)).toBe(true);
  expect(frames[1].equals(Buffer.alloc(320))).toBe(true);
});
it("counts final recognition and delivered menu evidence without retaining transcript text", async () => {
  const f = fixture();
  await f.register();
  f.b.observeRecognitionFrame({
    transcript: "五を押してください。",
    is_final: false,
  });
  f.b.observeRecognitionFrame({
    transcript: "五を押してください。",
    is_final: true,
  });
  expect(f.b.context.stt_observations).toEqual({
    frames: 2,
    text_finals: 1,
    raw_five_finals: 1,
    delivered_five: 0,
    input_format: "linear16",
  });
  expect(JSON.stringify(f.b.context.stt_observations)).not.toContain(
    "押してください",
  );
});
it("roundtrips telephony PCM in 20ms mu-law frames without dropping partial codec groups", () => {
  for (const rate of [8000, 16000, 24000]) {
    const samples = rate / 10,
      pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++)
      pcm.writeInt16LE(
        Math.round(6000 * Math.sin((2 * Math.PI * 400 * i) / rate)),
        i * 2,
      );
    const e = new MuLawEncoder(rate);
    const frames = [
      ...e.append(pcm.subarray(0, 7)),
      ...e.append(pcm.subarray(7)),
      ...e.drain(true),
    ];
    expect(frames).toHaveLength(5);
    expect(frames.every((b: any) => b.length === 160)).toBe(true);
    const decoded = decodeMuLaw(Buffer.concat(frames));
    expect(decoded.length).toBe(1600);
    let energy = 0;
    for (let i = 0; i < decoded.length; i += 2)
      energy += decoded.readInt16LE(i) ** 2;
    expect(Math.sqrt(energy / 800)).toBeGreaterThan(3500);
  }
  expect(() => new MuLawEncoder(44100)).toThrow();
  expect([...decodeMuLaw(Buffer.from([255, 127]))]).toEqual([0, 0, 0, 0]);
});
it("never hangs up before the actual current-stream playback mark, and never dials from the bridge", async () => {
  const f = fixture();
  await f.register();
  f.b.context.dialogue_candidate_observed = {
    at: Date.now(),
    digest: "fixture",
  };
  const media = new Socket();
  await f.b.attachMedia(media);
  await f.b.bindCall("bound-call");
  f.b.streamId = "stream";
  await f.b.onVoice({
    type: "session.created",
    session: {
      conversation_id: "isolated-conversation",
      audio: {
        input: { format: { rate: 8000 } },
        output: { format: { rate: 16000 } },
      },
    },
  });
  expect(f.row.conversation_id).toBe("isolated-conversation");
  f.b.controller.event({ type: "input_audio_buffer.speech_stopped" });
  await f.b.onVoice({ type: "response.created", response: { id: "farewell" } });
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "farewell",
    delta: "ありがとうございます。失礼いたします。",
  });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "farewell",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  await f.b.onVoice({
    type: "response.done",
    response: { id: "farewell", status: "completed" },
  });
  await f.b.controller.command("close", "finish_call_after_goodbye", {
    outcome: "confirmed",
  });
  f.advance(2000);
  expect(await f.b.controller.tick()).toBe(false);
  expect(f.network.some((n) => n.url.endsWith("/hangup"))).toBe(false);
  const mark = media.frames.find((m) => m.event === "mark").mark.name;
  await f.b.onMedia({
    event: "mark",
    stream_id: "stream",
    mark: { name: mark },
  });
  expect(await f.b.controller.tick()).toBe(true);
  expect(
    f.network.filter((n) => n.url.endsWith("/actions/hangup")),
  ).toHaveLength(1);
  expect(
    f.network.some((n) => n.url === "https://api.telnyx.com/v2/calls"),
  ).toBe(false);
});
it("reserves provider commands durably before concurrent requests and rejects changed command bodies", async () => {
  let sent = 0,
    resolve: any;
  const f = fixture(async () => {
    sent++;
    return new Promise((r) => (resolve = r));
  });
  await f.register();
  f.b.context.call_id = "bound-call";
  await f.b.persist();
  const first = f.b.voiceAPI("send_dtmf", { digits: "2" }, "operation");
  await new Promise((r) => setTimeout(r, 1));
  expect(
    (await f.b.voiceAPI("send_dtmf", { digits: "2" }, "operation")).reason,
  ).toBe("DISPATCH_UNCONFIRMED");
  resolve(Response.json({ ok: true }));
  expect((await first).ok).toBe(true);
  expect(
    (await f.b.voiceAPI("send_dtmf", { digits: "3" }, "operation")).reason,
  ).toBe("OPERATION_CONFLICT");
  expect(sent).toBe(1);
  await expect(f.b.voiceAPI("dial", {}, "x")).rejects.toThrow();
});
it("processes signed-context status webhooks once and preserves the existing phone callback contract", async () => {
  const f = fixture();
  await f.register();
  const event = {
    id: crypto.randomUUID(),
    event_type: "call.answered",
    occurred_at: new Date().toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: "bound-call",
      client_state: Buffer.from(
        JSON.stringify({ request_id: rid, nonce: f.b.context.nonce }),
      ).toString("base64"),
    },
  };
  await Promise.all([f.b.onWebhook(event), f.b.onWebhook(event)]);
  expect(f.statuses).toHaveLength(1);
  expect(f.statuses[0].fields.CallStatus).toBe("answered");
  expect(f.statuses[0].fields.CallSid).toBe("bound-call");
  await expect(f.b.bindCall("other-call")).rejects.toThrow();
  const foreign = {
    ...event,
    id: crypto.randomUUID(),
    payload: { ...event.payload, connection_id: "foreign" },
  };
  expect((await f.b.onWebhook(foreign)).status).toBe(403);
});
it("preserves queued speech for aizuchi and cancels it for an actual request with local interruption control", async () => {
  const f = fixture();
  await f.register();
  f.b.context.dialogue_candidate_observed = {
    at: Date.now(),
    digest: "fixture",
  };
  const media = new Socket();
  await f.b.attachMedia(media);
  f.b.voice = new Socket();
  f.b.encoder = new MuLawEncoder(16000);
  f.b.outputRate = 16000;
  await f.b.onVoice({ type: "response.created", response: { id: "speaking" } });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "speaking",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  await f.b.onVoice({ type: "input_audio_buffer.speech_started" });
  await f.b.onVoice({ type: "input_audio_buffer.speech_stopped" });
  await f.b.onVoice({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "はい。",
  });
  expect(media.frames.some((e) => e.event === "clear")).toBe(false);
  expect(f.b.voice.frames.some((e: any) => e.type === "response.cancel")).toBe(
    false,
  );
  await f.b.onVoice({ type: "input_audio_buffer.speech_started" });
  await f.b.onVoice({ type: "input_audio_buffer.speech_stopped" });
  await f.b.onVoice({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "ちょっと待ってください。",
  });
  expect(media.frames.filter((e) => e.event === "clear")).toHaveLength(1);
  expect(
    f.b.voice.frames.filter((e: any) => e.type === "response.cancel"),
  ).toHaveLength(1);
});
it("does not emit a technical farewell when the telephone leg has already ended", async () => {
  const f = fixture();
  await f.register();
  await f.b.bindCall("bound-call");
  await f.b.disconnected();
  expect(f.b.ended).toBe(true);
  expect(f.network.some((n) => n.method === "POST")).toBe(false);
});
it("requires the matching completed farewell event and ignores cancelled farewell callbacks", async () => {
  const f = fixture();
  await f.register();
  f.env.CONTROLLED_FAREWELL = "true";
  await f.b.attachMedia(new Socket());
  await f.b.bindCall("bound-call");
  f.b.controller.event({ type: "input_audio_buffer.speech_stopped" });
  f.b.controller.event({
    type: "assistant_completed",
    text: "承知しました。",
    no_audio: true,
  });
  await f.b.controller.command("close-safe", "finish_call_after_goodbye", {
    outcome: "unable_to_proceed",
  });
  f.advance(2000);
  expect(await f.b.controller.tick()).toBe(false);
  const speak = f.network.find((n) => n.url.endsWith("/actions/speak"));
  expect(speak.body.payload).toBe("ありがとうございます。失礼いたします。");
  expect(f.network.some((n) => n.url.endsWith("/actions/hangup"))).toBe(false);
  const event = (state: string) => ({
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date().toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: "bound-call",
      client_state: state,
      status: "completed",
    },
  });
  const state = speak.body.client_state;
  await f.b.cancelControlledFarewell();
  await f.b.onWebhook(event(state));
  f.advance(2000);
  expect(await f.b.controller.tick()).toBe(false);
  expect(f.network.some((n) => n.url.endsWith("/actions/hangup"))).toBe(false);
  expect(
    f.network.filter((n) => n.url.endsWith("/actions/playback_stop")),
  ).toHaveLength(1);
});
it("hangs up once only after the controlled farewell has actually completed", async () => {
  const f = fixture();
  await f.register();
  f.env.CONTROLLED_FAREWELL = "true";
  await f.b.attachMedia(new Socket());
  await f.b.bindCall("bound-call");
  f.b.controller.event({ type: "input_audio_buffer.speech_stopped" });
  f.b.controller.event({
    type: "assistant_completed",
    text: "承知しました。",
    no_audio: true,
  });
  await f.b.controller.command("close-safe", "finish_call_after_goodbye", {
    outcome: "refused",
  });
  f.advance(2000);
  await f.b.controller.tick();
  const state = f.b.context.controlled_closing.state;
  const e = {
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date().toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: "bound-call",
      client_state: state,
      status: "completed",
    },
  };
  await Promise.all([f.b.onWebhook(e), f.b.onWebhook(e)]);
  expect(await f.b.controller.tick()).toBe(false);
  f.advance(300);
  expect(await f.b.controller.tick()).toBe(true);
  await f.b.controller.tick();
  expect(
    f.network.filter((n) => n.url.endsWith("/actions/hangup")),
  ).toHaveLength(1);
});
it("drops late audio from a cancelled response without clearing a newer response", async () => {
  const f = fixture();
  await f.register();
  f.b.context.dialogue_candidate_observed = {
    at: Date.now(),
    digest: "fixture",
  };
  const media = new Socket();
  await f.b.attachMedia(media);
  await f.b.bindCall("bound-call");
  f.b.streamId = "stream";
  await f.b.onVoice({
    type: "session.created",
    session: {
      conversation_id: "isolated",
      audio: {
        input: { format: { rate: 8000 } },
        output: { format: { rate: 8000 } },
      },
    },
  });
  await f.b.onVoice({ type: "response.created", response: { id: "old" } });
  f.b.cancelOutput();
  const before = media.frames.length;
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "old",
    delta: Buffer.alloc(320).toString("base64"),
  });
  expect(media.frames.length).toBe(before);
  await f.b.onVoice({ type: "response.created", response: { id: "new" } });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "new",
    delta: Buffer.alloc(320).toString("base64"),
  });
  const clears = media.frames.filter((m) => m.event === "clear").length;
  await f.b.onVoice({
    type: "response.done",
    response: { id: "old", status: "cancelled" },
  });
  expect(media.frames.filter((m) => m.event === "clear").length).toBe(clears);
  expect(f.b.controller.responseActive).toBe(true);
});
it("keeps generated keypad narration inaudible while a completed IVR menu is current", async () => {
  const f = fixture();
  await f.register();
  const media = new Socket();
  await f.b.attachMedia(media);
  await f.b.bindCall("bound-call");
  await f.b.onVoice({
    type: "session.created",
    session: {
      conversation_id: "isolated",
      audio: {
        input: { format: { rate: 8000 } },
        output: { format: { rate: 8000 } },
      },
    },
  });
  f.b.controller.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "予約の変更は2番を押してください。",
  });
  await f.b.onVoice({
    type: "response.created",
    response: { id: "menu-narration" },
  });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "menu-narration",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  expect(media.frames.some((m) => m.event === "media")).toBe(false);
});
it("protects registration diagnostics and keeps active preflight probes disabled by default", async () => {
  const f = fixture();
  f.env.VOICE_SESSIONS = {
    idFromName: () => {
      throw Error("Unauthorized access");
    },
  };
  expect(
    (
      await worker.fetch(
        new Request("https://voice.example/diagnostics/registration/" + rid),
        f.env,
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await worker.fetch(
        new Request("https://voice.example/diagnostics/preflight", {
          method: "POST",
        }),
        f.env,
      )
    ).status,
  ).toBe(404);
  f.env.VOICE_DIAGNOSTICS_ENABLED = "true";
  expect(
    (
      await worker.fetch(
        new Request("https://voice.example/diagnostics/preflight", {
          method: "POST",
        }),
        f.env,
      )
    ).status,
  ).toBe(401);
});
it("returns only redacted registration metadata through authenticated diagnostics", async () => {
  const { VoiceSession } = await import(
    new URL("../workers/voice/src/index.mjs", import.meta.url).href
  );
  const f = fixture();
  const session = new VoiceSession(
    { storage: f.storage, waitUntil: () => {} },
    f.env,
  );
  session.bridge.context = {
    request_id: rid,
    from: "+819011111111",
    destination: "+819022222222",
    instructions: "PRIVATE TASK",
    callback_token: "PRIVATE TOKEN",
    nonce: "PRIVATE NONCE",
    failure: "voice_event_failed",
  };
  const r = await session.fetch(
    new Request("https://voice.example/diagnostics/registration/" + rid, {
      headers: { Authorization: "Bearer " + f.env.VOICE_CONTROL_API_SECRET },
    }),
  );
  const b = await r.json();
  expect(b.registered).toBe(true);
  expect(b.failure).toBe("voice_event_failed");
  expect(b.call_bound).toBe(false);
  expect(JSON.stringify(b)).not.toMatch(
    /PRIVATE|819011|819022|instructions|callback_token|nonce/,
  );
});
it("accepts the actual Telnyx connected control frame before the authenticated stream start", async () => {
  const f = fixture();
  await f.register();
  await f.b.attachMedia(new Socket());
  await expect(
    f.b.onMedia({ event: "connected", version: "1.0.0" }),
  ).resolves.toBeUndefined();
  expect(f.b.streamId).toBeUndefined();
  expect(f.network).toEqual([]);
  f.b.streamId = "already-started";
  await expect(
    f.b.onMedia({ event: "connected", version: "1.0.0" }),
  ).rejects.toThrow("after start");
});
it("does not invalidate an IVR snapshot for raw music/noise, but rejects it after a recognized human turn", async () => {
  const f = fixture();
  await f.register();
  f.env.EXTERNAL_STT = "true";
  await f.b.attachMedia(new Socket());
  await f.b.bindCall("bound-call");
  f.b.controller.event({ type: "input_audio_buffer.speech_stopped" });
  f.b.controller.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "その他のご質問は五を押してください。",
  });
  f.advance(800);
  const m = await f.b.controller.command("read", "read_current_menu", {});
  f.b.activity.observe(Buffer.alloc(160, 0));
  expect(f.b.controller.menu.token).toBe(m.menu_token);
  expect(f.b.controller.speaking).toBe(false);
  f.b.turns.accept({
    type: "TurnInfo",
    request_id: "test",
    turn_index: 1,
    event: "StartOfTurn",
    transcript: "はい",
  });
  const select = f.b.controller.command("select", "press_ivr_digit", {
    digits: "5",
    menu_token: m.menu_token,
  });
  f.b.turns.accept({
    type: "TurnInfo",
    request_id: "test",
    turn_index: 1,
    event: "EndOfTurn",
    transcript: "はい、担当者です。ご用件は何でしょうか。",
  });
  f.advance(800);
  await f.b.controller.tick();
  expect((await select).reason).toBe("STALE_OR_INCOMPLETE_MENU");
  expect(f.network.some((n) => n.url.endsWith("/send_dtmf"))).toBe(false);
});
it("records a requested/accepted DTMF once with explicit duration and never treats acceptance as a transition", async () => {
  const f = fixture();
  await f.register();
  await f.b.attachMedia(new Socket());
  await f.b.bindCall("bound-call");
  f.b.controller.menu = { text: "その他のご質問は五を押してください。" };
  await f.b.sendIvrDigit("5", { operationId: "selection" });
  const deadline = f.b.context.ivr_progress.deadline;
  await f.b.sendIvrDigit("5", { operationId: "selection" });
  expect(f.network.filter((n) => n.url.endsWith("/send_dtmf"))).toHaveLength(1);
  expect(
    f.network.find((n) => n.url.endsWith("/send_dtmf")).body.duration_millis,
  ).toBe(250);
  const audit = [...f.storage.data.values()].filter((v) => v.event);
  expect(audit.filter((v) => v.event === "dtmf_requested")).toHaveLength(1);
  expect(audit.filter((v) => v.event === "dtmf_accepted")).toHaveLength(1);
  expect(f.b.context.ivr_progress.state).toBe("awaiting_transition");
  expect(f.b.context.ivr_progress.deadline).toBe(deadline);
  await f.b.observeIvrProgress("その他のご質問は五を押してください。");
  expect(f.b.context.ivr_progress.state).toBe("awaiting_transition");
  await f.b.observeIvrProgress("担当者におつなぎいたします。");
  expect(f.b.context.ivr_progress.state).toBe("transition_observed");
  f.advance(60000);
  await f.b.checkIvrDeadline();
  expect(f.network.some((n) => n.url.endsWith("/speak"))).toBe(false);
});
it("ends a no-transition attempt after its bounded wait, and records completion only on the actual hangup webhook", async () => {
  const f = fixture();
  await f.register();
  await f.b.attachMedia(new Socket());
  await f.b.bindCall("bound-call");
  f.b.context.answered_at = new Date().toISOString();
  f.b.controller.menu = { text: "その他のご質問は五を押してください。" };
  await f.b.sendIvrDigit("5", { operationId: "selection" });
  f.advance(44999);
  await f.b.checkIvrDeadline();
  expect(f.network.some((n) => n.url.endsWith("/speak"))).toBe(false);
  f.advance(1);
  await Promise.all([f.b.checkIvrDeadline(), f.b.checkIvrDeadline()]);
  expect(f.b.context.close_outcome).toBe("unable_to_proceed");
  expect(f.b.context.failure).toBe("ivr_transition_timeout");
  expect(f.network.filter((n) => n.url.endsWith("/speak"))).toHaveLength(1);
  expect(f.network.some((n) => n.url.endsWith("/hangup"))).toBe(false);
  const speakEnded = {
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date().toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: "bound-call",
      client_state: f.b.context.fallback_state,
      status: "completed",
    },
  };
  await f.b.onWebhook(speakEnded);
  await f.b.finishFallback();
  expect(f.network.filter((n) => n.url.endsWith("/hangup"))).toHaveLength(1);
  expect(
    [...f.storage.data.values()].some((v) => v.event === "hangup_completed"),
  ).toBe(false);
  const end = {
    ...speakEnded,
    id: crypto.randomUUID(),
    event_type: "call.hangup",
    payload: { ...speakEnded.payload, hangup_source: "caller" },
  };
  await Promise.all([f.b.onWebhook(end), f.b.onWebhook(end)]);
  expect(
    [...f.storage.data.values()].filter((v) => v.event === "hangup_completed"),
  ).toHaveLength(1);
});
it("does not arm transition tracking or log acceptance for an uncertain DTMF dispatch", async () => {
  const f = fixture(async () => {
    throw Error("Unknown transport outcome");
  });
  await f.register();
  await f.b.bindCall("bound-call");
  f.b.controller = { menu: { text: "五を押してください。" } };
  expect((await f.b.sendIvrDigit("5", { operationId: "selection" })).ok).toBe(
    false,
  );
  expect(f.b.context.ivr_progress).toBeUndefined();
  expect(
    [...f.storage.data.values()].some((v) => v.event === "dtmf_accepted"),
  ).toBe(false);
});
it("uses one bounded fallback hangup even if the farewell completion callback is lost", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.register();
  await f.b.attachMedia(new Socket());
  await f.b.bindCall("bound-call");
  f.b.context.answered_at = new Date().toISOString();
  f.b.controller.menu = { text: "その他のご質問は五を押してください。" };
  await f.b.sendIvrDigit("5", { operationId: "selection" });
  f.advance(45000);
  await f.b.checkIvrDeadline();
  await vi.advanceTimersByTimeAsync(19999);
  expect(f.network.some((n) => n.url.endsWith("/hangup"))).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.network.filter((n) => n.url.endsWith("/hangup"))).toHaveLength(1);
  await f.b.finishFallback();
  expect(f.network.filter((n) => n.url.endsWith("/hangup"))).toHaveLength(1);
  expect(
    [...f.storage.data.values()].some((v) => v.event === "hangup_completed"),
  ).toBe(false);
});
it("lets a current IVR sentence finish before the no-transition close, without waiting five minutes", async () => {
  const f = fixture();
  await f.register();
  await f.b.attachMedia(new Socket());
  await f.b.bindCall("bound-call");
  f.b.context.answered_at = new Date().toISOString();
  f.b.controller.menu = {
    text: "その他のご質問は五を押してください。",
    isIvr: true,
  };
  await f.b.sendIvrDigit("5", { operationId: "selection" });
  f.b.controller.speaking = true;
  f.advance(45000);
  await f.b.checkIvrDeadline();
  expect(f.network.some((n) => n.url.endsWith("/speak"))).toBe(false);
  f.b.controller.speaking = false;
  await f.b.checkIvrDeadline();
  expect(f.network.filter((n) => n.url.endsWith("/speak"))).toHaveLength(1);
});

async function dialogueFixture(instructions?: string) {
  const f = fixture();
  f.env.EXTERNAL_STT = "true";
  f.env.CONTROLLED_FAREWELL = "true";
  if (instructions) f.row.instructions = instructions;
  await f.register();
  const media = new Socket();
  await f.b.attachMedia(media);
  await f.b.bindCall("bound-call");
  f.b.streamId = "stream";
  f.b.voice = new Socket();
  await f.b.onVoice({
    type: "session.created",
    session: {
      conversation_id: "isolated-dialogue",
      audio: {
        input: { format: { rate: 8000 } },
        output: { format: { rate: 8000 } },
      },
    },
  });
  // Generic dialogue fixtures represent an already-established conversation.
  // Startup/IVR regressions explicitly clear this evidence below.
  f.b.context.dialogue_candidate_observed = {
    at: Date.now(),
    digest: "fixture",
  };
  const generate = async (id: string, text: string, bytes = 3200) => {
    await f.b.onVoice({ type: "response.created", response: { id } });
    await f.b.onVoice({
      type: "response.output_audio.delta",
      response_id: id,
      delta: Buffer.alloc(bytes).toString("base64"),
    });
    if (text)
      await f.b.onVoice({
        type: "response.output_audio_transcript.delta",
        response_id: id,
        delta: text,
      });
    await f.b.onVoice({
      type: "response.done",
      response: { id, status: "completed" },
    });
  };
  const recipient = (text: string) => {
    f.b.beginTurn();
    f.b.deliverTranscript(text);
  };
  return { ...f, media, generate, recipient };
}
it("blocks initial questions and recorded welcomes until recipient dialogue evidence exists", async () => {
  const f = await dialogueFixture();
  f.b.context.dialogue_candidate_observed = null;
  await f.generate("startup-question", "予約なしで購入できますか。");
  f.recipient("AppleStore銀座にお電話いただきありがとうございます。");
  await f.generate("ivr-question", "次回の入荷予定は分かりますか。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  expect(f.b.context.output_audit).toMatchObject({
    completed_responses: 2,
    released_responses: 0,
    blocked_responses: 2,
    released_pcm_bytes: 0,
    recipient_reception_proven: false,
  });
  f.recipient("もしもし、ご用件をお伺いします。");
  f.advance(1000);
  await f.generate("actual-dialogue", "予約なしで購入できますか。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
  expect(f.b.context.output_audit.released_responses).toBe(1);
  await f.b.onVoice({
    type: "response.done",
    response: { id: "actual-dialogue", status: "completed" },
  });
  expect(f.b.context.output_audit.released_responses).toBe(1);
});
it("keeps the first checked acknowledgement through the recorded repeated staff introduction", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = { state: "dialogue_candidate", baseline: "" };
  await f.b.onVoice({
    type: "response.created",
    response: { id: "intro-ack" },
  });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "intro-ack",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  f.advance(4120);
  f.recipient("Apple川崎店舗案内でございます。");
  expect(f.b.context.deferred_audibility_checks).toBe(1);
  expect(f.b.responses.get("intro-ack").suppressed).toBe(false);
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "intro-ack",
    delta: "はい、聞こえています。",
  });
  await f.b.onVoice({
    type: "response.done",
    response: { id: "intro-ack", status: "completed" },
  });
  expect(f.media.frames.filter((x: any) => x.event === "media")).toHaveLength(
    10,
  );
  f.advance(6000);
  expect(
    f.b.deferInitialAudibilityCheck("Apple川崎店舗案内でございます。"),
  ).toBe(false);
  expect(
    f.b.deferInitialAudibilityCheck(
      "Apple川崎店舗案内でございます。在庫はありません。",
    ),
  ).toBe(false);
});
it("serializes metadata updates so an older write cannot overwrite the final audio audit", async () => {
  const f = fixture();
  await f.register();
  f.b.context.call_id = "bound-call";
  f.b.context.conversation_id = "local-conversation";
  let release: any, started: any;
  const ready = new Promise((r) => (started = r));
  const writes: any[] = [];
  f.b.providerFetch = async (_url: string, options: any) => {
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) {
      started();
      return new Promise((r) => (release = () => r(Response.json({}))));
    }
    return Response.json({});
  };
  const first = f.b.bindConversation(true);
  await ready;
  f.b.context.output_audit = { released_pcm_bytes: 3200 };
  const final = f.b.bindConversation(true);
  f.b.context.terminal_at = new Date().toISOString();
  expect(writes).toHaveLength(1);
  release();
  await Promise.all([first, final]);
  expect(writes).toHaveLength(2);
  expect(writes[1].metadata.voice_output_audit_final).toBe("true");
  expect(
    JSON.parse(writes[1].metadata.voice_output_audit).released_pcm_bytes,
  ).toBe(3200);
});
it("keeps a validated first reply through a short acoustic tail and releases it once quiet", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = { state: "dialogue_candidate", baseline: "" };
  f.b.activity = { active: true };
  await f.generate("quiet-tail", "はい、聞こえています。");
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    0,
  );
  expect(f.b.responses.get("quiet-tail").chunks.length).toBeGreaterThan(0);
  f.advance(320);
  f.b.activity.active = false;
  await f.b.checkDialogue();
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    10,
  );
  await f.b.checkDialogue();
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    10,
  );
});
it.each(["question", "hold", "new_response", "timeout", "cleanup"])(
  "drops waiting validated speech on %s without later release",
  async (reason) => {
    const f = await dialogueFixture();
    f.b.activity = { active: true };
    await f.generate("waiting", "はい、聞こえています。");
    const deadline = f.b.responses.get("waiting").quietDeadline;
    expect(f.b.responses.get("waiting").waitingForQuiet).toBe(true);
    if (reason === "question")
      f.recipient("違います。予約の変更をお願いできますか？");
    if (reason === "hold") f.recipient("少々お待ちください。");
    if (reason === "new_response")
      await f.b.onVoice({
        type: "response.created",
        response: { id: "new-response" },
      });
    if (reason === "timeout") {
      f.advance(1000);
      f.recipient("もしもし。");
      expect(f.b.responses.get("waiting").quietDeadline).toBe(deadline);
      f.advance(1000);
    }
    if (reason === "cleanup") {
      f.b.ended = true;
      f.b.cleanup();
    }
    f.b.activity.active = false;
    await f.b.checkDialogue();
    expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
      0,
    );
    expect(f.b.responses.get("waiting").chunks).toEqual([]);
    expect(f.b.context.output_audit.released_responses).toBe(0);
    f.advance(3000);
    await f.b.checkDialogue();
    expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
      0,
    );
  },
);
it("does not emit queued model audio while a fixed-speech stop is still pending", async () => {
  const f = await dialogueFixture();
  f.b.activity = { active: true };
  await f.generate("pending-stop", "はい、聞こえています。");
  let release: any, started: any;
  const ready = new Promise((r) => (started = r));
  f.b.voiceAPI = async () => {
    started();
    return new Promise((r) => (release = () => r({ ok: true })));
  };
  const stopping = f.b.systemVoiceAction(
    "playback_stop",
    { stop: "all" },
    "local-stop",
  );
  await ready;
  f.b.activity.active = false;
  await f.b.checkDialogue();
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    0,
  );
  release();
  await stopping;
  f.advance(200);
  await f.b.checkDialogue();
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    10,
  );
});
it("does not renew the quiet deadline after a slow fixed-speech cancellation", async () => {
  const f = await dialogueFixture();
  await f.b.onVoice({
    type: "response.created",
    response: { id: "slow-stop" },
  });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "slow-stop",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "slow-stop",
    delta: "はい、聞こえています。",
  });
  let release: any;
  f.b.systemActions = new Promise((r) => (release = r));
  const completed = f.b.onVoice({
    type: "response.done",
    response: { id: "slow-stop", status: "completed" },
  });
  f.advance(2001);
  release();
  await completed;
  await f.b.checkDialogue();
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    0,
  );
});
it("cannot validate or release an old response that a new generation supersedes during a pending stop", async () => {
  const f = await dialogueFixture();
  await f.b.onVoice({
    type: "response.created",
    response: { id: "old-during-stop" },
  });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "old-during-stop",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "old-during-stop",
    delta: "Call Summary: unable_to_proceed",
  });
  let release: any;
  f.b.systemActions = new Promise((r) => (release = r));
  const old = f.b.onVoice({
    type: "response.done",
    response: { id: "old-during-stop", status: "completed" },
  });
  await f.b.onVoice({
    type: "response.created",
    response: { id: "new-during-stop" },
  });
  release();
  await old;
  expect(f.b.controller.responseId).toBe("new-during-stop");
  expect(f.b.responses.get("new-during-stop").suppressed).toBe(false);
  expect(f.b.spokenBlocks).toBe(0);
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    0,
  );
});
it("validates transcript safety before waiting for quiet and permits no late transcript replacement", async () => {
  const f = await dialogueFixture();
  f.b.activity = { active: true };
  await f.generate("unsafe-quiet", "Call Summary: unable_to_proceed");
  f.b.activity.active = false;
  await f.b.checkDialogue();
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    0,
  );
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "unsafe-quiet",
    delta: "はい、聞こえています。",
  });
  expect(f.b.responses.get("unsafe-quiet").text).toContain("Call Summary");
});
it("sets the first-reply grace for direct pickup without requiring an earlier IVR", async () => {
  const f = await dialogueFixture();
  delete f.b.context.ivr_progress;
  await f.b.onVoice({
    type: "response.created",
    response: { id: "direct-pickup" },
  });
  expect(f.b.context.initial_dialogue_response.id).toBe("direct-pickup");
  f.advance(1500);
  f.recipient("Apple川崎店舗案内でございます。");
  expect(f.b.responses.get("direct-pickup").suppressed).toBe(false);
});
it("lets the first validated reply finish through repeated audibility checks, with a fixed nonrenewable grace", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = { state: "dialogue_candidate", baseline: "" };
  f.recipient("お電話ありがとうございます。丸の内です。");
  await f.b.onVoice({
    type: "response.created",
    response: { id: "first-audible" },
  });
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++)
    pcm.writeInt16LE(
      Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / 8000)),
      i * 2,
    );
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "first-audible",
    delta: pcm.toString("base64"),
  });
  const before = f.b.voice.frames.length;
  const startedAt = f.b.context.initial_dialogue_response.started_at;
  // Approximate offsets from the first assistant entry in the Marunouchi
  // transcript; these are regression timings, not inference measurements.
  f.advance(1590);
  f.recipient("もしもし。");
  f.advance(5179);
  f.recipient("お声は届いておりますでしょうか？");
  expect(
    f.b.voice.frames
      .slice(before)
      .some((x: any) => x.type === "response.cancel"),
  ).toBe(false);
  expect(f.b.context.deferred_audibility_checks).toBe(2);
  expect(f.b.context.initial_dialogue_response.started_at).toBe(startedAt);
  expect(f.media.frames.some((x: any) => x.event === "media")).toBe(false);
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "first-audible",
    delta: "はい、聞こえています。",
  });
  await f.b.onVoice({
    type: "response.done",
    response: { id: "first-audible", status: "completed" },
  });
  expect(f.media.frames.some((x: any) => x.event === "media")).toBe(true);
  const emitted = f.media.frames.filter((x: any) => x.event === "media");
  expect(emitted).toHaveLength(10);
  expect(
    emitted.some((x: any) =>
      Buffer.from(x.media.payload, "base64").some(
        (b: number) => b !== 255 && b !== 127,
      ),
    ),
  ).toBe(true);
  f.advance(3232);
  expect(f.b.deferInitialAudibilityCheck("もしもし。")).toBe(false);
});
it("never defers real instructions, changed task details or audibility checks on a later response", async () => {
  for (const text of [
    "ちょっと待ってください。",
    "もしもし、在庫はありません。",
    "違います、予約を変更してください。",
  ]) {
    const f = await dialogueFixture();
    f.b.context.ivr_progress = { state: "dialogue_candidate", baseline: "" };
    await f.b.onVoice({ type: "response.created", response: { id: "first" } });
    f.recipient(text);
    expect(f.b.responses.get("first").suppressed).toBe(true);
    expect(f.b.context.deferred_audibility_checks ?? 0).toBe(0);
  }
  const f = await dialogueFixture();
  f.b.context.ivr_progress = { state: "dialogue_candidate", baseline: "" };
  await f.generate("first", "はい、聞こえています。");
  f.advance(2000);
  await f.b.onVoice({ type: "response.created", response: { id: "second" } });
  f.recipient("もしもし。");
  expect(f.b.responses.get("second").suppressed).toBe(true);
});
async function firstDeliveredQuestionFixture(generationChecks = false) {
  const f = await dialogueFixture();
  f.b.outputRate = 24000;
  // The Yodobashi trace generated three cancelled starts before the first
  // complete question. Generation IDs alone therefore do not identify what
  // the recipient has actually had a chance to hear.
  for (let n = 0; n < 3; n++) {
    const id = `cancelled-start-${n}`;
    await f.b.onVoice({ type: "response.created", response: { id } });
    await f.b.onVoice({
      type: "response.output_audio.delta",
      response_id: id,
      delta: Buffer.alloc(4800).toString("base64"),
    });
    f.advance(1000);
    f.recipient("ご用件をお伺いします。");
    await f.b.onVoice({
      type: "response.done",
      response: { id, status: "cancelled" },
    });
  }
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  await f.b.onVoice({
    type: "response.created",
    response: { id: "first-delivered-question" },
  });
  const pcm = Buffer.alloc(480000);
  for (let i = 0; i < pcm.length / 2; i++)
    pcm.writeInt16LE(
      Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / 24000)),
      i * 2,
    );
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "first-delivered-question",
    delta: pcm.toString("base64"),
  });
  if (generationChecks) {
    for (let n = 0; n < 4; n++) {
      f.advance(2500);
      recognitionTurn(f, "もしもし。", 10 + n * 3);
      expect(f.b.responses.get("first-delivered-question").suppressed).toBe(
        false,
      );
    }
  } else f.advance(10000);
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "first-delivered-question",
    delta: "iPhone Duo 256GB Night SkyのSIMフリーは予約なしで購入できますか。",
  });
  await f.b.onVoice({
    type: "response.done",
    response: { id: "first-delivered-question", status: "completed" },
  });
  return f;
}
function recognitionTurn(f: any, text: string, start: number) {
  f.b.turns.accept({ transcript: text, is_final: false, start });
  f.b.turns.accept({
    transcript: text,
    is_final: true,
    speech_final: true,
    start,
    duration: 0.5,
  });
}
it("preserves the first undelivered question through repeated checks during its fourth generation", async () => {
  const f = await firstDeliveredQuestionFixture(true);
  expect(f.b.context.initial_dialogue_response.id).toBe("cancelled-start-0");
  expect(f.b.context.deferred_audibility_checks).toBe(4);
  expect(f.b.context.output_audit).toMatchObject({
    released_responses: 1,
    released_pcm_bytes: 480000,
  });
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    500,
  );
});
async function undeliveredRecoveryFixture() {
  const f = await dialogueFixture();
  await f.b.onVoice({ type: "response.created", response: { id: "pickup" } });
  f.advance(1000);
  f.recipient("ご用件をお伺いします。");
  await f.b.onVoice({
    type: "response.done",
    response: { id: "pickup", status: "cancelled" },
  });
  return f;
}
it("bounds pre-delivery recovery to the original 30 seconds without renewing it on checks or generations", async () => {
  const f = await undeliveredRecoveryFixture();
  const first = { ...f.b.context.initial_dialogue_response };
  f.advance(24000);
  await f.b.onVoice({
    type: "response.created",
    response: { id: "late-first-question" },
  });
  f.advance(4000);
  recognitionTurn(f, "もしもし。", 29);
  expect(f.b.responses.get("late-first-question").suppressed).toBe(false);
  expect(f.b.deferInitialBackchannel("はい。")).toBe(false);
  expect(f.b.context.initial_dialogue_response).toEqual(first);
  f.advance(1000);
  recognitionTurn(f, "もしもし。", 30);
  expect(f.b.responses.get("late-first-question").suppressed).toBe(true);
  await f.b.onVoice({
    type: "response.created",
    response: { id: "after-deadline" },
  });
  recognitionTurn(f, "もしもし。", 31);
  expect(f.b.responses.get("after-deadline").suppressed).toBe(true);
  expect(f.b.context.initial_dialogue_response).toEqual(first);
});
it("does not extend the current generation timeout during pre-delivery recovery", async () => {
  const f = await undeliveredRecoveryFixture();
  await f.b.onVoice({
    type: "response.created",
    response: { id: "slow-first-question" },
  });
  f.advance(14999);
  recognitionTurn(f, "もしもし。", 15);
  expect(f.b.responses.get("slow-first-question").suppressed).toBe(false);
  f.advance(1);
  expect(f.b.deferInitialAudibilityCheck("もしもし。")).toBe(false);
  recognitionTurn(f, "もしもし。", 16);
  expect(f.b.responses.get("slow-first-question").suppressed).toBe(true);
});
it.each([
  "ちょっと待ってください。",
  "違います、予約を変更してください。",
  "もしもし、在庫はありません。",
])(
  "still cancels an undelivered recovery for a meaningful turn: %s",
  async (text) => {
    const f = await undeliveredRecoveryFixture();
    await f.b.onVoice({
      type: "response.created",
      response: { id: "recovering-question" },
    });
    f.advance(500);
    recognitionTurn(f, text, 2);
    expect(f.b.responses.get("recovering-question").suppressed).toBe(true);
    expect(f.b.context.deferred_audibility_checks ?? 0).toBe(0);
  },
);
it("lets the first delivered question finish after cancelled starts despite interim audibility checks", async () => {
  const f = await firstDeliveredQuestionFixture();
  const delivery = { ...f.b.context.initial_audio_delivery };
  expect(delivery.id).toBe("first-delivered-question");
  expect(delivery.deadline_at - delivery.started_at).toBe(10000);
  expect(f.b.context.initial_dialogue_response.id).toBe("cancelled-start-0");
  const before = f.media.frames.length;
  f.advance(250);
  recognitionTurn(f, "もしもし。", 30);
  f.advance(2500);
  recognitionTurn(f, "もしもし。", 33);
  expect(f.b.responses.get(delivery.id).suppressed).toBe(false);
  expect(f.b.context.deferred_audibility_checks).toBe(2);
  expect(f.b.context.initial_audio_delivery.deadline_at).toBe(
    delivery.deadline_at,
  );
  expect(
    f.media.frames.slice(before).some((m: any) => m.event === "clear"),
  ).toBe(false);
  const media = f.media.frames.filter((m: any) => m.event === "media");
  expect(media).toHaveLength(500);
  expect(
    media.reduce(
      (bytes: number, m: any) =>
        bytes + Buffer.from(m.media.payload, "base64").length,
      0,
    ),
  ).toBe(80000);
  const mark = f.media.frames.find((m: any) => m.event === "mark");
  f.advance(7250);
  await f.b.onMedia({ event: "mark", stream_id: "stream", mark: mark.mark });
  expect(f.b.marks.pending.size).toBe(0);
  expect(f.b.context.initial_audio_delivery.completed_at).toBe(
    delivery.deadline_at,
  );
  expect(f.b.deferInitialAudibilityCheck("もしもし。")).toBe(false);
  await f.generate("later-question", "次回の入荷予定は分かりますか。", 48000);
  f.advance(100);
  recognitionTurn(f, "もしもし。", 45);
  expect(f.b.responses.get("later-question").suppressed).toBe(true);
  expect(f.b.context.initial_audio_delivery.id).toBe(delivery.id);
});
it.each([
  "ちょっと待ってください。",
  "違います、予約を変更してください。",
  "もしもし、在庫はありません。",
  "やめてください。",
])(
  "still interrupts the first delivered question for a real recipient turn: %s",
  async (text) => {
    const f = await firstDeliveredQuestionFixture();
    const before = f.media.frames.length;
    f.advance(500);
    recognitionTurn(f, text, 30);
    expect(f.b.responses.get("first-delivered-question").suppressed).toBe(true);
    expect(f.b.context.initial_audio_delivery.cancelled).toBe(true);
    expect(f.b.context.deferred_audibility_checks ?? 0).toBe(0);
    expect(
      f.media.frames.slice(before).some((m: any) => m.event === "clear"),
    ).toBe(true);
    expect(f.b.deferInitialAudibilityCheck("もしもし。")).toBe(false);
  },
);
it("does not renew first-delivery protection when its playback mark is missing", async () => {
  const f = await firstDeliveredQuestionFixture();
  const deadline = f.b.context.initial_audio_delivery.deadline_at;
  f.advance(9000);
  recognitionTurn(f, "もしもし。", 40);
  expect(f.b.context.initial_audio_delivery.deadline_at).toBe(deadline);
  f.advance(1000);
  expect(f.b.marks.pending.size).toBe(1);
  expect(f.b.deferInitialAudibilityCheck("もしもし。")).toBe(false);
  recognitionTurn(f, "もしもし。", 42);
  expect(f.b.responses.get("first-delivered-question").suppressed).toBe(true);
  expect(f.b.context.initial_audio_delivery.cancelled).toBe(true);
});
it("ends first-question protection at playback completion even within the generation grace", async () => {
  const f = await dialogueFixture();
  await f.generate("direct-question", "予約なしで購入できますか。");
  f.advance(100);
  expect(f.b.deferInitialAudibilityCheck("もしもし。")).toBe(true);
  const mark = f.media.frames.find((m: any) => m.event === "mark");
  await f.b.onMedia({ event: "mark", stream_id: "stream", mark: mark.mark });
  expect(f.b.deferInitialAudibilityCheck("もしもし。")).toBe(false);
});
it("holds audio until the complete utterance is checked, then releases every frame once", async () => {
  const f = await dialogueFixture();
  await f.b.onVoice({ type: "response.created", response: { id: "bounded" } });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "bounded",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    0,
  );
  f.advance(500);
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "bounded",
    delta: "次回の入荷予定は分かりますか。",
  });
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    0,
  );
  await f.b.onVoice({
    type: "response.done",
    response: { id: "bounded", status: "completed" },
  });
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    10,
  );
  expect(f.media.frames.filter((m: any) => m.event === "mark")).toHaveLength(1);
  expect(f.b.controller.responseActive).toBe(false);
  await f.b.onVoice({ type: "response.created", response: { id: "bounded" } });
  await f.b.onVoice({
    type: "response.done",
    response: { id: "bounded", status: "completed" },
  });
  expect(f.b.controller.responseActive).toBe(false);
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    10,
  );
});
it("does not leak even a safe prefix before a late Call Summary or operational comment", async () => {
  for (const text of [
    "ありがとうございます。失礼いたします。【Call Summary v2】電話応答：営業時間外。",
    "（相手がまだ話しているため、こちらからは何も発言せず、案内が終わるのを待ちます。",
  ]) {
    const f = await dialogueFixture();
    await f.generate("blocked", text);
    expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
    expect(f.b.responses.get("blocked").guardRejected).toBe(true);
    expect(f.b.controller.responseActive).toBe(false);
    expect(
      f.network.some((n: any) => n.url === "https://api.telnyx.com/v2/calls"),
    ).toBe(false);
  }
});
it("rejects untranscribed audio and caps audio duration and unfinished generations", async () => {
  const f = await dialogueFixture();
  await f.generate("no-text", "");
  expect(f.b.responses.get("no-text").blockReason).toBe("missing_transcript");
  f.env.OUTBOUND_MAX_UTTERANCE_SECONDS = "3";
  await f.b.onVoice({ type: "response.created", response: { id: "long" } });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "long",
    delta: Buffer.alloc(8000 * 2 * 4).toString("base64"),
  });
  expect(f.b.responses.get("long").chunks).toEqual([]);
  expect(f.b.responses.get("long").blockReason).toBe("utterance_length_limit");
  await f.b.onVoice({ type: "response.created", response: { id: "stalled" } });
  f.advance(15001);
  await f.b.checkDialogue();
  expect(f.b.responses.get("stalled").blockReason).toBe("generation_timeout");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
});

const otaChairQuestion =
  "ガスシリンダー付きの椅子の脚だけでも、粗大ごみで出せますか。";
const otaOversizedPcmBytes = 645120;
async function otaDialogueFixture() {
  const f = await dialogueFixture(
    "ガスシリンダー付きのLiberNovoの椅子の脚部のみを粗大ごみとして出せるか、費用はいくらかを聞いてください。予約や支払いはしないでください。",
  );
  f.b.outputRate = 24000;
  f.b.context.answered_at = new Date(f.advance(0)).toISOString();
  recognitionTurn(
    f,
    "ご家庭から出る粗大ごみの収集の申し込みでよろしいですか？",
    1,
  );
  f.advance(1000);
  return f;
}

async function startOversizedReply(
  f: Awaited<ReturnType<typeof otaDialogueFixture>>,
  id: string,
) {
  await f.b.onVoice({ type: "response.created", response: { id } });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: id,
    delta: Buffer.alloc(otaOversizedPcmBytes).toString("base64"),
  });
}

async function finishOversizedReply(
  f: Awaited<ReturnType<typeof otaDialogueFixture>>,
  id: string,
  text = otaChairQuestion,
  { status = "completed", shape = "final" } = {},
) {
  if (text)
    await f.b.onVoice({
      type: "response.output_audio_transcript.delta",
      response_id: id,
      delta: text,
    });
  if (shape === "audio-done")
    await f.b.onVoice({ type: "response.output_audio.done", response_id: id });
  await f.b.onVoice({
    type: "response.done",
    response: {
      id,
      status,
      output:
        shape === "final"
          ? [{ content: [{ type: "audio", transcript: text }] }]
          : [],
    },
  });
  f.advance(1000);
  await f.b.checkDialogue();
}

it.each(["final", "audio-done"])(
  "recovers the Ōta enquiry with %s without replaying PCM or treating an audibility check as an answer",
  async (shape) => {
    const f = await otaDialogueFixture();
    const id = "oversized-chair-question";
    await startOversizedReply(f, id);
    expect(f.network.some((n: any) => n.url.endsWith("/speak"))).toBe(false);
    recognitionTurn(f, "お電話つながっております。お声届いておりますか?", 3);
    f.advance(700);
    await finishOversizedReply(f, id, otaChairQuestion, { shape });
    await f.b.systemActions;
    const recovered = f.network.filter(
      (n: any) =>
        n.url.endsWith("/speak") && n.body.payload === otaChairQuestion,
    );
    expect(recovered).toHaveLength(1);
    expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
    expect(f.b.context.latest_task_request?.playback_completed_at).toBeFalsy();
    const state = recovered[0].body.client_state;
    const decoded = JSON.parse(Buffer.from(state, "base64").toString());
    expect(decoded.phase).toBe("task_speech");
    await ackCompletion(
      f,
      Buffer.from(
        JSON.stringify({ ...decoded, token: crypto.randomUUID() }),
      ).toString("base64"),
    );
    expect(f.b.context.latest_task_request?.playback_completed_at).toBeFalsy();
    await expect(
      ackCompletion(f, state, "completed", "foreign-call"),
    ).rejects.toThrow("Call identity conflict");
    expect(f.b.context.latest_task_request?.playback_completed_at).toBeFalsy();
    await ackCompletion(f, state);
    expect(f.b.context.latest_task_request?.playback_completed_at).toBeTruthy();
    recognitionTurn(f, "聞こえますでしょうか?", 7);
    expect(f.b.context.latest_task_request?.recipient_answer_at).toBeFalsy();
    recognitionTurn(f, "はい、そのまま粗大ごみに出せます。", 8);
    expect(f.b.context.latest_task_request?.recipient_answer_at).toBeTruthy();
    f.advance(1000);
    await f.b.checkDialogue();
    expect(
      f.network.filter(
        (n: any) =>
          n.url.endsWith("/speak") && n.body.payload === otaChairQuestion,
      ),
    ).toHaveLength(1);
  },
);

it.each([
  { label: "a missing transcript", text: "", turn: null },
  {
    label: "only transcript deltas",
    text: otaChairQuestion,
    turn: null,
    noFinal: true,
  },
  {
    label: "an unfinished question",
    text: "ガスシリンダー付きの椅子の脚だけ",
    turn: null,
  },
  {
    label: "private output",
    text: "Call Summary: unable_to_proceed。" + otaChairQuestion,
    turn: null,
  },
  {
    label: "multiple sentences",
    text: "お問い合わせです。" + otaChairQuestion,
    turn: null,
  },
  {
    label: "a cancelled response",
    text: otaChairQuestion,
    turn: null,
    status: "cancelled",
  },
  {
    label: "an explicit hold",
    text: otaChairQuestion,
    turn: "確認しますので、少々お待ちください。",
  },
  {
    label: "a changed recipient question",
    text: otaChairQuestion,
    turn: "いいえ、何をお出しになりますか？",
  },
])(
  "does not recover oversized audio for $label",
  async ({ text, turn, status, noFinal }) => {
    const f = await otaDialogueFixture();
    const id = "recoverable-looking-chair-question";
    await startOversizedReply(f, id);
    if (turn) recognitionTurn(f, turn, 3);
    await finishOversizedReply(f, id, text, {
      status,
      shape: noFinal ? "delta" : "final",
    });
    await f.b.systemActions;
    expect(f.network.some((n: any) => n.url.endsWith("/speak"))).toBe(false);
    expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
    expect(f.b.context.latest_task_request?.playback_completed_at).toBeFalsy();
  },
);

it("cancels dispatched recovered speech for a real hold, and ignores its late completion", async () => {
  const f = await otaDialogueFixture();
  const id = "recovered-then-held";
  await startOversizedReply(f, id);
  await finishOversizedReply(f, id);
  await f.b.systemActions;
  const [speak] = f.network.filter((n: any) => n.url.endsWith("/speak"));
  expect(speak?.body.payload).toBe(otaChairQuestion);
  recognitionTurn(f, "確認しますので、少々お待ちください。", 3);
  await f.b.systemActions;
  await ackCompletion(f, speak.body.client_state);
  expect(f.b.controller.hold).toBeTruthy();
  expect(
    f.network.filter((n: any) => n.url.endsWith("/playback_stop")),
  ).toHaveLength(1);
  expect(f.b.context.latest_task_request).toMatchObject({
    interrupted: true,
    playback_completed_at: null,
  });
});

it("rechecks recipient speech after reserving recovered playback and before dispatch", async () => {
  const f = await otaDialogueFixture();
  const id = "recover-with-reservation-race";
  await startOversizedReply(f, id);
  const transact = f.storage.transaction.bind(f.storage);
  let release!: () => void;
  let notify!: () => void;
  const reserved = new Promise<void>((resolve) => (notify = resolve));
  const paused = new Promise<void>((resolve) => (release = resolve));
  f.storage.transaction = async (fn: any) => {
    const reservation = await transact(fn);
    notify();
    await paused;
    return reservation;
  };
  await finishOversizedReply(f, id);
  await reserved;
  recognitionTurn(f, "いいえ、何をお出しになりますか？", 3);
  release();
  await f.b.systemActions;
  expect(f.network.some((n: any) => n.url.endsWith("/speak"))).toBe(false);
  expect(f.b.context.latest_task_request?.playback_completed_at).toBeFalsy();
});

it("treats hai after a completed question as an answer even when its playback ACK is delayed", async () => {
  const f = await dialogueFixture();
  await f.generate("question", "予約は明日の18時でよろしいですか。");
  f.advance(1000);
  expect(f.b.marks.pending.size).toBe(1);
  f.recipient("はい。");
  expect(
    f.b.voice.frames.some(
      (m: any) =>
        m.item?.role === "user" && m.item.content[0].text === "はい。",
    ),
  ).toBe(true);
  expect(f.b.context.filtered_aizuchi ?? 0).toBe(0);
  expect(f.b.controller.assistantQuestionPending).toBe(false);
});
it("preserves a listening aizuchi during real playback but yields for a correction", async () => {
  const f = await dialogueFixture();
  await f.generate("answer", "明日は18時に空きがあります。", 8000 * 2 * 2);
  const before = f.media.frames.filter((m: any) => m.event === "clear").length;
  f.recipient("ええ。");
  expect(f.b.context.filtered_aizuchi).toBe(1);
  expect(f.media.frames.filter((m: any) => m.event === "clear")).toHaveLength(
    before,
  );
  f.recipient("すみません、18時ではなく19時です。");
  expect(f.media.frames.filter((m: any) => m.event === "clear")).toHaveLength(
    before + 1,
  );
});
it("waits silently for explicit stock checking and resumes on the real answer", async () => {
  const f = await dialogueFixture();
  f.recipient("在庫を確認いたします。");
  expect(f.b.controller.hold).not.toBeNull();
  const deadline = f.b.controller.hold.deadline;
  f.advance(30000);
  await f.b.checkDialogue();
  await f.generate("hold-comment", "少々お待ちください。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  expect(f.network.some((n: any) => n.url.endsWith("/speak"))).toBe(false);
  f.recipient("はい。");
  expect(f.b.controller.hold.deadline).toBe(deadline);
  f.advance(1000);
  f.recipient("お待たせしました。在庫はございません。");
  expect(f.b.controller.hold).toBeNull();
  await f.generate("follow-up", "次回の入荷日は分かりますか。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
});
it("closes after a closed-store announcement without a keypad action or spoken report", async () => {
  const f = await dialogueFixture();
  f.recipient(
    "ただ今の時間は営業しておりません。営業時間内におかけ直してください。",
  );
  f.advance(1600);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  const closing = f.b.context.controlled_closing;
  expect(closing).toBeTruthy();
  f.recipient(
    "ストアの営業時間やアクセスのご案内については一を押してください。",
  );
  const m = await f.b.controller.command(
    "read-after-close",
    "read_current_menu",
    {},
  );
  expect(m.reason).toBe("RECIPIENT_TERMINAL");
  await f.generate(
    "report",
    "ありがとうございます。失礼いたします。【Call Summary v2】",
  );
  expect(f.media.frames.some((x: any) => x.event === "media")).toBe(false);
  expect(f.network.some((n: any) => n.url.endsWith("/send_dtmf"))).toBe(false);
  expect(f.network.filter((n: any) => n.url.endsWith("/speak"))).toHaveLength(
    1,
  );
  expect(f.network.some((n: any) => n.url.endsWith("/hangup"))).toBe(false);
});
it("observes a long Apple menu with bounded client tools, then round-trips its exact token once", async () => {
  const f = await dialogueFixture();
  f.recipient("次の四つの中からご希望の番号を選択してください。");
  const reading = f.b.onVoice({
    type: "conversation.item.created",
    item: {
      type: "function_call",
      name: "read_current_menu",
      arguments: "{}",
      call_id: "apple-menu-read",
    },
  });
  f.advance(3500);
  await f.b.checkDialogue();
  await reading;
  const pendingOutput = f.b.voice.frames.find(
    (e: any) => e.item?.call_id === "apple-menu-read",
  );
  expect(JSON.parse(pendingOutput.item.output)).toMatchObject({
    ok: false,
    next_action: "read_current_menu",
    action_not_executed: true,
  });
  f.advance(12242);
  f.recipient(
    "営業時間や道順については一を Apple のテクニカルサポートセンター、 Apple ケアに転送するには二を法人のお客様は三を、その他のご質問は五を押してください。",
  );
  await f.b.onVoice({
    type: "conversation.item.created",
    item: {
      type: "function_call",
      name: "read_current_menu",
      arguments: "{}",
      call_id: "apple-complete-read",
    },
  });
  const output = f.b.voice.frames.find(
    (e: any) => e.item?.call_id === "apple-complete-read",
  );
  const snapshot = JSON.parse(output.item.output);
  expect(snapshot).toMatchObject({
    ok: true,
    advertised_digits: ["1", "2", "3", "5"],
  });
  expect(snapshot.menu_token).not.toBe("MENU_TOKEN");
  const select = {
    type: "conversation.item.created",
    item: {
      type: "function_call",
      name: "press_ivr_digit",
      arguments: JSON.stringify({
        digits: "5",
        menu_token: snapshot.menu_token,
      }),
      call_id: "apple-menu-select",
    },
  };
  const selecting = f.b.onVoice(select);
  expect(f.network.some((n: any) => n.url.endsWith("/send_dtmf"))).toBe(false);
  f.advance(800);
  await f.b.checkDialogue();
  await selecting;
  await f.b.onVoice(select);
  expect(
    f.network.filter((n: any) => n.url.endsWith("/send_dtmf")),
  ).toHaveLength(1);
  expect(f.b.context.ivr_progress.state).toBe("awaiting_transition");
  expect(
    [...f.storage.data.values()].filter(
      (v: any) => v?.event === "dtmf_accepted",
    ),
  ).toHaveLength(1);
  expect(f.media.frames.some((e: any) => e.event === "media")).toBe(false);
});
it("a real question before farewell dispatch cancels pending closure and permits a reply", async () => {
  const f = await dialogueFixture();
  f.b.controller.event({ type: "input_audio_buffer.speech_stopped" });
  await f.b.onVoice({
    type: "conversation.item.created",
    item: {
      type: "function_call",
      name: "finish_call_after_goodbye",
      arguments: '{"outcome":"unable_to_proceed"}',
      call_id: "premature-close",
    },
  });
  expect(f.b.context.controlled_close_requested).toBe(true);
  f.recipient("すみません、お名前を教えていただけますか。");
  expect(f.b.context.controlled_close_requested).toBe(false);
  expect(f.b.controller.pending).toBeNull();
  await f.generate("identity", "自動音声の電話アシスタントです。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
  expect(f.network.some((n: any) => n.url.endsWith("/hangup"))).toBe(false);
});
async function modelFinish(f: any, id: string, outcome = "confirmed") {
  await f.b.onVoice({
    type: "conversation.item.created",
    item: {
      type: "function_call",
      name: "finish_call_after_goodbye",
      arguments: JSON.stringify({ outcome }),
      call_id: id,
    },
  });
  const output = f.b.voice.frames.find((m: any) => m.item?.call_id === id);
  return JSON.parse(output.item.output);
}
async function playedResponse(f: any, id: string, duration = 200) {
  f.advance(duration);
  await f.b.onMedia({
    event: "mark",
    stream_id: "stream",
    mark: { name: f.b.marks.byResponse.get(id) },
  });
}
it("rejects the dentist's premature confirmed closure after a dropped date question and an unanswered played request", async () => {
  const f = await dialogueFixture();
  f.b.outputRate = 24000;
  f.recipient("はい、お電話歯科でございます。");
  await f.generate(
    "original-appointment",
    "今日11月13日16時の予約を、別の日に変更できますか。",
    418560,
  );
  await playedResponse(f, "original-appointment", 8720);
  f.advance(2000);
  f.b.activity.active = true;
  await f.generate(
    "unplayed-new-date",
    "明日11月14日で空いているお時間はございますか。",
    245760,
  );
  f.advance(2042);
  f.b.flushBufferedResponses();
  f.b.activity.active = false;
  expect(f.b.responses.get("unplayed-new-date").rendered).toBe(0);
  expect(
    (await modelFinish(f, "unplayed-finish")).latest_request_delivery,
  ).toBe("not_released");
  f.recipient("十六時ですね。");
  await f.generate(
    "unanswered-change",
    "その16時で予約を変更していただけますか。",
    180480,
  );
  await playedResponse(f, "unanswered-change", 3760);
  f.advance(10000);
  const result = await modelFinish(f, "dentist-premature-finish");
  expect(result).toMatchObject({
    ok: false,
    reason: "RECIPIENT_CONFIRMATION_NOT_OBSERVED_AFTER_PLAYBACK",
    latest_request_delivery: "played_without_substantive_answer",
    action_not_executed: true,
  });
  expect(f.b.context.controlled_close_requested).toBe(false);
  expect(f.b.controller.pending).toBeNull();
  expect(f.b.context.latest_task_request.recipient_answer_at).toBeNull();
  expect(f.network.some((n: any) => /\/(?:speak|hangup)$/.test(n.url))).toBe(
    false,
  );
});
it("never treats greetings, silence, audio without a transcript, or plain acknowledgements as task confirmation", async () => {
  const f = await dialogueFixture();
  f.recipient("はい、歯科でございます。");
  expect((await modelFinish(f, "greeting-only")).latest_request_delivery).toBe(
    "no_request_observed",
  );
  await f.generate("change", "11月14日16時に変更をお願いできますか。");
  await playedResponse(f, "change");
  recognitionTurn(f, "はい。", 1);
  recognitionTurn(f, "もしもし。", 2);
  recognitionTurn(f, "はい、ありがとうございます。", 2.5);
  recognitionTurn(f, "今日この16時が難しいですかね、いらっしゃるのが。", 3);
  f.b.turns.accept({ type: "TurnInfo", turn_index: 3, event: "StartOfTurn" });
  f.b.turns.accept({ type: "TurnInfo", turn_index: 3, event: "EndOfTurn" });
  f.advance(10000);
  expect(f.b.controller.assistantQuestionPending).toBe(false);
  expect((await modelFinish(f, "no-substantive-answer")).ok).toBe(false);
  expect(f.b.context.latest_task_request.recipient_answer_at).toBeNull();
  expect(f.network.some((n: any) => n.url.endsWith("/hangup"))).toBe(false);
});
it("does not accept an answer turn that started before playback completed, or a cleared playback mark", async () => {
  const f = await dialogueFixture();
  await f.generate("overlap", "11月14日16時に変更できますか。");
  f.b.beginTurn();
  await playedResponse(f, "overlap");
  f.b.deliverTranscript("はい、11月14日16時に変更しました。");
  expect((await modelFinish(f, "old-turn")).ok).toBe(false);
  await f.generate("interrupted", "11月14日16時に変更をお願いします。");
  const mark = f.b.marks.byResponse.get("interrupted");
  recognitionTurn(f, "すみません、もう一度お願いします。", 2);
  await f.b.onMedia({
    event: "mark",
    stream_id: "stream",
    mark: { name: mark },
  });
  expect(
    (await modelFinish(f, "interrupted-turn")).latest_request_delivery,
  ).toBe("interrupted");
});
it("accepts a substantive new answer after an imperative request played without promoting it to verified success", async () => {
  const f = await dialogueFixture();
  f.recipient("十六時ですね。");
  await f.generate(
    "change-imperative",
    "11月14日16時への予約変更をお願いします。",
  );
  expect(
    (await modelFinish(f, "before-playback")).latest_request_delivery,
  ).toBe("playback_pending");
  await playedResponse(f, "change-imperative");
  f.recipient("はい、11月14日16時に変更しました。");
  expect(await modelFinish(f, "answered-change")).toMatchObject({
    ok: true,
    effective_outcome: "unspecified",
    confirmation: "model_claim_not_independently_verified",
  });
  expect(f.b.context.latest_task_request.recipient_answer_at).toBeTruthy();
  expect(f.b.context.output_audit.recipient_reception_proven).toBe(false);
});
it("cannot bypass waiting for an unanswered imperative by retrying with a different model outcome", async () => {
  const f = await dialogueFixture();
  await f.generate(
    "change-imperative",
    "11月14日16時への予約変更をお願いします。",
  );
  await playedResponse(f, "change-imperative", 250);
  expect(f.b.controller.assistantQuestionPending).toBe(false);
  for (const outcome of [
    "confirmed",
    "unable_to_proceed",
    "refused",
    "wrong_number",
  ]) {
    expect(await modelFinish(f, "retry-" + outcome, outcome)).toMatchObject({
      ok: false,
      reason: "RECIPIENT_CONFIRMATION_NOT_OBSERVED_AFTER_PLAYBACK",
      latest_request_delivery: "played_without_substantive_answer",
      action_not_executed: true,
    });
    expect(f.b.controller.pending).toBeNull();
    expect(f.b.context.controlled_close_requested).toBe(false);
  }
  expect(f.b.context.latest_task_request.recipient_answer_at).toBeNull();
  expect(f.network.some((n: any) => /\/(?:speak|hangup)$/.test(n.url))).toBe(
    false,
  );
});
it("does not let an old answered request confirm a newer unplayed request", async () => {
  const f = await dialogueFixture();
  await f.generate("availability", "明日空いていますか。");
  await playedResponse(f, "availability");
  f.recipient("11月14日16時が空いています。");
  f.b.activity.active = true;
  await f.generate("unplayed-booking", "11月14日16時に変更をお願いします。");
  f.advance(2100);
  f.b.flushBufferedResponses();
  f.b.activity.active = false;
  expect((await modelFinish(f, "old-answer")).latest_request_delivery).toBe(
    "not_released",
  );
});
it("preserves refusal and wrong-number closure after an unanswered question", async () => {
  for (const text of [
    "予約は承れません。それでは失礼します。",
    "お電話番号が違います。",
  ]) {
    const f = await dialogueFixture();
    await f.generate("request", "11月14日16時に変更できますか。");
    await playedResponse(f, "request");
    f.recipient(text);
    expect((await modelFinish(f, "terminal")).ok).toBe(true);
    expect(f.b.controller.pending.outcome).not.toBe("confirmed");
  }
});
it("does not replace the latest request's playback evidence with a late older response", async () => {
  const f = await dialogueFixture();
  await f.b.onVoice({
    type: "response.created",
    response: { id: "old-draft" },
  });
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "old-draft",
    delta: "今日16時の予約ですか。",
  });
  await f.generate("current-request", "11月14日16時に変更をお願いします。");
  await playedResponse(f, "current-request");
  f.recipient("はい、11月14日16時に変更しました。");
  const request = structuredClone(f.b.context.latest_task_request);
  await f.b.onVoice({
    type: "response.done",
    response: { id: "old-draft", status: "completed" },
  });
  expect(f.b.context.latest_task_request).toEqual(request);
  expect((await modelFinish(f, "current-answer")).ok).toBe(true);
});
it("keeps bounded server silence cleanup working after rejected model confirmation", async () => {
  const f = await dialogueFixture();
  f.recipient("歯科でございます。");
  await f.generate("unanswered", "11月14日16時に変更できますか。");
  await playedResponse(f, "unanswered");
  expect((await modelFinish(f, "unanswered-finish")).ok).toBe(false);
  f.advance(20000);
  await f.b.checkDialogue();
  expect(f.b.context.attention).toBeTruthy();
  f.b.context.attention.completed = true;
  f.b.silence.checkCompleted();
  f.advance(15000);
  await f.b.checkDialogue();
  expect(f.b.controller.pending).toMatchObject({
    outcome: "unable_to_proceed",
    reason: "recipient_silence_timeout",
  });
  f.b.context.controlled_closing.completed = true;
  f.b.controller.event({ type: "system_farewell_completed" });
  f.advance(300);
  await f.b.checkDialogue();
  expect(f.network.filter((n: any) => n.url.endsWith("/hangup"))).toHaveLength(
    1,
  );
  expect(f.b.context.close_outcome).toBe("unable_to_proceed");
});
it("keeps an offered appointment time attached to the played date and blocks a different change before any audio leaves", async () => {
  const f = await dialogueFixture();
  await f.generate(
    "date-question",
    "11月14日土曜日の同じ16時に空きはありますか。",
  );
  await playedResponse(f, "date-question");
  f.recipient("16時でしたら空いております。");
  expect(f.b.context.appointment_offer).toEqual({
    month: 11,
    day: 14,
    hour: 16,
    minute: 0,
  });
  const before = f.media.frames.filter((m: any) => m.event === "media").length;
  await f.generate(
    "wrong-date",
    "11月15日16時に予約を変更していただけますか。",
  );
  expect(f.b.responses.get("wrong-date").rendered).toBe(0);
  expect(f.b.responses.get("wrong-date").blockReason).toBe(
    "APPOINTMENT_OFFER_MISMATCH",
  );
  expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
    before,
  );
  expect(f.b.voice.frames.some((m: any) => m.item?.role === "system")).toBe(
    false,
  );
  const feedback = f.b.unansweredConfirmation();
  expect(feedback.appointment_rejection.reason).toBe(
    "APPOINTMENT_OFFER_MISMATCH",
  );
  expect(feedback.appointment_rejection.offered_slot.day).toBe(14);
  await f.generate("wrong-date-please", "それでは11月15日16時でお願いします。");
  expect(f.b.responses.get("wrong-date-please").rendered).toBe(0);
  expect(f.b.context.latest_task_request.released_at).toBeNull();
  const rejectedFinish = await modelFinish(f, "wrong-date-cannot-finish");
  expect(rejectedFinish.ok).toBe(false);
  expect(rejectedFinish.appointment_rejection.offered_slot.day).toBe(14);
  await f.generate("correct-date", "11月14日16時への予約変更をお願いします。");
  expect(f.b.responses.get("correct-date").rendered).toBeGreaterThan(0);
  expect(f.b.context.output_audit.recipient_reception_proven).toBe(false);
});
it("does not inherit an offer's date from a generated question that never played", async () => {
  const f = await dialogueFixture();
  f.b.activity.active = true;
  await f.generate("unplayed-date", "11月14日16時に空きはありますか。");
  f.advance(2100);
  f.b.flushBufferedResponses();
  f.b.activity.active = false;
  f.recipient("16時でしたら空いております。");
  expect(f.b.context.appointment_offer).toBeUndefined();
  expect(f.b.context.appointment_played_question).toBeUndefined();
});
it("ignores an unplayed date when an older played date is the actual recipient context", async () => {
  const f = await dialogueFixture();
  await f.generate("heard-date", "12月20日16時に空きはありますか。");
  await playedResponse(f, "heard-date");
  f.b.activity.active = true;
  await f.generate("unheard-date", "12月21日16時に空きはありますか。");
  f.advance(2100);
  f.b.flushBufferedResponses();
  f.b.activity.active = false;
  f.recipient("16時でしたら空いております。");
  expect(f.b.context.appointment_offer).toEqual({
    month: 12,
    day: 20,
    hour: 16,
    minute: 0,
  });
  await f.generate(
    "wrong-inferred-date",
    "12月21日16時への予約変更をお願いします。",
  );
  expect(f.b.responses.get("wrong-inferred-date").rendered).toBe(0);
});
it("accepts a fully stated new recipient offer and allows asking availability of another date", async () => {
  const f = await dialogueFixture();
  await f.generate("initial-date", "11月14日16時に空きはありますか。");
  await playedResponse(f, "initial-date");
  f.recipient("11月15日9時30分でしたら空いております。");
  expect(f.b.context.appointment_offer).toEqual({
    month: 11,
    day: 15,
    hour: 9,
    minute: 30,
  });
  await f.generate("check-another-date", "11月16日16時に空きはありますか。");
  expect(f.b.responses.get("check-another-date").rendered).toBeGreaterThan(0);
  await playedResponse(f, "check-another-date");
  f.recipient("11月15日9時30分でしたら空いております。");
  await f.generate(
    "accept-explicit-offer",
    "11月15日9時30分に予約を変更していただけますか。",
  );
  expect(f.b.responses.get("accept-explicit-offer").rendered).toBeGreaterThan(
    0,
  );
});
it("requires playback before inheriting an omitted offer date and does not convert an echo or question into an offer", async () => {
  const f = await dialogueFixture();
  await f.generate("pending-playback", "11月14日16時に空きはありますか。");
  f.recipient("16時でしたら空いております。");
  expect(f.b.context.appointment_offer).toBeUndefined();
  await playedResponse(f, "pending-playback");
  f.recipient("十六時ですね。");
  f.recipient("今日この16時が難しいですかね、いらっしゃるのが。");
  expect(f.b.context.appointment_offer).toBeUndefined();
});
it("parses explicit Japanese slots conservatively without mistaking the old appointment for the new target", () => {
  const offered = { month: 11, day: 14, hour: 16, minute: 0 };
  expect(
    recipientAppointmentOffer("十一月十四日午後四時でしたら空いております。"),
  ).toEqual(offered);
  expect(
    playedAppointmentQuestion("１１月１４日１６時に空きはありますか。"),
  ).toEqual(offered);
  expect(recipientAppointmentOffer("16時ですね。", offered)).toBeNull();
  expect(
    recipientAppointmentOffer("16時は空いていません。", offered),
  ).toBeNull();
  expect(
    recipientAppointmentOffer("16時は空いていますか。", offered),
  ).toBeNull();
  expect(
    appointmentMismatch(
      "11月14日土曜日16時に、現在の11月13日16時の予約を変更してもよろしいでしょうか。",
      offered,
    ),
  ).toBeNull();
  expect(
    appointmentMismatch(
      "現在の11月13日16時の予約を、11月14日16時に変更していただけますか。",
      offered,
    ),
  ).toBeNull();
  expect(
    appointmentMismatch(
      "11月14日16時半に予約を変更していただけますか。",
      offered,
    )?.reason,
  ).toBe("APPOINTMENT_OFFER_MISMATCH");
  expect(
    appointmentMismatch("その16時に予約を変更していただけますか。", offered)
      ?.reason,
  ).toBe("APPOINTMENT_OFFER_MISMATCH");
  expect(
    appointmentMismatch(
      "11月14日16時または11月15日16時に変更をお願いします。",
      offered,
    )?.reason,
  ).toBe("APPOINTMENT_OFFER_MISMATCH");
  expect(
    appointmentMismatch("11月15日16時に空きはありますか。", offered),
  ).toBeNull();
  expect(
    appointmentMismatch(
      "空いている11月15日16時に予約を変更してください。",
      offered,
    )?.reason,
  ).toBe("APPOINTMENT_OFFER_MISMATCH");
  expect(
    appointmentMismatch("それでは11月15日16時でお願いします。", offered)
      ?.reason,
  ).toBe("APPOINTMENT_OFFER_MISMATCH");
  expect(
    appointmentMismatch("iPhoneは予約なしで購入できますか。", offered),
  ).toBeNull();
});
it("uses actual STT interim replay evidence to release one queued DTMF while keeping model audio silent", async () => {
  const f = await dialogueFixture();
  const intro = "次の四つの中からご希望の番号を選択してください。";
  f.recipient(
    intro +
      "営業時間は一を、サポートは二を、法人は三を、その他のご質問は五を押してください。",
  );
  const snapshot = await f.b.controller.command(
    "read-known-replay",
    "read_current_menu",
    {},
  );
  f.b.turns.accept({
    type: "TurnInfo",
    turn_index: 0,
    event: "StartOfTurn",
    transcript: "",
  });
  const selecting = f.b.onVoice({
    type: "conversation.item.created",
    item: {
      type: "function_call",
      name: "press_ivr_digit",
      arguments: JSON.stringify({
        digits: "5",
        menu_token: snapshot.menu_token,
      }),
      call_id: "select-known-replay",
    },
  });
  expect(f.network.some((n: any) => n.url.endsWith("/send_dtmf"))).toBe(false);
  f.b.turns.accept({
    type: "TurnInfo",
    turn_index: 0,
    event: "Update",
    transcript: intro,
  });
  await f.b.checkDialogue();
  await selecting;
  expect(
    f.network.filter((n: any) => n.url.endsWith("/send_dtmf")),
  ).toHaveLength(1);
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  expect(f.b.context.ivr_progress.state).toBe("awaiting_transition");
});
it("keeps post-DTMF audio silent and a routing hold bounded through continuous music, then resumes for a real greeting", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = {
    state: "awaiting_transition",
    command_id: "routing-test",
    accepted_at: Date.now(),
    deadline: Date.now() + 45000,
    baseline: "その他のご質問は五を押してください。",
  };
  await f.generate("premature-question", "在庫はありますか。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  f.b.turns.accept({
    type: "TurnInfo",
    turn_index: 0,
    event: "StartOfTurn",
    transcript: "",
  });
  f.b.turns.accept({
    type: "TurnInfo",
    turn_index: 0,
    event: "Update",
    transcript: "お電話を転送しております。",
  });
  expect(f.b.context.ivr_progress.state).toBe("routing_candidate");
  const lease = { ...f.b.controller.hold };
  f.advance(46000);
  await f.b.checkIvrDeadline();
  expect(f.b.failing).not.toBe(true);
  f.b.turns.accept({
    type: "TurnInfo",
    turn_index: 0,
    event: "EndOfTurn",
    transcript:
      "お電話を転送しております。 हमारी यात्रा उसमें मतलब प्रकार से खेलते हैं.",
  });
  await Promise.resolve();
  expect(f.b.context.ivr_progress.state).toBe("transition_observed");
  expect(f.b.controller.hold.deadline).toBe(lease.deadline);
  f.recipient("हमारी यात्रा उसमें मतलब प्रकार से खेलते हैं.");
  expect(f.b.controller.hold.deadline).toBe(lease.deadline);
  await f.generate("music-question", "次回の入荷日は分かりますか。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  f.recipient("お待たせいたしました。担当のテストです。ご用件をお伺いします。");
  expect(f.b.controller.hold).toBeNull();
  expect(f.b.context.ivr_progress.state).toBe("dialogue_candidate");
  await f.generate("actual-question", "予約なしで購入できますか。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
});
it("releases the routing hold for the recorded Japanese question instead of remaining silent until remote hangup", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = {
    state: "awaiting_transition",
    command_id: "operator-question",
    baseline: "その他のご質問は五を押してください。",
  };
  f.b.observeRoutingInterim("お電話を転送しております。");
  expect(f.b.controller.hold).not.toBeNull();
  f.b.turns.accept({
    type: "transcript",
    transcript: "ございますでしょうか?",
    confidence: 0.99,
    is_final: true,
    speech_final: true,
  });
  expect(f.b.controller.hold).toBeNull();
  expect(f.b.context.ivr_progress.state).toBe("dialogue_candidate");
  await f.generate("operator-response", "もしもし。予約なしで購入できますか。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
});
it("resumes at the first real greeting even when STT bundles it after the recorded transfer announcement", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = {
    state: "awaiting_transition",
    command_id: "mixed-handoff",
    baseline: "その他のご質問は五を押してください。",
  };
  f.b.observeRoutingInterim("お電話を転送しております。");
  f.recipient("次の四つの中がお電話を転送しております。もしもし");
  expect(f.b.controller.hold).toBeNull();
  expect(f.b.context.ivr_progress.state).toBe("dialogue_candidate");
  await f.generate("first-hello", "はい、もしもし。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
});
it("never treats a conditional menu label as a routing hold, and repeated transfer observations do not renew the lease", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = {
    state: "awaiting_transition",
    command_id: "routing-test",
    accepted_at: Date.now(),
    deadline: Date.now() + 45000,
    baseline: "サポートへの転送は二を押してください。",
  };
  f.b.observeRoutingInterim("Appleケアに転送するには二を押してください。");
  expect(f.b.context.ivr_progress.state).toBe("awaiting_transition");
  expect(f.b.controller.hold).toBeNull();
  f.b.observeRoutingInterim("担当者におつなぎしております。");
  const lease = { ...f.b.controller.hold };
  f.advance(170000);
  f.b.observeRoutingInterim("お電話を転送しております。");
  expect(f.b.controller.hold.deadline).toBe(lease.deadline);
  f.advance(10001);
  await f.b.checkDialogue();
  expect(f.b.controller.holdExpired).toBe(true);
  expect(f.b.controller.pending?.outcome).toBe("unable_to_proceed");
  expect(f.b.context.ivr_progress.state).not.toBe("dialogue_candidate");
});
it("keeps a bare welcome on routing hold until an interactive staff return", async () => {
  const f = await dialogueFixture();
  f.b.context.ivr_progress = {
    state: "awaiting_transition",
    command_id: "staff-greeting",
    baseline: "その他のご質問は五を押してください。",
  };
  f.b.observeRoutingInterim("お電話を転送しております。");
  f.recipient(
    "お電話を転送しております。お電話ありがとうございます。アップル川崎です。",
  );
  expect(f.b.controller.hold).not.toBeNull();
  f.recipient("もしもし。ご用件をお伺いします。");
  expect(f.b.controller.hold).toBeNull();
  expect(f.b.context.ivr_progress.state).toBe("dialogue_candidate");
  await f.generate("answer-staff", "在庫について伺いたいのですが。");
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
});
it("validates the operator wait limit before creating any dial contract", async () => {
  const f = fixture();
  expect(f.b.routingHoldLimit()).toBe(180000);
  for (const invalid of ["0", "180001", "NaN"]) {
    f.env.OUTBOUND_ROUTING_HOLD_MS = invalid;
    await expect(f.register()).rejects.toThrow(
      "Unsupported routing hold limit",
    );
  }
  expect(f.network).toEqual([]);
});
it("a text-only goodbye never bypasses the system-controlled farewell", async () => {
  const f = await dialogueFixture();
  f.recipient("ありがとうございました。失礼します。");
  f.advance(1000);
  await f.generate("goodbye", "ありがとうございます。失礼いたします。", 0);
  await f.b.checkDialogue();
  expect(f.network.filter((n: any) => n.url.endsWith("/speak"))).toHaveLength(
    1,
  );
  expect(f.network.some((n: any) => n.url.endsWith("/hangup"))).toBe(false);
});
it("survives an empty STT end during a controlled farewell and still requires its matching completed callback", async () => {
  const f = await dialogueFixture();
  f.recipient("本日は営業しておりません。");
  f.advance(2000);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  const state = f.b.context.controlled_closing.state;
  f.b.turns.accept({
    type: "TurnInfo",
    request_id: "recognizer",
    turn_index: 1,
    event: "StartOfTurn",
  });
  f.b.turns.accept({
    type: "TurnInfo",
    request_id: "recognizer",
    turn_index: 1,
    event: "EndOfTurn",
    transcript: "",
  });
  const event = {
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date().toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: "bound-call",
      client_state: state,
      status: "completed",
    },
  };
  await f.b.onWebhook(event);
  f.advance(2000);
  await f.b.checkDialogue();
  expect(f.network.filter((n: any) => n.url.endsWith("/hangup"))).toHaveLength(
    1,
  );
});
it("checks initial carrier silence once and hangs up only after a completed check and farewell", async () => {
  const f = await dialogueFixture();
  f.b.lastMediaAt = Date.now();
  f.advance(25001);
  f.b.lastMediaAt = f.b.now();
  await f.b.checkDialogue();
  const attention = f.b.context.attention;
  expect(attention).toBeTruthy();
  const event = (state: string) => ({
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date().toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: "bound-call",
      client_state: state,
      status: "completed",
    },
  });
  await f.b.onWebhook(event(attention.state));
  f.advance(15001);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  expect(f.network.filter((n: any) => n.url.endsWith("/speak"))).toHaveLength(
    2,
  );
  const farewell = f.b.context.controlled_closing;
  expect(farewell).toBeTruthy();
  expect(f.network.some((n: any) => n.url.endsWith("/hangup"))).toBe(false);
  await f.b.onWebhook(event(farewell.state));
  f.advance(1000);
  await f.b.checkDialogue();
  expect(f.network.filter((n: any) => n.url.endsWith("/hangup"))).toHaveLength(
    1,
  );
});
it("does not arm an attention timeout after the signed completion arrived during dispatch", async () => {
  vi.useFakeTimers();
  const f = await dialogueFixture();
  let resolve: any, started: any;
  const dispatched = new Promise((r) => (started = r));
  f.b.voiceAPI = () => {
    started();
    return new Promise((r) => (resolve = r));
  };
  const work = f.b.playAttention();
  await dispatched;
  const attention = f.b.context.attention;
  attention.completed = true;
  f.b.silence.checkCompleted();
  resolve({ ok: true });
  await work;
  expect(f.b.attentionDeadline).toBeUndefined();
  await vi.advanceTimersByTimeAsync(21000);
  expect(f.b.context.failure).toBeUndefined();
});
it("preserves the original approved task while applying the trusted spoken policy to the supported session variable", async () => {
  const f = fixture();
  await f.register();
  await f.b.openVoice();
  const update = f.b.voice.frames.find((m: any) => m.type === "session.update");
  expect(update.session.assistant.dynamic_variables.outbound_task).toContain(
    "AUTHORIZED_TASK_JSON=" +
      JSON.stringify({ authorized_task: f.row.instructions }),
  );
  expect(f.b.context.instructions).toBe(f.row.instructions);
  expect(update.session.assistant.dynamic_variables.outbound_task).toContain(
    "NEVER speak a report",
  );
});
it("does not speak a farewell cancelled while its persistence is still pending", async () => {
  const f = await dialogueFixture();
  const original = f.b.persist.bind(f.b);
  let release: any,
    first = true;
  f.b.persist = async () => {
    if (first) {
      first = false;
      await new Promise((r) => (release = r));
    } else await original();
  };
  const play = f.b.playControlledFarewell("confirmed", {
    operationId: "race-before-post",
  });
  await Promise.resolve();
  await f.b.cancelControlledFarewell();
  release();
  await play;
  expect(f.b.context.controlled_closing.cancelled).toBe(true);
  expect(f.network.some((n: any) => n.url.endsWith("/speak"))).toBe(false);
});
it("an early answer to the presence check is forwarded and prevents a stale timeout after dispatch", async () => {
  const f = await dialogueFixture();
  let release: any, started: any;
  const dispatched = new Promise((r) => (started = r));
  const actions: string[] = [];
  f.b.voiceAPI = async (action: string) => {
    actions.push(action);
    if (action === "speak") started();
    return action === "speak"
      ? new Promise((r) => (release = r))
      : { ok: true };
  };
  const play = f.b.playAttention();
  await dispatched;
  f.recipient("はい、聞こえています。");
  release({ ok: true });
  await play;
  await Promise.resolve();
  expect(f.b.context.attention.cancelled).toBe(true);
  expect(f.b.attentionDeadline).toBeUndefined();
  expect(
    f.b.voice.frames.some(
      (m: any) =>
        m.item?.role === "user" &&
        m.item.content[0].text === "はい、聞こえています。",
    ),
  ).toBe(true);
  expect(actions.filter((x) => x === "speak")).toHaveLength(1);
});
it("does not certify task success or call a keypad action from a silent hold timeout", async () => {
  const f = await dialogueFixture();
  f.recipient("少々お待ちください。");
  const deadline = f.b.controller.hold.deadline;
  f.advance(90001);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  expect(f.b.controller.holdExpired).toBe(true);
  expect(f.b.controller.pending.outcome).toBe("unable_to_proceed");
  expect(f.b.context.controlled_closing.outcome).toBe("unable_to_proceed");
  f.recipient("そのままお待ちください。");
  f.advance(1600);
  await f.b.checkDialogue();
  expect(f.b.controller.hold).toBeNull();
  expect(f.b.controller.holdExpiry.deadline).toBe(deadline);
  expect(f.network.some((n: any) => n.url.endsWith("/send_dtmf"))).toBe(false);
  expect(f.network.filter((n: any) => n.url.endsWith("/speak"))).toHaveLength(
    1,
  );
});
it("does not retain oversized or late text chunks after rejecting a response", async () => {
  const f = await dialogueFixture();
  await f.b.onVoice({ type: "response.created", response: { id: "text-cap" } });
  await f.b.onVoice({
    type: "response.output_audio_transcript.delta",
    response_id: "text-cap",
    delta: "検証".repeat(3000),
  });
  for (let i = 0; i < 5; i++)
    await f.b.onVoice({
      type: "response.output_audio_transcript.delta",
      response_id: "text-cap",
      delta: "late".repeat(2000),
    });
  expect(f.b.responses.get("text-cap").text.length).toBeLessThanOrEqual(3000);
  expect(f.b.spokenBlocks).toBe(1);
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
});
it("serializes an old farewell stop before a new farewell generation", async () => {
  const f = await dialogueFixture();
  let release: any, started: any;
  const dispatched = new Promise((r) => (started = r));
  const actions: string[] = [];
  let first = true;
  f.b.voiceAPI = async (action: string) => {
    actions.push(action);
    if (action === "speak" && first) {
      first = false;
      started();
      return new Promise((r) => (release = r));
    }
    return { ok: true };
  };
  const old = f.b.playControlledFarewell("unable_to_proceed", {
    operationId: "closing-reason",
  });
  await dispatched;
  const cancel = f.b.cancelControlledFarewell();
  const next = f.b.playControlledFarewell("unable_to_proceed", {
    operationId: "closing-reason",
  });
  release({ ok: true });
  await Promise.all([old, cancel, next]);
  expect(actions).toEqual(["speak", "playback_stop", "speak"]);
  expect(f.b.context.farewell_generation).toBe(2);
  expect(f.b.context.controlled_closing.cancelled).toBe(false);
});
it("bounds a missing controlled-farewell callback without arming a timer after an early completed callback", async () => {
  vi.useFakeTimers();
  const f = await dialogueFixture();
  let release: any, started: any;
  const dispatched = new Promise((r) => (started = r));
  f.b.voiceAPI = async (action: string) => {
    if (action === "speak") {
      started();
      return new Promise((r) => (release = r));
    }
    return { ok: true };
  };
  const play = f.b.playControlledFarewell("confirmed", {
    operationId: "early-completion",
  });
  await dispatched;
  f.b.context.controlled_closing.completed = true;
  f.b.context.system_farewell_played = true;
  release({ ok: true });
  await play;
  expect(f.b.controlledFarewellDeadline).toBeUndefined();
  f.b.context.system_farewell_played = false;
  f.b.voiceAPI = async () => ({ ok: true });
  let failure: string | undefined;
  f.b.fail = async (reason: string) => {
    failure = reason;
  };
  await f.b.playControlledFarewell("confirmed", {
    operationId: "missing-callback",
  });
  await vi.advanceTimersByTimeAsync(20001);
  expect(failure).toBe("farewell_playback_unconfirmed");
});

it("preserves a listening aizuchi during later playback after a presence check has already completed", async () => {
  const f = await dialogueFixture();
  f.b.context.attention = {
    state: "completed-attention",
    cancelled: false,
    completed: true,
  };
  await f.generate(
    "answer-after-check",
    "明日は18時に空きがあります。",
    8000 * 2 * 2,
  );
  const clears = f.media.frames.filter((m: any) => m.event === "clear").length;
  const userItems = f.b.voice.frames.filter(
    (m: any) => m.item?.role === "user",
  ).length;
  f.recipient("はい。");
  expect(f.b.context.filtered_aizuchi).toBe(1);
  expect(f.media.frames.filter((m: any) => m.event === "clear")).toHaveLength(
    clears,
  );
  expect(
    f.b.voice.frames.filter((m: any) => m.item?.role === "user"),
  ).toHaveLength(userItems);
  expect(f.b.responses.get("answer-after-check").suppressed).toBe(false);
});

it("does not cancel or renew an expired silent hold farewell for music/filler recognition events", async () => {
  const f = await dialogueFixture();
  f.recipient("少々お待ちください。");
  const deadline = f.b.controller.hold.deadline;
  f.advance(90001);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  const closing = f.b.context.controlled_closing;
  expect(closing).toBeTruthy();
  const userItems = f.b.voice.frames.filter(
    (m: any) => m.item?.role === "user",
  ).length;
  for (const text of ["[Music]", "保留音", "[Long silence]"]) {
    f.recipient(text);
    f.advance(800);
    await f.b.checkDialogue();
    expect(f.b.controller.hold).toBeNull();
    expect(f.b.controller.holdExpired).toBe(true);
    expect(f.b.controller.holdExpiry.deadline).toBe(deadline);
    expect(f.b.context.controlled_closing).toBe(closing);
    expect(closing.cancelled).toBe(false);
  }
  expect(f.network.filter((n: any) => n.url.endsWith("/speak"))).toHaveLength(
    1,
  );
  expect(f.network.some((n: any) => n.url.endsWith("/playback_stop"))).toBe(
    false,
  );
  expect(
    f.b.voice.frames.filter((m: any) => m.item?.role === "user"),
  ).toHaveLength(userItems);
});

it("keeps an ongoing wait apology silent through interim/final STT but hears the distinct genuine return", async () => {
  const f = await dialogueFixture();
  f.recipient("少々お待ちください。");
  f.advance(90001);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  const closing = f.b.context.controlled_closing;
  const userItems = f.b.voice.frames.filter(
    (m: any) => m.item?.role === "user",
  ).length;
  f.b.turns.accept({ type: "TurnInfo", event: "StartOfTurn", turn_index: 81 });
  f.b.turns.accept({
    type: "TurnInfo",
    event: "Update",
    turn_index: 81,
    transcript: "お待たせしてすみません。",
  });
  expect(f.b.cancelledForTurn).toBe(false);
  expect(closing.cancelled).toBe(false);
  f.b.turns.accept({
    type: "TurnInfo",
    event: "EndOfTurn",
    turn_index: 81,
    transcript: "お待たせしてすみません。",
  });
  expect(f.b.cancelledForTurn).toBe(false);
  expect(closing.cancelled).toBe(false);
  expect(f.b.controller.holdExpired).toBe(true);
  expect(
    f.b.voice.frames.filter((m: any) => m.item?.role === "user"),
  ).toHaveLength(userItems);
  f.recipient("お待たせしました。すみません。");
  expect(f.b.controller.holdExpired).toBe(false);
  expect(closing.cancelled).toBe(true);
  expect(
    f.b.voice.frames.filter((m: any) => m.item?.role === "user"),
  ).toHaveLength(userItems + 1);
  expect(f.b.controller.pending).toBeNull();
  await f.generate(
    "real-return-answer",
    "ご確認ありがとうございます。予約なしで購入できますか。",
  );
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(true);
  expect(f.network.some((n: any) => n.url.endsWith("/hangup"))).toBe(false);
});

async function initialAckFixture() {
  const f = await dialogueFixture();
  f.env.OUTBOUND_INITIAL_ACK = "true";
  f.b.context.dialogue_candidate_observed = null;
  f.b.context.answered_at = new Date(f.advance(0)).toISOString();
  return f;
}
function ackCompletion(
  f: any,
  state = f.b.context.initial_ack.state,
  status = "completed",
  callControlId = "bound-call",
) {
  return f.b.onWebhook({
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date(f.advance(0)).toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: callControlId,
      client_state: state,
      status,
    },
  });
}
it.each([
  "お電話ありがとうございます、すらる手です。",
  "おやっとうございます、らるてです。",
  "もしもし、ご用件をお伺いします。",
])(
  "acknowledges direct pickup once without waiting for the generated booking request: %s",
  async (greeting) => {
    const f = await initialAckFixture();
    // The pre-answer long-silence greeting must not consume the audible greeting.
    await f.generate("prewarm", "はい、よろしくお願いします。");
    f.recipient(greeting);
    f.advance(400);
    await f.b.checkDialogue();
    const speaks = () => f.network.filter((n: any) => n.url.endsWith("/speak"));
    expect(speaks()).toHaveLength(1);
    expect(speaks()[0].body.payload).toBe("はい、よろしくお願いします。");
    expect(
      f.b.context.initial_ack.requested_at -
        f.b.context.dialogue_candidate_observed.at,
    ).toBe(400);
    // Task audio is still validated as a whole and never overlaps the fixed ack.
    await f.generate("task", "予約をお願いできますか。");
    expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
      0,
    );
    f.advance(3000);
    await f.b.checkDialogue();
    expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
      0,
    );
    await ackCompletion(f);
    expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
      10,
    );
    await ackCompletion(f);
    await f.b.checkDialogue();
    expect(speaks()).toHaveLength(1);
    expect(f.media.frames.filter((m: any) => m.event === "media")).toHaveLength(
      10,
    );
  },
);
it.each([
  "AppleStore銀座にお電話いただきありがとうございます。",
  "その他のご質問は五を押してください。",
  "ただいまお電話を転送しております。",
  "確認しますので少々お待ちください。",
  "本日の営業は終了しました。",
])(
  "never plays the initial acknowledgement to recorded welcome, IVR, hold or terminal speech: %s",
  async (text) => {
    const f = await initialAckFixture();
    f.recipient(text);
    f.advance(400);
    await f.b.checkDialogue();
    expect(f.b.context.initial_ack).toBeUndefined();
    expect(
      f.network
        .filter((n: any) => n.url.endsWith("/speak"))
        .some((n: any) => n.body.payload === "はい、よろしくお願いします。"),
    ).toBe(false);
  },
);
it("retains the acoustic guard and rejects premature or unauthenticated acknowledgement completion", async () => {
  const f = await initialAckFixture();
  f.recipient("もしもし、ご用件をお伺いします。");
  f.b.activity = { active: true };
  await f.b.checkDialogue();
  expect(f.b.context.initial_ack).toBeUndefined();
  f.advance(400);
  f.b.activity.active = false;
  await f.b.checkDialogue();
  const state = JSON.parse(
    Buffer.from(f.b.context.initial_ack.state, "base64").toString(),
  );
  const foreign = Buffer.from(
    JSON.stringify({ ...state, nonce: crypto.randomUUID() }),
  ).toString("base64");
  expect((await ackCompletion(f, foreign)).status).toBe(403);
  await ackCompletion(
    f,
    Buffer.from(
      JSON.stringify({ ...state, token: crypto.randomUUID() }),
    ).toString("base64"),
  );
  await ackCompletion(f, undefined, "failed");
  expect(f.b.context.initial_ack.completed_at).toBeNull();
  expect(f.b.initialAckPending()).toBe(true);
});
it("cancels an initial acknowledgement for a real correction, never replays it, and discards stale task audio", async () => {
  const f = await initialAckFixture();
  f.recipient("もしもし、ご用件をお伺いします。");
  f.advance(400);
  await f.b.checkDialogue();
  await f.generate("pending-task", "予約をお願いできますか。");
  f.recipient("違います。少々お待ちください。");
  await f.b.checkDialogue();
  expect(f.b.context.initial_ack.cancelled).toBe(true);
  await ackCompletion(f);
  expect(f.b.context.initial_ack.completed_at).toBeNull();
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  f.recipient("お待たせしました。");
  f.advance(400);
  await f.b.checkDialogue();
  expect(
    f.network.filter(
      (n: any) =>
        n.url.endsWith("/speak") &&
        n.body.payload === "はい、よろしくお願いします。",
    ),
  ).toHaveLength(1);
});
it("does not duplicate a model acknowledgement and never releases unchecked or incomplete booking audio", async () => {
  const f = await initialAckFixture();
  f.recipient("もしもし、ご用件をお伺いします。");
  f.advance(400);
  await f.b.checkDialogue();
  await f.generate("duplicate-ack", "はい、よろしくお願いします。");
  await ackCompletion(f);
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  await f.b.onVoice({
    type: "response.created",
    response: { id: "unfinished" },
  });
  await f.b.onVoice({
    type: "response.output_audio.delta",
    response_id: "unfinished",
    delta: Buffer.alloc(3200).toString("base64"),
  });
  f.b.ended = true;
  f.b.cleanup();
  expect(f.b.context.output_audit.unfinished_responses).toBe(1);
  expect(f.b.context.output_audit.released_pcm_bytes).toBe(0);
  expect(f.b.context.response_audit.at(-1)).toMatchObject({
    generated_pcm_bytes: 3200,
    released_pcm_bytes: 0,
    reason: "call_ended_before_response_done",
    completed_at: null,
  });
});
it("bounds missing acknowledgement callbacks without retrying or releasing queued task speech", async () => {
  const f = await initialAckFixture();
  f.recipient("もしもし、ご用件をお伺いします。");
  f.advance(400);
  await f.b.checkDialogue();
  await f.generate("queued", "予約をお願いできますか。");
  f.advance(10000);
  await f.b.checkDialogue();
  expect(f.b.context.stop_reason).toBe("initial_ack_playback_unconfirmed");
  expect(f.b.context.initial_ack.cancelled).toBe(true);
  expect(f.media.frames.some((m: any) => m.event === "media")).toBe(false);
  expect(
    f.network.filter(
      (n: any) =>
        n.url.endsWith("/speak") &&
        n.body.payload === "はい、よろしくお願いします。",
    ),
  ).toHaveLength(1);
});
it("permits a later genuine audibility answer after the system acknowledgement", async () => {
  const f = await initialAckFixture();
  f.recipient("もしもし、ご用件をお伺いします。");
  f.advance(400);
  await f.b.checkDialogue();
  await f.generate("first-task", "予約をお願いできますか。");
  await ackCompletion(f);
  f.advance(1000);
  for (const mark of [...f.b.marks.pending.keys()]) f.b.marks.acknowledge(mark);
  f.recipient("お声は届いていますか？");
  await f.generate("later-answer", "はい、聞こえています。");
  expect(f.b.responses.get("later-answer").rendered).toBe(3200);
});
it("diagnoses an ended provider conversation after response cancellation and closes once through the fallback", async () => {
  const f = await initialAckFixture();
  await f.generate("cancelled-startup", "こんにちは。");
  expect(f.b.voice.frames.some((m: any) => m.type === "response.cancel")).toBe(
    true,
  );
  const event = {
    type: "error",
    error: {
      code: "conversation_ended",
      message: "PRIVATE provider details must not be persisted",
    },
  };
  await Promise.all([f.b.onVoice(event), f.b.onVoice(event)]);
  expect(f.b.context.failure).toBe("voice_conversation_ended");
  expect(f.b.failing).toBe(true);
  expect(f.b.controller.closing).toBe(true);
  expect(f.b.voice.readyState).toBe(3);
  expect(f.network.filter((n: any) => n.url.endsWith("/speak"))).toHaveLength(
    1,
  );
  expect(f.network.some((n: any) => n.url.endsWith("/hangup"))).toBe(false);
  expect(JSON.stringify([...f.storage.data.values()])).not.toContain("PRIVATE");
  const completion = {
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    occurred_at: new Date(f.advance(0)).toISOString(),
    payload: {
      connection_id: f.env.VOICE_APP_ID,
      call_control_id: "bound-call",
      client_state: f.b.context.fallback_state,
      status: "completed",
    },
  };
  await Promise.all([f.b.onWebhook(completion), f.b.onWebhook(completion)]);
  await f.b.finishFallback();
  expect(f.network.filter((n: any) => n.url.endsWith("/hangup"))).toHaveLength(
    1,
  );
  await f.b.onWebhook({
    ...completion,
    id: crypto.randomUUID(),
    event_type: "call.hangup",
  });
  expect(f.statuses.at(-1).fields.CallStatus).toBe("failed");
});
it("ignores provider conversation end during an active farewell, but diagnoses it after that farewell is cancelled", async () => {
  const f = await initialAckFixture();
  await f.b.playControlledFarewell("unable_to_proceed", {
    operationId: "existing-close",
  });
  const event = { type: "error", error: { code: "conversation_ended" } };
  const before = f.network.length;
  await f.b.onVoice(event);
  expect(f.b.context.failure).toBeUndefined();
  expect(f.b.failing).not.toBe(true);
  expect(f.b.context.controlled_closing.cancelled).toBe(false);
  expect(f.network).toHaveLength(before);
  await f.b.cancelControlledFarewell();
  await f.b.onVoice(event);
  expect(f.b.context.failure).toBe("voice_conversation_ended");
  expect(f.b.failing).toBe(true);
});
it("ignores late provider conversation end after the call is already ended", async () => {
  const f = await initialAckFixture();
  f.b.ended = true;
  const before = f.network.length;
  await f.b.onVoice({ type: "error", error: { code: "conversation_ended" } });
  expect(f.b.context.failure).toBeUndefined();
  expect(f.network).toHaveLength(before);
});
