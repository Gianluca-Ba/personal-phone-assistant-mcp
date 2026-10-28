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

async function dialogueFixture() {
  const f = fixture();
  f.env.EXTERNAL_STT = "true";
  f.env.CONTROLLED_FAREWELL = "true";
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
      arguments: '{"outcome":"confirmed"}',
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
it("releases a routing hold for the recorded direct staff greeting and permits a short response", async () => {
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
