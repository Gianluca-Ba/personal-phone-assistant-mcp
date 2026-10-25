// Genuine virtual audio sessions: this client has no PSTN endpoint, phone number
// argument, calling tool or MCP execution capability. Output stays private.
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
export function wavPCM(file) {
  const b = readFileSync(file);
  let rate, bits, channels;
  for (let p = 12; p + 8 <= b.length;) {
    const id = b.toString("ascii", p, p + 4),
      size = b.readUInt32LE(p + 4);
    if (id === "fmt ") {
      rate = b.readUInt32LE(p + 12);
      channels = b.readUInt16LE(p + 10);
      bits = b.readUInt16LE(p + 22);
    }
    if (id === "data") {
      if (rate !== 16000 || bits !== 16 || channels !== 1)
        throw new Error("16k mono PCM16 required");
      return b.subarray(p + 8, p + 8 + size);
    }
    p += 8 + size + (size % 2);
  }
  throw new Error("No PCM data");
}
const root = ".wrangler/jp-voice";
const state = JSON.parse(readFileSync(root + "/lab-state.json", "utf8"));
const baselineConfigRaw = JSON.parse(
  readFileSync(root + "/api-before/assistant.json", "utf8"),
);
const baselineInstructions = (baselineConfigRaw.data ?? baselineConfigRaw)
  .instructions;
const latinOwner =
  /^Introduce yourself naturally as (.+)'s assistant,/m.exec(
    baselineInstructions,
  )?.[1] ?? "";
const japaneseOwner =
  /。([^。"\n]+)のアシスタントです/.exec(baselineInstructions)?.[1] ?? "";
const aliases = [
  ...new Set([
    latinOwner,
    japaneseOwner,
    ...latinOwner.split(/\s+/),
    ...japaneseOwner.split("・"),
  ]),
].filter((v) => v.length >= 3);
const mentionsOwner = (text) =>
  aliases.some((value) =>
    text.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
  );
const corpus = JSON.parse(readFileSync("voice/jp/scenarios.json", "utf8"));
const manifest = JSON.parse(
  readFileSync(root + "/audio/manifest.json", "utf8"),
);
const requested = (process.argv[2] ?? "aizuchi-hai").split(",");
const speakers =
  process.argv[3] === "both" ? [0, 1] : [Number(process.argv[3] ?? 0)];
const out = join(root, process.argv[4] ?? "virtual-runs");
mkdirSync(out, { recursive: true, mode: 0o700 });
if (!process.env.TELNYX_API_KEY) throw new Error("Local credential required");
async function run(variant, scenario, speaker) {
  const id = state[variant].id;
  if (!/^assistant-[a-f0-9-]+$/.test(id))
    throw new Error("Invalid isolated assistant ID");
  const configRaw = JSON.parse(
    readFileSync(root + "/lab-" + variant + ".json", "utf8"),
  );
  const config = configRaw.data ?? configRaw;
  if (
    config.telephony_settings?.default_texml_app_id ||
    config.insight_settings?.insight_group_id ||
    config.tools?.length
  )
    throw new Error("Isolated assistant required");
  const file = join(out, `${variant}-${speaker}-${scenario.id}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).summary;
  const audioFor = (id) =>
    wavPCM(
      join(
        root,
        "audio",
        manifest.clips.find((c) => c.scenario === id && c.speaker === speaker)
          .file,
      ),
    );
  const input = audioFor(scenario.id),
    hello = audioFor("reception-greeting");
  return new Promise((resolve) => {
    const start = performance.now(),
      events = [],
      responses = new Map();
    let stream,
      finishTimer,
      queue = null,
      pos = 0,
      session = false,
      firstResponse = null,
      targetSent = false,
      lastPlayedAt = 0,
      currentId = null,
      playbackEnd = 0,
      closed = false;
    const now = () => performance.now() - start;
    const log = (e) => events.push({ at_ms: now(), ...e });
    const ws = new WebSocket(
      `wss://api.telnyx.com/v2/ai/assistants/${id}/conversation?input_sample_rate=16000`,
      {
        headers: { Authorization: "Bearer " + process.env.TELNYX_API_KEY },
        handshakeTimeout: 10000,
      },
    );
    const sendAudio = (pcm, label) => {
      if (queue) throw new Error("Overlapping simulated caller clips");
      queue = { pcm, label };
      pos = 0;
      log({
        type: "caller_clip_start",
        label,
        overlap_playback: playbackEnd > now(),
        generation_active: !!(
          currentId &&
          responses.get(currentId) &&
          !responses.get(currentId).done
        ),
      });
    };
    const target = () => {
      if (targetSent || closed) return;
      if (queue) {
        setTimeout(target, 100);
        return;
      }
      targetSent = true;
      sendAudio(input, "target");
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(stream);
      clearTimeout(finishTimer);
      ws.close();
      setTimeout(() => ws.terminate(), 500).unref();
    };
    const deadline = setTimeout(finish, 22000);
    ws.on("open", () => {
      const dynamic =
        scenario.context === "inbound"
          ? { outbound_mode: "false", outbound_language: "", outbound_task: "" }
          : {
              outbound_mode: "true",
              outbound_language: "ja",
              outbound_task:
                "架空の音声品質テストです。所有者の名前や姓は一切言わないでください。テスト利用者の予約時刻を18時に変更できるか確認し、別の16時45分の予約は変えないでください。実際の予約・発信・取引は行わないでください。最初に「予約時刻の確認についてお電話しました。十八時に変更できますか。」と話し、返答を待ってください。AIか尋ねられた場合は正直に答えてください。",
            };
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: { assistant: { dynamic_variables: dynamic } },
        }),
      );
    });
    ws.on("message", (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const rid = m.response_id ?? m.response?.id ?? currentId;
      if (m.type === "session.created") {
        session = true;
        log({
          type: m.type,
          audio: m.session?.audio,
          conversation_id: m.session?.conversation_id,
        });
        sendAudio(
          scenario.context === "inbound" ? input : hello,
          scenario.context === "inbound" ? "target" : "greeting",
        );
        if (scenario.context === "inbound") targetSent = true;
        stream = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          let chunk = Buffer.alloc(3200);
          if (queue) {
            chunk = queue.pcm.subarray(pos, pos + 3200);
            if (chunk.length < 3200)
              chunk = Buffer.concat([chunk, Buffer.alloc(3200 - chunk.length)]);
            pos += 3200;
            if (pos >= queue.pcm.length) {
              log({ type: "caller_clip_end", label: queue.label });
              queue = null;
            }
          }
          ws.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: chunk.toString("base64"),
            }),
          );
        }, 100);
      } else if (m.type === "response.created") {
        currentId = rid;
        responses.set(rid, { id: rid, created_ms: now(), text: "", bytes: 0 });
        firstResponse ??= rid;
        log({ type: m.type, response_id: rid });
      } else if (
        ["response.output_audio.delta", "response.audio.delta"].includes(m.type)
      ) {
        let r = responses.get(rid);
        if (!r) {
          r = { id: rid, created_ms: now(), text: "", bytes: 0 };
          responses.set(rid, r);
          firstResponse ??= rid;
          currentId = rid;
        }
        const bytes = Buffer.from(m.delta ?? "", "base64").length;
        const rate =
          events.find((e) => e.type === "session.created")?.audio?.output
            ?.format?.rate ?? 16000;
        playbackEnd =
          Math.max(playbackEnd, now()) + (bytes / (rate * 2)) * 1000;
        if (!r.bytes) {
          r.first_audio_ms = now();
          log({ type: "assistant_first_audio", response_id: rid });
          if (!targetSent && scenario.context.startsWith("during_"))
            setTimeout(target, scenario.offset_ms);
        }
        r.bytes += bytes;
      } else if (
        [
          "response.output_audio_transcript.delta",
          "response.audio_transcript.delta",
        ].includes(m.type)
      ) {
        const r = responses.get(rid);
        if (r) r.text += m.delta ?? "";
      } else if (m.type === "response.done") {
        const r = responses.get(rid);
        if (r) {
          r.done = true;
          r.status = m.response?.status;
          r.done_ms = now();
        }
        log({ type: m.type, response_id: rid, status: m.response?.status });
        if (!targetSent && !scenario.context.startsWith("during_"))
          setTimeout(target, 400);
        if (m.response?.status === "completed" && targetSent && !queue) {
          clearTimeout(finishTimer);
          finishTimer = setTimeout(finish, 1400);
        }
      } else if (m.type === "error") {
        log({ type: "error", code: m.error?.code });
        finish();
      } else if (
        m.type.startsWith("input_audio_buffer.") ||
        m.type === "conversation.item.input_audio_transcription.completed"
      )
        log({ type: m.type, transcript: m.transcript });
    });
    ws.on("error", () => {
      log({ type: "connection_error" });
      finish();
    });
    ws.on("close", () => {
      clearInterval(stream);
      clearTimeout(deadline);
      clearTimeout(finishTimer);
      closed = true;
      const turns = [...responses.values()],
        targetStart = events.find(
          (e) => e.type === "caller_clip_start" && e.label === "target",
        ),
        targetEnd = events.find(
          (e) => e.type === "caller_clip_end" && e.label === "target",
        );
      const after = targetEnd
        ? turns.find(
            (r) =>
              r.created_ms >= targetEnd.at_ms - 200 &&
              r.first_audio_ms >= targetEnd.at_ms,
          )
        : null;
      const texts = turns.map((r) => r.text).join("\n");
      const summary = {
        variant,
        speaker,
        scenario: scenario.id,
        session_started: session,
        target_sent: targetSent,
        target_finished: !!targetEnd,
        overlap_playback: targetStart?.overlap_playback ?? null,
        generation_active_at_target: targetStart?.generation_active ?? null,
        server_cancelled_responses: turns.filter(
          (r) => r.status === "cancelled",
        ).length,
        completed_responses: turns.filter((r) => r.status === "completed")
          .length,
        first_response_complete: turns[0]?.status === "completed",
        caller_end_to_next_audio_ms: after
          ? after.first_audio_ms - targetEnd.at_ms
          : null,
        owner_name_leaked: mentionsOwner(texts),
        afternoon24h: /午後\s*(?:1[3-9]|2[0-3])時/.test(texts),
        errors: events
          .filter((e) => e.type === "error" || e.type === "connection_error")
          .map((e) => e.code ?? e.type),
        real_calls: 0,
      };
      writeFileSync(
        file,
        JSON.stringify({ summary, events, responses: turns }, null, 2) + "\n",
        { mode: 0o600 },
      );
      resolve(summary);
    });
  });
}
for (const name of requested) {
  const scenario = corpus.scenarios.find((s) => s.id === name);
  if (!scenario) throw new Error("Unknown scenario");
  for (const speaker of speakers)
    for (const variant of ["baseline", "candidate"])
      console.log(JSON.stringify(await run(variant, scenario, speaker)));
}
