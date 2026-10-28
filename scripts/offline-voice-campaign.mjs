// Deterministic, network-free transport/controller stress campaign. Every API,
// media socket and telephone action is mocked, including positive scenarios.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { VoiceBridge } from "../workers/voice/src/bridge.mjs";
const args = Object.fromEntries(process.argv.slice(2).map((s) => s.split("=")));
const count = Number(args.count ?? 1000),
  seed = Number(args.seed ?? 1);
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 10000 ||
  !Number.isInteger(seed)
)
  throw Error("Invalid campaign size/seed");
const observations = args.observations
  ? JSON.parse(readFileSync(args.observations, "utf8"))
  : [];
if (
  !Array.isArray(observations) ||
  observations.length > 1000 ||
  observations.some((s) => typeof s !== "string" || s.length > 4096)
)
  throw Error("Invalid observation corpus");
const hash = (s) => createHash("sha256").update(s).digest("hex");
let rng = seed >>> 0;
const random = (n) => {
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  return rng % n;
};
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
async function fixture() {
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
  const b = new VoiceBridge(new Memory(), env, {
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
      0,
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
    frames: () => media.frames.filter((f) => f.event === "media"),
    cleanup: async () => {
      b.ended = true;
      b.cleanup();
      await Promise.all(jobs.splice(0));
    },
  };
}
const question = "予約なしで購入できますか。";
const menu =
  "次の四つの中からご希望の番号を選択してください。営業時間は一を、サポートは二を、法人は三を、その他のご質問は五を押してください。";
const categories = [
  "startup",
  "recorded_welcome",
  "ivr",
  "routing_hold",
  "dialogue",
  "late_greeting",
  "explicit_hold",
  "terminal",
  "blocked_report",
  "new_transfer",
];
const results = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw Error("External network forbidden in offline campaign");
};
try {
  for (let i = 0; i < count; i++) {
    const kind = i % categories.length,
      jitter = random(1900) + 800;
    const f = await fixture();
    try {
      if (kind === 0) {
        await f.generate("startup", question);
        assert.equal(f.frames().length, 0);
      }
      if (kind === 1) {
        await f.recipient(
          observations.length
            ? observations[random(observations.length)]
            : "AppleStore銀座にお電話いただきありがとうございます。",
        );
        await f.generate("welcome", question);
        assert.equal(f.frames().length, 0);
      }
      if (kind === 2 || kind === 9) {
        if (kind === 9) await f.recipient("もしもし、ご用件をお伺いします。");
        await f.recipient(menu);
        f.advance(jitter);
        const state = await f.b.controller.command(
          "read",
          "read_current_menu",
          {},
        );
        assert.deepEqual(state.advertised_digits, ["1", "2", "3", "5"]);
        const selected = await f.b.controller.command(
          "select",
          "press_ivr_digit",
          { digits: "5", menu_token: state.menu_token },
        );
        assert.equal(selected.ok, true);
        await f.b.controller.command("select", "press_ivr_digit", {
          digits: "5",
          menu_token: state.menu_token,
        });
        assert.equal(
          f.network.filter((n) => n.url.endsWith("/send_dtmf")).length,
          1,
        );
        assert.equal(f.b.context.dialogue_candidate_observed, null);
        await f.generate("menu-question", question);
        assert.equal(f.frames().length, 0);
      }
      if (kind === 3) {
        f.b.context.ivr_progress = {
          state: "awaiting_transition",
          baseline: menu,
          command_id: "mock",
          deadline: Date.now() + 45000,
        };
        f.b.observeRoutingInterim("お電話を転送しております。");
        const deadline = f.b.controller.hold.deadline;
        await f.recipient("お電話を転送しておます。");
        await f.generate("hold-question", question);
        assert.equal(f.frames().length, 0);
        f.advance(jitter);
        await f.recipient("[Music]");
        assert.equal(f.b.controller.hold.deadline, deadline);
        f.advance(180001);
        await f.b.controller.tick();
        assert.equal(f.b.controller.pending.outcome, "unable_to_proceed");
      }
      if (kind === 4) {
        await f.recipient("もしもし、ご用件をお伺いします。");
        f.advance(jitter);
        await f.generate("dialogue", question);
        assert.equal(f.frames().length, 10);
        assert.equal(f.b.context.output_audit.released_responses, 1);
        const frames = f.frames().length;
        await f.b.onVoice({
          type: "response.done",
          response: { id: "dialogue", status: "completed" },
        });
        assert.equal(f.frames().length, frames);
      }
      if (kind === 5) {
        await f.generate("premature", question, {
          afterChunk: () => f.recipient("もしもし、ご用件をお伺いします。"),
        });
        assert.equal(f.frames().length, 0);
        f.advance(jitter);
        await f.generate("fresh", question);
        assert.equal(f.frames().length, 10);
      }
      if (kind === 6) {
        await f.recipient("もしもし。");
        await f.recipient("確認しますので少々お待ちください。");
        const deadline = f.b.controller.hold.deadline;
        f.advance(jitter);
        await f.recipient("はい。");
        assert.equal(f.b.controller.hold.deadline, deadline);
        await f.generate("wait", question);
        assert.equal(f.frames().length, 0);
        await f.recipient("お待たせいたしました。ご用件をお伺いします。");
        f.advance(jitter);
        await f.generate("returned", question);
        assert.equal(f.frames().length, 10);
      }
      if (kind === 7) {
        await f.recipient("ただいま営業時間外です。");
        f.advance(jitter);
        await f.generate("closed", question);
        assert.equal(f.frames().length, 0);
        assert.equal(f.b.controller.recipientTerminal.kind, "closed");
      }
      if (kind === 8) {
        await f.recipient("もしもし。");
        await f.generate("report", "Call Summary: unable_to_proceed");
        assert.equal(f.frames().length, 0);
      }
      results.push({
        id: i,
        scenario: categories[kind],
        seed,
        jitter,
        pass: true,
      });
    } catch (e) {
      results.push({
        id: i,
        scenario: categories[kind],
        seed,
        jitter,
        pass: false,
        error: e.message,
      });
    } finally {
      await f.cleanup();
    }
  }
} finally {
  globalThis.fetch = realFetch;
}
const report = {
  count,
  seed,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  observation_digest: hash(JSON.stringify(observations)),
  real_calls: 0,
  external_api_requests: 0,
  categories: Object.fromEntries(
    categories.map((n) => [n, results.filter((r) => r.scenario === n).length]),
  ),
  results,
};
if (args.output)
  writeFileSync(args.output, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    ...report,
    results: undefined,
    failures: results.filter((r) => !r.pass).slice(0, 8),
  }),
);
if (report.failed) process.exitCode = 1;
