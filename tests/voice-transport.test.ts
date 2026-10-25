import { expect, it, afterEach } from "vitest";
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
