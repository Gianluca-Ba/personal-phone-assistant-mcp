// Audio-only virtual test of the native hangup path; no public phone numbers.
import { dtmfAttempts } from "./jp-ivr-tools.mjs";
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const root = ".wrangler/jp-voice";
const config = JSON.parse(readFileSync(root + "/lab-endcall.json", "utf8"));
if (
  config.telephony_settings.default_texml_app_id ||
  config.tools.some(
    (t) => !["hangup", "send_dtmf", "skip_turn"].includes(t.type),
  )
)
  throw new Error("Isolated end-call assistant required");
const cases = JSON.parse(
  readFileSync(
    process.env.JP_SCENARIOS_FILE ?? "voice/jp/end-call-scenarios.json",
    "utf8",
  ),
).scenarios;
const out = join(root, process.argv[2] ?? "end-call-runs");
mkdirSync(out, { recursive: true, mode: 0o700 });
const selected = (process.argv[3] ?? "confirmed,hold-control").split(",");
function pcm(path) {
  const b = readFileSync(path);
  for (let p = 12; p + 8 <= b.length;) {
    const n = b.readUInt32LE(p + 4);
    if (b.toString("ascii", p, p + 4) === "data")
      return b.subarray(p + 8, p + 8 + n);
    p += 8 + n + (n % 2);
  }
  throw new Error("No PCM");
}
for (const s of cases.filter((s) => selected.includes(s.id))) {
  const file = join(out, s.id + ".json");
  if (existsSync(file)) {
    console.log(JSON.stringify(JSON.parse(readFileSync(file, "utf8")).summary));
    continue;
  }
  function synthesize(text, index) {
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
      "LEI16@16000",
      "-c",
      "1",
      stem + ".aiff",
      stem + ".wav",
    ]);
    return pcm(stem + ".wav");
  }
  const clips = [s.text, ...(s.followups ?? [])].map(synthesize);
  let audio = clips.shift();
  const result = await new Promise((resolve) => {
    const start = performance.now(),
      events = [],
      responses = new Map();
    let sender,
      started = false,
      offset = 0,
      inputEnd = null,
      clientClosed = false,
      playbackEnd = 0,
      closeTimer;
    const now = () => performance.now() - start;
    const record = (e) => events.push({ at_ms: now(), ...e });
    const ws = new WebSocket(
      `wss://api.telnyx.com/v2/ai/assistants/${config.id}/conversation?input_sample_rate=16000`,
      { headers: { Authorization: "Bearer " + process.env.TELNYX_API_KEY } },
    );
    const timer = setTimeout(() => {
      clientClosed = true;
      ws.close();
      closeTimer = setTimeout(() => ws.terminate(), 2000);
    }, 42000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            assistant: {
              dynamic_variables: {
                outbound_mode: "true",
                outbound_language: "ja",
                outbound_task:
                  s.task ??
                  "架空の終了処理テストです。テスト利用者の予約を十八時に変更できるか尋ねたところです。これから相手が結果を伝えます。確認された結果だけを簡潔に確認し、相手の最後の言葉を最後まで聞き、終了可能ならお礼と「失礼いたします」を完全に話してからバックエンドに委任しhangupを実行してください。保留や追加の質問なら切らずに待ってください。実際の予約や電話発信はしないでください。所有者名は言わないでください。",
              },
            },
          },
        }),
      ),
    );
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const rid = m.response_id ?? m.response?.id;
      if (m.type === "session.created") {
        record({ type: m.type, audio: m.session?.audio });
        started = true;
        sender = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          let chunk = Buffer.alloc(3200);
          if (offset < audio.length) {
            chunk = audio.subarray(offset, offset + 3200);
            if (chunk.length < 3200)
              chunk = Buffer.concat([chunk, Buffer.alloc(3200 - chunk.length)]);
            offset += 3200;
            if (offset >= audio.length) {
              inputEnd = now();
              record({ type: "caller_audio_complete" });
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
        responses.set(rid, { id: rid, text: "", bytes: 0 });
        record(m);
      } else if (
        ["response.output_audio.delta", "response.audio.delta"].includes(m.type)
      ) {
        const b = Buffer.from(m.delta ?? "", "base64").length;
        const rate =
          events.find((e) => e.type === "session.created")?.audio.output.format
            .rate ?? 16000;
        playbackEnd = Math.max(playbackEnd, now()) + (b / (rate * 2)) * 1000;
        const r = responses.get(rid);
        if (r) {
          r.bytes += b;
          r.first_audio_ms ??= now();
        }
      } else if (
        [
          "response.output_audio_transcript.delta",
          "response.audio_transcript.delta",
        ].includes(m.type)
      ) {
        const r = responses.get(rid);
        if (r) r.text += m.delta ?? "";
      } else {
        record(m);
        if (
          m.type === "response.tool_call.completed" &&
          /dtmf/i.test(m.tool_call?.name ?? "") &&
          m.status === "success" &&
          clips.length
        ) {
          audio = clips.shift();
          offset = 0;
          inputEnd = null;
          record({ type: "next_virtual_menu" });
        }
        if (m.type === "response.done") {
          const r = responses.get(rid);
          if (r) {
            r.status = m.response?.status;
            r.done_ms = now();
          }
        }
      }
    });
    ws.on("error", () => record({ type: "connection_error" }));
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
      clearInterval(sender);
      const at = now();
      record({
        type: "socket_closed",
        code,
        reason: reason.toString(),
        client_initiated: clientClosed,
      });
      const text = [...responses.values()].map((r) => r.text).join("\n");
      const summary = {
        scenario: s.id,
        terminal: s.terminal,
        session_started: started,
        closed_by_server: !clientClosed && code === 1000,
        caller_finished_before_close: inputEnd !== null && at >= inputEnd,
        virtual_audio_drained_before_close: at >= playbackEnd,
        close_minus_virtual_playback_end_ms: at - playbackEnd,
        farewell_in_output: /失礼(?:いた)?します|失礼いたします/.test(text),
        tool_events: events
          .filter((e) => /delegation|function_call|tool/i.test(e.type))
          .map((e) => e.type),
        errors: events
          .filter((e) => e.type === "error")
          .map((e) => e.error?.code),
        dtmf_attempts: dtmfAttempts(events),
        expected_digits: s.expected_digits ?? null,
        unplayed_followup_menus: clips.length,
        real_calls: 0,
      };
      resolve({ summary, events, responses: [...responses.values()] });
    });
  });
  writeFileSync(file, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result.summary));
}
