// Shared local fixture: every telephone/provider operation is mocked.
import assert from "node:assert/strict";
import { VoiceBridge } from "../workers/voice/src/bridge.mjs";
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
class Socket {
  readyState = 1;
  frames = [];
  accept() {}
  addEventListener() {}
  send(s) {
    this.frames.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
}
export async function createOfflineVoiceFixture({
  random = () => 100,
  Bridge = VoiceBridge,
} = {}) {
  let at = 1793152800000;
  const network = [],
    jobs = [];
  const row = {
    id: crypto.randomUUID(),
    status: "dialing",
    callback_token: crypto.randomUUID(),
    destination_number: "+81343453600",
    language: "ja",
    instructions:
      "Ask the authorized product availability question; do not invent answers.",
  };
  const env = {
    VOICE_ORIGIN: "https://voice.example",
    VOICE_APP_ID: "123456",
    OUTBOUND_FROM: "+819011111111",
    OUTBOUND_ASSISTANT_ID: "mock",
    VOICE_EXECUTION_ENABLED: "true",
    EXTERNAL_STT: "true",
    CONTROLLED_FAREWELL: "true",
    TELNYX_API_KEY: "MOCK_ONLY",
    VOICE_CONTROL_API_SECRET: "MOCK_ONLY_32_CHARACTERS_NOT_A_SECRET",
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ ...row }),
          run: async () => ({ success: true }),
        }),
      }),
    },
    PHONE_API: { fetch: async () => Response.json({ received: true }) },
  };
  const b = new Bridge(new Memory(), env, {
    now: () => at,
    providerFetch: async (url, init = {}) => {
      network.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return Response.json({ data: { is_alive: false } });
    },
  });
  b.background = (p) => jobs.push(p);
  await b.register({
    request_id: row.id,
    callback_token: row.callback_token,
    destination: row.destination_number,
    from: env.OUTBOUND_FROM,
  });
  const media = new Socket();
  await b.attachMedia(media);
  await b.bindCall("mock-call");
  b.streamId = "mock-stream";
  b.voice = new Socket();
  await b.onVoice({
    type: "session.created",
    session: {
      conversation_id: "mock-conversation",
      audio: {
        input: { format: { rate: 8000 } },
        output: { format: { rate: 8000 } },
      },
    },
  });
  // Tests advance the clock explicitly; never run wall-clock media pumps.
  clearInterval(b.timer);
  clearInterval(b.inputPump);
  clearInterval(b.sttKeepAlive);
  clearInterval(b.voiceHeartbeat);
  const pcm = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++)
    pcm.writeInt16LE(
      Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / 8000)),
      i * 2,
    );
  const recipient = async (text) => {
    b.beginTurn();
    b.deliverTranscript(text);
    await Promise.all(jobs.splice(0));
  };
  const generate = async (id, text, { afterChunk } = {}) => {
    const beforeFrames = media.frames.filter((f) => f.event === "media").length;
    await b.onVoice({ type: "response.created", response: { id } });
    let pos = 0;
    while (pos < pcm.length) {
      const end = Math.min(pcm.length, pos + 2 * (1 + random(500)));
      await b.onVoice({
        type: "response.output_audio.delta",
        response_id: id,
        delta: pcm.subarray(pos, end).toString("base64"),
      });
      pos = end;
      if (afterChunk) {
        await afterChunk();
        afterChunk = null;
      }
    }
    assert.equal(
      media.frames.filter((f) => f.event === "media").length,
      beforeFrames,
      "no output before completed validation",
    );
    await b.onVoice({
      type: "response.output_audio_transcript.delta",
      response_id: id,
      delta: text,
    });
    await b.onVoice({
      type: "response.done",
      response: { id, status: "completed" },
    });
  };
  return {
    b,
    media,
    network,
    jobs,
    recipient,
    generate,
    advance: (n) => (at += n),
    now: () => at,
    frames: () => media.frames.filter((f) => f.event === "media"),
    cleanup: async () => {
      b.ended = true;
      b.cleanup();
      await Promise.all(jobs.splice(0));
    },
  };
}
