// Audio-only virtual test of the native hangup path; no public phone numbers.
import { CallController } from "./jp-call-controller.mjs";
import { forwardLabRecipientEvent } from "./jp-lab-turns.mjs";
import { evaluateRun, evaluateGuardedRun } from "./jp-voice-verdict.mjs";
import { PlaybackClock } from "./jp-playback-clock.mjs";
import { dtmfAttempts } from "./jp-ivr-tools.mjs";
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const variant = process.env.JP_LAB_VARIANT ?? "endcall";
if (!/^[a-z0-9-]+$/.test(variant)) throw new Error("Invalid lab variant");
const root = ".wrangler/jp-voice";
const config = JSON.parse(
  readFileSync(root + "/lab-" + variant + ".json", "utf8"),
);
if (
  config.telephony_settings.default_texml_app_id ||
  config.tools.some(
    (t) =>
      !["hangup", "send_dtmf", "skip_turn", "client_side_tool"].includes(
        t.type,
      ),
  )
)
  throw new Error("Isolated end-call assistant required");
// This runner estimates a frontend-spoken farewell and has no playFarewell
// transport. Do not silently test a system-farewell prompt against that route.
if (
  config.tools.every((tool) => tool.type === "client_side_tool") &&
  /system(?:-controlled| (?:will )?plays?)[^\n]{0,120}(?:farewell|失礼)/i.test(
    config.instructions ?? "",
  )
)
  throw new Error(
    "System-controlled farewell requires the bridge lab; this runner supports the legacy frontend-spoken farewell only",
  );
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
      playback = new PlaybackClock(),
      closeTimer,
      closedByController = false,
      recipientOverlapped = false,
      recipientAnswerWindow = false;
    const now = () => performance.now() - start;
    const record = (e) => events.push({ at_ms: now(), ...e });
    const ws = new WebSocket(
      `wss://api.telnyx.com/v2/ai/assistants/${config.id}/conversation?input_sample_rate=16000`,
      { headers: { Authorization: "Bearer " + process.env.TELNYX_API_KEY } },
    );
    const controller = new CallController({
      requirePlaybackAck: false, // Isolated virtual PCM player only; never a PSTN playback claim.
      now,
      sendDigit: async (digits) => {
        record({ type: "controller.virtual_dtmf", digits });
        if (clips.length) {
          audio = clips.shift();
          offset = 0;
          inputEnd = null;
          record({ type: "next_virtual_menu" });
        }
        return { ok: true, simulated: true, remote_acceptance_verified: false };
      },
      close: async (outcome) => {
        record({ type: "controller.virtual_close", outcome });
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "response.cancel" }));
        closedByController = true;
        clientClosed = true;
        ws.close();
        closeTimer = setTimeout(() => ws.terminate(), 2000);
      },
    });
    const controllerTimer = setInterval(
      () => controller.tick().catch(() => record({ type: "controller_error" })),
      50,
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
      if (m.type === "input_audio_buffer.speech_started") {
        const remaining = playback.remaining(now());
        recipientOverlapped = remaining > 0;
        recipientAnswerWindow =
          controller.assistantQuestionPending &&
          !controller.responseActive &&
          remaining <= 500;
      }
      forwardLabRecipientEvent(controller, m, {
        overlapped: recipientOverlapped,
        answerWindow: recipientAnswerWindow,
      });
      if (m.type === "conversation.item.input_audio_transcription.completed") {
        recipientOverlapped = false;
        recipientAnswerWindow = false;
      }
      if (
        m.type === "conversation.item.created" &&
        m.item?.type === "function_call"
      ) {
        record(m);
        let args;
        try {
          args = JSON.parse(m.item.arguments);
        } catch {
          args = null;
        }
        controller.command(m.item.call_id, m.item.name, args).then((result) => {
          record({ type: "controller.tool_result", name: m.item.name, result });
          if (
            m.item.name === "finish_call_after_goodbye" &&
            result.ok &&
            controller.farewell
          )
            return;
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: m.item.call_id,
                  output: JSON.stringify(result),
                },
              }),
            );
        });
      }
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
        if (controller.closed || controller.closing) {
          record({ type: "audio_discarded_after_controlled_close", bytes: b });
          return;
        }
        playback.append(b, rate, now());
        controller.event({ type: "assistant_audio", bytes: b, rate });
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
        if (m.type === "input_audio_buffer.speech_started") {
          playback.clear(now());
          controller.event({ type: "response.cancelled" });
        }
        if (m.type === "response.done" && m.response?.status === "cancelled") {
          playback.clear(now());
          controller.event({ type: "response.cancelled" });
        }
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
            if (r.status === "completed")
              controller.event({ type: "assistant_completed", text: r.text });
          }
        }
      }
    });
    ws.on("error", () => record({ type: "connection_error" }));
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      clearTimeout(closeTimer);
      clearInterval(sender);
      clearInterval(controllerTimer);
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
        assistant_version: config.version_id,
        model: config.model,
        voice: config.voice_settings.voice,
        delegation_enabled: config.delegation_settings?.enabled,
        backend_model: config.delegation_settings?.enabled
          ? config.delegation_settings.model
          : null,
        configured_tools: config.tools.map((t) => t.type),
        audio_queue_model:
          "PCM16; cleared on native barge-in/cancel; estimated, not PSTN playback",
        terminal: s.terminal,
        session_started: started,
        closed_by_controller: closedByController,
        virtual_dtmf_digits: events
          .filter((e) => e.type === "controller.virtual_dtmf")
          .map((e) => e.digits),
        closed_by_server: !clientClosed && code === 1000,
        caller_finished_before_close: inputEnd !== null && at >= inputEnd,
        virtual_audio_drained_before_close: playback.remaining(at) === 0,
        close_minus_virtual_playback_end_ms: at - playback.end,
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
  result.verdict = config.tools.every((t) => t.type === "client_side_tool")
    ? evaluateGuardedRun(result, s)
    : evaluateRun(result, s);
  writeFileSync(file, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...result.summary, verdict: result.verdict }));
}
