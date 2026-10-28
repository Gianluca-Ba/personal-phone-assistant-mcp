import { dtmfTuning, progressEvidence, menuText } from "./ivr-progress.mjs";
import { fetchSocketUpgrade } from "./upgrade.mjs";
import {
  MediaActivity,
  SttTurns,
  genuineInterruption,
  classifyRecipientTurn,
  isAudibilityCheck,
} from "./turns.mjs";
import { composeOutboundTask, speechViolation } from "./spoken-policy.mjs";
import { SilenceWatchdog } from "./silence.mjs";
import {
  isBackchannel,
  isHoldFiller,
  isRoutingHold,
} from "../../../scripts/jp-backchannel.mjs";
import { CallController } from "../../../scripts/jp-call-controller.mjs";
import { PlaybackMarks } from "../../../scripts/jp-playback-marks.mjs";
import { decodeMuLaw, MuLawEncoder } from "./audio.mjs";
import { dialPayload, taskFingerprint, statusForEnd } from "./contract.mjs";
import { sha256, sameSecret, parseState } from "./security.mjs";
const json = (body, status = 200) => Response.json(body, { status });
const uuid = () => crypto.randomUUID();
// Match the WHOLE observed interim. A routing sentence followed by an unknown
// suffix, greeting or question must retain the normal recipient speech guard.
const routingOnlyInterim = (text) =>
  /^(?:次[、,\s]*)?(?:ただいま[、,\s]*)?(?:お電話を|担当者に)?(?:おつなぎ|お繋ぎ|転送)(?:いたしております|しております|しています|いたします|します)[。、.!！\s]*(?:(?:少々|しばらく|そのまま)?お待ちください[。、.!！\s]*)?$/.test(
    String(text).normalize("NFKC").trim(),
  ) || isHoldFiller(text);
const commandUUID = (value) => {
  const h = sha256(value);
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-4" +
    h.slice(13, 16) +
    "-a" +
    h.slice(17, 20) +
    "-" +
    h.slice(20, 32)
  );
};
export class VoiceBridge {
  constructor(
    storage,
    env,
    {
      providerFetch = (input, init) => globalThis.fetch(input, init),
      now = () => Date.now(),
    } = {},
  ) {
    this.storage = storage;
    this.env = env;
    this.providerFetch = providerFetch;
    this.background = (p) => p.catch(() => {});
    this.now = now;
    this.responses = new Map();
    this.incoming = new Map();
    this.sttQueue = [];
    this.webhookOperations = new Map();
    this.ended = false;
    this.silence = new SilenceWatchdog({ now });
    this.spokenBlocks = 0;
  }
  async load() {
    this.context ??= await this.storage.get("context");
    return this.context;
  }
  async register(body) {
    dtmfTuning(this.env); // Validate supported limits before returning any dial contract.
    this.speechLimit();
    this.recognitionModel();
    this.routingHoldLimit();
    const existing = await this.load();
    const row = await this.env.DB.prepare(
      "SELECT * FROM outbound_requests WHERE id = ?",
    )
      .bind(body.request_id)
      .first();
    if (
      !row ||
      row.status !== "dialing" ||
      !sameSecret(body.callback_token, row.callback_token) ||
      row.destination_number !== body.destination ||
      body.from !== this.env.OUTBOUND_FROM
    )
      return json({ error: "Outbound context mismatch" }, 409);
    if (row.language !== "ja")
      return json({ error: "Only validated Japanese route is enabled" }, 409);
    const fingerprint = taskFingerprint(row);
    if (
      existing &&
      (existing.fingerprint !== fingerprint || existing.expires < this.now())
    )
      return json({ error: "Registration conflict" }, 409);
    if (!existing) {
      const nonce = uuid(),
        streamNonce = uuid();
      this.context = {
        request_id: row.id,
        callback_token: row.callback_token,
        from: this.env.OUTBOUND_FROM,
        destination: row.destination_number,
        instructions: row.instructions,
        language: row.language,
        dialogue_gate_required: true,
        dialogue_candidate_observed: null,
        fingerprint,
        nonce,
        stream_nonce: streamNonce,
        stream_url:
          this.env.VOICE_ORIGIN.replace(/^https:/, "wss:") +
          "/media/" +
          row.id +
          "/" +
          streamNonce,
        expires: this.now() + 360000,
      };
      await this.persist();
    }
    if (this.env.PREWARM_BEFORE_DIAL === "true") {
      this.preflightStage = "assistant_configuration";
      const r = await this.providerFetch(
        "https://api.telnyx.com/v2/ai/assistants/" +
          encodeURIComponent(this.env.OUTBOUND_ASSISTANT_ID),
        {
          headers: { Authorization: "Bearer " + this.env.TELNYX_API_KEY },
          // Workers rejects redirect:"error"; manual also keeps credentials on this origin.
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!r.ok) throw Error("Assistant preflight failed");
      const b = await r.json(),
        a = b.data ?? b;
      if (
        a.version_id !== this.env.OUTBOUND_ASSISTANT_VERSION ||
        a.greeting !== "" ||
        a.tools.some((t) => t.type !== "client_side_tool")
      )
        throw Error("Assistant configuration drift");
      try {
        this.preflightStage = "provider_connections";
        await Promise.all([
          this.openVoice(),
          ...(this.env.EXTERNAL_STT === "true" ? [this.openStt()] : []),
        ]);
        this.preflightStage = "voice_session_ready";
        await Promise.race([
          this.voiceReadyPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(Error("Voice warmup timeout")), 10000),
          ),
        ]);
        if (!this.voiceReady) throw Error("Voice warmup failed");
      } catch (error) {
        this.ended = true;
        this.cleanup();
        throw error;
      }
      this.preflightStage = "complete";
      this.orphanTimer = setTimeout(() => {
        if (!this.context.call_id) {
          this.ended = true;
          this.cleanup();
        }
      }, 45000);
    }
    return json({
      endpoint: "https://api.telnyx.com/v2/calls",
      payload: dialPayload(this.context, this.env),
    });
  }
  async persist() {
    await this.storage.put("context", this.context);
  }
  async reserveStream(nonce) {
    await this.load();
    if (
      !this.context ||
      this.context.expires < this.now() ||
      nonce !== this.context.stream_nonce
    )
      return false;
    return this.storage.transaction(async (tx) => {
      if (await tx.get("stream_claimed")) return false;
      await tx.put("stream_claimed", true);
      return true;
    });
  }
  async bindCall(id) {
    if (typeof id !== "string" || !id || id.length > 2048)
      throw Error("Invalid call identity");
    if (this.context.call_id && this.context.call_id !== id)
      throw Error("Call identity conflict");
    const row = await this.env.DB.prepare(
      "SELECT telnyx_call_id, callback_token, status FROM outbound_requests WHERE id = ?",
    )
      .bind(this.context.request_id)
      .first();
    if (
      !row ||
      row.callback_token !== this.context.callback_token ||
      (row.telnyx_call_id && row.telnyx_call_id !== id) ||
      !["dialing", "completed", "failed"].includes(row.status)
    )
      throw Error("Call binding mismatch");
    this.context.call_id = id;
    clearTimeout(this.orphanTimer);
    await this.persist();
    await this.env.DB.prepare(
      "UPDATE outbound_requests SET telnyx_call_id = ? WHERE id = ? AND callback_token = ? AND (telnyx_call_id IS NULL OR telnyx_call_id = ?)",
    )
      .bind(id, this.context.request_id, this.context.callback_token, id)
      .run();
    await this.bindConversation();
  }
  async voiceAPI(action, body, operation) {
    if (
      !["send_dtmf", "hangup", "speak", "playback_stop"].includes(action) ||
      !this.context?.call_id
    )
      throw Error("Unbound or forbidden action");
    const key = "command/" + sha256(action + ":" + operation),
      input = sha256(JSON.stringify(body));
    const command_id = commandUUID(
      this.context.call_id + ":" + action + ":" + operation,
    );
    const reservation = await this.storage.transaction(async (tx) => {
      const old = await tx.get(key);
      if (old) return { old };
      await tx.put(key, { reserved: true, command_id, input });
      return { created: true };
    });
    if (reservation.old)
      return reservation.old.input !== input
        ? { ok: false, reason: "OPERATION_CONFLICT" }
        : (reservation.old.result ?? {
            ok: false,
            reason: "DISPATCH_UNCONFIRMED",
          });
    let result;
    try {
      const r = await this.providerFetch(
        "https://api.telnyx.com/v2/calls/" +
          encodeURIComponent(this.context.call_id) +
          "/actions/" +
          action,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + this.env.TELNYX_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...body, command_id }),
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        },
      );
      result = {
        ok: r.ok,
        http_status: r.status,
        ...(!r.ok ? { reason: "PROVIDER_HTTP_" + r.status } : {}),
      };
    } catch {
      result = { ok: false, reason: "DISPATCH_UNCONFIRMED" };
    }
    await this.storage.put(key, { command_id, input, result });
    if (action === "hangup" && result.ok) {
      this.context.close_dispatched = true;
      await this.persist();
    }
    return result;
  }
  async recordEvent(event, operation, details = {}) {
    const key = "audit/" + event + "/" + sha256(operation);
    const entry = { event, at: this.now(), ...details };
    const created = await this.storage.transaction(async (tx) => {
      if (await tx.get(key)) return false;
      await tx.put(key, entry);
      return true;
    });
    if (created) console.info(JSON.stringify(entry));
  }
  async sendIvrDigit(digits, operation) {
    const tuning = dtmfTuning(this.env),
      id = commandUUID(
        this.context.call_id + ":send_dtmf:" + operation.operationId,
      );
    const baseline = this.controller.menu?.text ?? "";
    this.context.ivr_dispatch = {
      at: this.now(),
      exact_menu_token: operation.exactMenuToken === true,
      dispatch_guard: operation.dispatchGuard ?? "unspecified",
    };
    await this.recordEvent("dtmf_requested", id, {
      command_id: id,
      digit: digits,
      duration_millis: tuning.duration,
      call_leg_id: this.context.call_leg_id ?? null,
      dispatch_guard: operation.dispatchGuard ?? "unspecified",
    });
    const result = await this.voiceAPI(
      "send_dtmf",
      { digits, duration_millis: tuning.duration },
      operation.operationId,
    );
    if (result.ok) {
      await this.recordEvent("dtmf_accepted", id, {
        command_id: id,
        http_status: result.http_status ?? null,
        call_leg_id: this.context.call_leg_id ?? null,
      });
      if (this.context.ivr_progress?.command_id !== id) {
        this.context.dialogue_candidate_observed = null;
        this.context.ivr_progress = {
          command_id: id,
          state: "awaiting_transition",
          accepted_at: this.now(),
          deadline: this.now() + tuning.timeout,
          baseline,
          dispatch_guard: operation.dispatchGuard ?? "unspecified",
        };
        await this.persist();
      }
    } else
      await this.recordEvent("dtmf_not_accepted", id, {
        command_id: id,
        reason: result.reason ?? "unknown",
        http_status: result.http_status ?? null,
      });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }
  async observeIvrProgress(text) {
    const p = this.context.ivr_progress;
    const known = this.context.seen_recipient_digests ?? [];
    if (p && (p.state === "awaiting_transition" || this.routingWait())) {
      const evidence = progressEvidence(p.baseline, text, known);
      if (evidence) {
        p.state =
          evidence.kind === "human_greeting_candidate"
            ? "dialogue_candidate"
            : "transition_observed";
        p.evidence = evidence;
        p.observed_at = this.now();
        await this.recordEvent(
          evidence.kind === "human_greeting_candidate"
            ? "ivr_transition_candidate"
            : "ivr_transition_detected",
          p.command_id,
          {
            command_id: p.command_id,
            evidence_kind: evidence.kind,
            evidence_digest: evidence.digest,
            carrier_reception_proven: false,
          },
        );
      }
    }
    const digest = sha256(menuText(text));
    this.context.seen_recipient_digests = [
      ...known.filter((x) => x !== digest),
      digest,
    ].slice(-32);
    await this.persist();
  }
  routingWait() {
    const p = this.context?.ivr_progress;
    return !!(
      p &&
      (p.state === "routing_candidate" ||
        (p.state === "transition_observed" &&
          p.evidence?.kind === "routing_announcement"))
    );
  }
  observeRoutingInterim(text) {
    const p = this.context.ivr_progress;
    if (
      !p ||
      !["awaiting_transition", "routing_candidate"].includes(p.state) ||
      this.controller.recipientTerminal ||
      this.controller.holdExpired ||
      !isRoutingHold(text)
    )
      return;
    const first = p.state !== "routing_candidate";
    p.state = "routing_candidate";
    p.routing_candidate_at ??= this.now();
    this.controller.enterHold(this.now(), "routing");
    p.routing_hold_deadline ??= this.controller.hold?.deadline;
    this.suppressCurrentResponse("routing_hold");
    if (first)
      this.background(
        this.recordEvent("ivr_routing_candidate", p.command_id, {
          evidence_digest: sha256(menuText(text)),
          carrier_reception_proven: false,
        })
          .then(() => this.persist())
          .then(() => this.bindConversation(true))
          .catch(() => {}),
      );
  }
  async checkIvrDeadline() {
    const p = this.context?.ivr_progress;
    if (
      this.ended ||
      this.failing ||
      this.ivrDeadlineBusy ||
      p?.state !== "awaiting_transition" ||
      this.controller?.recipientTerminal ||
      this.controller?.hold ||
      this.controller?.pending ||
      this.context?.controlled_close_requested ||
      this.now() < p.deadline
    )
      return;
    // Let an in-flight recipient sentence finish; only a known repeated IVR
    // announcement may be cut after the bounded grace period.
    if (
      this.controller?.speaking &&
      (this.now() < p.deadline + 20000 || !this.controller.menu?.isIvr)
    )
      return;
    this.ivrDeadlineBusy = true;
    try {
      p.state = "transition_timeout";
      this.context.close_outcome = "unable_to_proceed";
      await this.recordEvent("ivr_transition_timeout", p.command_id, {
        command_id: p.command_id,
        wait_ms: this.now() - p.accepted_at,
      });
      await this.fail("ivr_transition_timeout");
    } finally {
      this.ivrDeadlineBusy = false;
    }
  }
  async finishFallback() {
    const result = await this.voiceAPI("hangup", {}, "fallback-termination");
    if (result.ok) {
      this.ended = true;
      this.cleanup();
    }
  }
  async bindConversation(force = false) {
    // Serialize metadata writes. An older PUT must not overwrite the final
    // audit when the callee ends the call while an update is still in flight.
    const previous = this.metadataUpdate ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.updateConversationMetadata(force));
    this.metadataUpdate = current;
    return current;
  }
  async updateConversationMetadata(force = false) {
    if (
      !this.context?.conversation_id ||
      (!force && this.context.metadata_bound) ||
      (!this.context.call_id && this.context.metadata_prebound)
    )
      return;
    const r = await this.providerFetch(
      "https://api.telnyx.com/v2/ai/conversations/" +
        encodeURIComponent(this.context.conversation_id),
      {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + this.env.TELNYX_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          metadata: {
            ...(this.context.call_id
              ? { call_control_id: this.context.call_id }
              : {}),
            from: this.context.from,
            to: this.context.destination,
            outbound_request_id: this.context.request_id,
            direction: "outbound",
            reported_task_outcome:
              this.context.close_outcome ??
              this.context.controlled_closing?.outcome ??
              "unspecified",
            system_farewell_played: this.context.system_farewell_played
              ? "true"
              : "false",
            voice_output_audit_final: this.context.terminal_at
              ? "true"
              : "false",
            deferred_audibility_checks: String(
              this.context.deferred_audibility_checks ?? 0,
            ),
            ...(this.context.closure_timing
              ? {
                  voice_closure_timing: JSON.stringify(
                    this.context.closure_timing,
                  ),
                }
              : {}),
            voice_dialogue_gate: JSON.stringify({
              required: this.context.dialogue_gate_required === true,
              candidate_observed: !!this.context.dialogue_candidate_observed,
              human_identity_verified: false,
            }),
            voice_output_audit: JSON.stringify(
              this.context.output_audit ?? {
                completed_responses: 0,
                released_responses: 0,
                blocked_responses: 0,
                released_pcm_bytes: 0,
                recipient_reception_proven: false,
              },
            ),
            voice_response_audit: JSON.stringify(
              this.context.response_audit ?? [],
            ),
            ...(this.context.initial_ack
              ? {
                  voice_initial_ack: JSON.stringify({
                    requested_at: this.context.initial_ack.requested_at,
                    accepted_at: this.context.initial_ack.accepted_at ?? null,
                    completed_at: this.context.initial_ack.completed_at ?? null,
                    cancelled: this.context.initial_ack.cancelled,
                  }),
                }
              : {}),
            ...(this.context.ivr_gate
              ? { voice_ivr_gate: JSON.stringify(this.context.ivr_gate) }
              : {}),
            ...(this.context.ivr_progress
              ? {
                  voice_ivr_progress: JSON.stringify({
                    state: this.context.ivr_progress.state,
                    evidence_kind:
                      this.context.ivr_progress.evidence?.kind ?? null,
                    routing_candidate_at:
                      this.context.ivr_progress.routing_candidate_at ?? null,
                    routing_hold_deadline:
                      this.context.ivr_progress.routing_hold_deadline ?? null,
                  }),
                }
              : {}),
            ...(this.context.stt_observations
              ? {
                  voice_stt_observations: JSON.stringify(
                    this.context.stt_observations,
                  ),
                }
              : {}),
            ...(this.context.ivr_gate_history
              ? {
                  voice_ivr_gate_history: JSON.stringify(
                    this.context.ivr_gate_history,
                  ),
                }
              : {}),
            transcript_source:
              this.env.EXTERNAL_STT === "true"
                ? "external_stt_" + this.recognitionModel().replaceAll("-", "_")
                : "voice_assistant",
          },
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!r.ok) throw Error("Conversation binding failed");
    if (this.context.call_id)
      await this.env.DB.prepare(
        "UPDATE outbound_requests SET conversation_id = ? WHERE id = ? AND callback_token = ? AND telnyx_call_id = ? AND (conversation_id IS NULL OR conversation_id = ?)",
      )
        .bind(
          this.context.conversation_id,
          this.context.request_id,
          this.context.callback_token,
          this.context.call_id,
          this.context.conversation_id,
        )
        .run();
    this.context.metadata_prebound = true;
    this.context.metadata_bound = !!this.context.call_id;
    await this.persist();
  }
  async terminate(outcome, operation) {
    this.context.close_outcome = outcome;
    this.observeClosurePhase("hangup_requested");
    await this.persist();
    const result = await this.voiceAPI("hangup", {}, operation);
    if (!result.ok) throw Error("Hangup unconfirmed");
    this.observeClosurePhase("hangup_accepted");
    this.ended = true;
    clearInterval(this.inputPump);
    clearInterval(this.timer);
    try {
      this.media?.close();
    } catch {}
    this.cleanupDelay = setTimeout(() => this.cleanup(), 15000);
    // Optional summary metadata must never delay an actual telephone hangup.
    this.background(this.bindConversation(true));
  }
  observeClosurePhase(phase, details = {}) {
    const timing = (this.context.closure_timing ??= {});
    timing[phase + "_at"] = this.now();
    this.background(
      this.recordEvent(
        "closure_" + phase,
        String(this.context.farewell_generation ?? 0),
        {
          ...details,
          ...(timing.hold_deadline !== undefined
            ? { since_hold_deadline_ms: this.now() - timing.hold_deadline }
            : {}),
        },
      ),
    );
  }
  async playControlledFarewell(outcome, op) {
    if (this.initialAckPending()) await this.cancelInitialAck();
    // The model never supplies the farewell audio in the controlled route.
    this.suppressCurrentResponse("controlled_farewell");
    const generation = (this.context.farewell_generation ?? 0) + 1;
    if (generation > 3) throw Error("Farewell interruption limit");
    this.context.farewell_generation = generation;
    this.observeClosurePhase("farewell_requested");
    const state = Buffer.from(
      JSON.stringify({
        request_id: this.context.request_id,
        nonce: this.context.nonce,
        phase: "closing",
        token: uuid(),
      }),
    ).toString("base64");
    const closing = { state, outcome, cancelled: false, completed: false };
    this.context.controlled_closing = closing;
    await this.persist();
    if (
      this.ended ||
      closing.cancelled ||
      this.context.controlled_closing !== closing
    )
      return;
    const result = await this.systemVoiceAction(
      "speak",
      {
        payload: "ありがとうございます。失礼いたします。",
        payload_type: "text",
        voice: "female",
        language: "ja-JP",
        client_state: state,
      },
      "closing:" + op.operationId + ":" + generation,
      () =>
        !this.ended &&
        !closing.cancelled &&
        this.context.controlled_closing === closing,
    );
    if (result.ok && !result.skipped)
      this.observeClosurePhase("farewell_accepted");
    if (!result.ok && !closing.cancelled)
      throw Error("Farewell playback unconfirmed");
    if (
      result.ok &&
      !result.skipped &&
      !this.ended &&
      !closing.cancelled &&
      !closing.completed &&
      this.context.controlled_closing === closing
    )
      this.controlledFarewellDeadline = setTimeout(() => {
        if (
          !this.ended &&
          !closing.cancelled &&
          !closing.completed &&
          this.context.controlled_closing === closing
        )
          this.background(this.fail("farewell_playback_unconfirmed"));
      }, 20000);
  }
  systemVoiceAction(action, body, operation, permitted = () => !this.ended) {
    // Serialize fixed speech and stop commands so a late stop for an old
    // farewell cannot overtake a newly requested farewell/check.
    this.systemActionsPending = (this.systemActionsPending ?? 0) + 1;
    const work = (this.systemActions ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        permitted()
          ? this.voiceAPI(action, body, operation)
          : { ok: true, skipped: true },
      )
      .finally(() => {
        this.systemActionsPending--;
      });
    this.systemActions = work;
    return work;
  }
  async cancelControlledFarewell() {
    this.context.controlled_close_requested = false;
    const current = this.context.controlled_closing;
    if (!current || current.cancelled || this.context.close_dispatched) return;
    const alreadyPlayed = this.context.system_farewell_played;
    this.context.system_farewell_played = false;
    current.cancelled = true;
    clearTimeout(this.controlledFarewellDeadline);
    this.controller.event({ type: "system_farewell_cancelled" });
    const stop = !alreadyPlayed
      ? this.systemVoiceAction(
          "playback_stop",
          { stop: "all" },
          "cancel-closing:" + sha256(current.state),
        )
      : Promise.resolve();
    await this.persist();
    await stop;
  }
  async openStt() {
    if (this.stt) return;
    const query = new URLSearchParams({
      transcription_engine: "Deepgram",
      model: this.recognitionModel(),
      input_format: "linear16",
      sample_rate: "8000",
      language: "ja",
      interim_results: "true",
    });
    // These parameters are documented only for Flux and rejected by Nova-3.
    if (this.recognitionModel() === "flux-multi") {
      query.set("eot_threshold", "0.8");
      query.set("eot_timeout_ms", "2000");
    }
    const r = await fetchSocketUpgrade(
      this.providerFetch,
      "https://api.telnyx.com/v2/speech-to-text/transcription?" + query,
      {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer " + this.env.TELNYX_API_KEY,
        },
        redirect: "manual",
      },
    );
    if (r.status !== 101 || !r.webSocket)
      throw Error("Speech recognition unavailable");
    this.stt = r.webSocket;
    this.stt.accept();
    this.stt.addEventListener("message", (e) => {
      try {
        const frame = JSON.parse(e.data);
        this.observeRecognitionFrame(frame);
        this.turns?.accept(frame);
      } catch {
        this.background(this.fail("stt_error"));
      }
    });
    this.stt.addEventListener("close", () => {
      if (!this.ended && !this.failing)
        this.background(this.fail("stt_disconnected"));
    });
    this.stt.addEventListener("error", () =>
      this.background(this.fail("stt_connection_error")),
    );
    this.sttKeepAlive = setInterval(() => {
      if (this.stt?.readyState === 1)
        this.stt.send(JSON.stringify({ type: "KeepAlive" }));
    }, 5000);
  }
  speakingOutput() {
    if (this.initialAckPending()) return true;
    if (
      this.context.controlled_closing &&
      !this.context.controlled_closing.cancelled
    )
      return true;
    if (
      this.context.attention &&
      !this.context.attention.cancelled &&
      !this.context.attention.completed
    )
      return true;
    return (
      !!this.controller &&
      (this.controller.playback.remaining(this.now()) > 0 ||
        this.marks?.pending.size > 0 ||
        (this.controller.responseActive &&
          this.responses.get(this.controller.responseId)?.rendered > 0))
    );
  }
  initialReplyCanContinue() {
    if (
      this.initialAckPending() &&
      this.now() - this.context.initial_ack.requested_at < 10000 &&
      !this.modelMustRemainSilent()
    )
      return true;
    const first = this.context.initial_dialogue_response;
    const response = first && this.responses.get(first.id);
    return !!(
      first &&
      first.id === this.controller?.responseId &&
      this.now() - first.started_at < 10000 &&
      response &&
      !response.suppressed &&
      !this.modelMustRemainSilent() &&
      (!response.completed || response.waitingForQuiet || this.speakingOutput())
    );
  }
  deferInitialAudibilityCheck(text) {
    return this.initialReplyCanContinue() && isAudibilityCheck(text);
  }
  deferInitialBackchannel(text) {
    return !!(
      this.initialReplyCanContinue() &&
      !this.controller.assistantQuestionPending &&
      (this.initialAckPending() ||
        this.responses.get(this.controller.responseId)?.rendered === 0) &&
      isBackchannel(text)
    );
  }
  cancelOutput() {
    if (this.cancelledForTurn) return;
    this.cancelledForTurn = true;
    if (this.initialAckPending()) this.background(this.cancelInitialAck());
    const previous = this.responses.get(this.controller.responseId);
    if (previous) {
      previous.suppressed = true;
      previous.blockReason ??= "recipient_interruption";
    }
    if (
      this.context.controlled_closing &&
      !this.context.controlled_closing.cancelled
    )
      this.background(this.cancelControlledFarewell());
    if (
      this.context.attention &&
      !this.context.attention.completed &&
      !this.context.attention.cancelled
    )
      this.background(this.cancelAttention());
    if (this.voice?.readyState === 1)
      this.voice.send(
        JSON.stringify({
          type: "response.cancel",
          response_id: this.controller.responseId,
        }),
      );
    this.marks.clear((m) => this.sendMedia(m));
    this.encoder = new MuLawEncoder(this.outputRate);
    this.controller.event({ type: "response.cancelled" });
  }
  speechLimit() {
    const seconds = Number(this.env.OUTBOUND_MAX_UTTERANCE_SECONDS ?? 12);
    if (!Number.isFinite(seconds) || seconds < 3 || seconds > 20)
      throw Error("Invalid spoken response limit");
    return seconds;
  }
  recognitionModel() {
    const model = this.env.OUTBOUND_STT_MODEL ?? "nova-3";
    if (!["nova-3", "flux-multi"].includes(model))
      throw Error("Unsupported outbound recognition model");
    return model;
  }
  routingHoldLimit() {
    const limit = Number(this.env.OUTBOUND_ROUTING_HOLD_MS ?? 180000);
    if (!Number.isInteger(limit) || limit < 10000 || limit > 180000)
      throw Error("Unsupported routing hold limit");
    return limit;
  }
  observeRecognitionFrame(frame) {
    const s = (this.context.stt_observations ??= {
      frames: 0,
      text_finals: 0,
      raw_five_finals: 0,
      delivered_five: 0,
      input_format: "linear16",
    });
    s.frames++;
    if ((frame.is_final || frame.event === "EndOfTurn") && frame.transcript) {
      s.text_finals++;
      if (/[五5].{0,6}押してください/.test(frame.transcript))
        s.raw_five_finals++;
    }
  }
  modelMustRemainSilent() {
    return !!(
      (this.context.dialogue_gate_required === true &&
        !this.context.dialogue_candidate_observed) ||
      this.controller?.hold ||
      this.context.ivr_progress?.state === "awaiting_transition" ||
      this.routingWait() ||
      this.controller?.holdExpired ||
      this.controller?.recipientTerminal ||
      this.controller?.pending ||
      this.context.initial_ack?.stop_unconfirmed ||
      this.context.controlled_close_requested ||
      (this.context.controlled_closing &&
        !this.context.controlled_closing.cancelled) ||
      (this.context.attention &&
        !this.context.attention.cancelled &&
        !this.context.attention.completed) ||
      this.controller?.menu?.isIvr ||
      /暗証|認証コード|パスワード|本人確認|PIN|OTP/i.test(
        this.controller?.inputText ?? "",
      )
    );
  }
  suppressCurrentResponse(reason) {
    const id = this.controller?.responseId,
      response = this.responses.get(id);
    if (!response || response.suppressed) return;
    response.suppressed = true;
    response.chunks = [];
    response.blockReason = reason;
    if (!response.completed && this.voice?.readyState === 1)
      this.voice.send(
        JSON.stringify({ type: "response.cancel", response_id: id }),
      );
    // No buffered audio has entered the carrier queue. Do not clear previously
    // validated playback merely because a newer, rejected generation exists.
    this.controller.event({
      type: "assistant_completed",
      text: "",
      no_audio: !response.rendered,
    });
  }
  async rejectSpokenResponse(id, reason) {
    const response = this.responses.get(id);
    if (!response || response.guardRejected) return;
    response.guardRejected = true;
    if (id === this.controller.responseId) this.suppressCurrentResponse(reason);
    else {
      response.suppressed = true;
      response.chunks = [];
    }
    this.spokenBlocks++;
    await this.recordEvent("spoken_output_blocked", id, { reason });
    if (this.spokenBlocks >= 3)
      this.requestControlledStop("repeated_speech_policy_block");
  }
  requestControlledStop(reason) {
    if (
      this.ended ||
      this.failing ||
      this.controller?.closed ||
      this.controller?.closing
    )
      return;
    if (this.controller.hold && !this.controller.holdExpired) return;
    this.context.stop_reason ??= reason;
    this.context.controlled_close_requested = true;
    this.controller.assistantQuestionPending = false;
    this.controller.closingBlocked = false;
    this.controller.pending ??= {
      outcome:
        reason === "recipient_farewell" ? "unspecified" : "unable_to_proceed",
      reason,
      operationId: "server-close:" + reason,
    };
    this.suppressCurrentResponse(reason);
  }
  async playAttention() {
    if (this.context.attention || this.ended || this.modelMustRemainSilent())
      return;
    const state = Buffer.from(
      JSON.stringify({
        request_id: this.context.request_id,
        nonce: this.context.nonce,
        phase: "attention",
        token: uuid(),
      }),
    ).toString("base64");
    const attention = { state, cancelled: false, completed: false };
    this.context.attention = attention;
    await this.persist();
    if (this.ended || attention.cancelled || attention.completed) return;
    const result = await this.systemVoiceAction(
      "speak",
      {
        payload: "もしもし、聞こえていらっしゃいますか。",
        payload_type: "text",
        voice: "female",
        language: "ja-JP",
        client_state: state,
      },
      "silence-attention-once",
      () => !this.ended && !attention.cancelled && !attention.completed,
    );
    if (attention.cancelled || attention.completed || this.ended) return;
    if (!result.ok) {
      this.context.attention.cancelled = true;
      this.requestControlledStop("silence_attention_unconfirmed");
      return;
    }
    await this.recordEvent("silence_attention_requested", "once");
    if (
      !this.ended &&
      !this.failing &&
      !this.context.attention.cancelled &&
      !this.context.attention.completed
    )
      this.attentionDeadline = setTimeout(
        () => this.background(this.fail("attention_playback_unconfirmed")),
        20000,
      );
  }
  async cancelAttention() {
    const attention = this.context.attention;
    if (!attention || attention.cancelled || attention.completed) return;
    attention.cancelled = true;
    clearTimeout(this.attentionDeadline);
    this.silence.cancelCheck();
    const stop = this.systemVoiceAction(
      "playback_stop",
      { stop: "all" },
      "cancel-attention",
    );
    await this.persist();
    await stop;
  }
  initialAckPending() {
    const ack = this.context?.initial_ack;
    return !!(ack && !ack.completed_at && !ack.cancelled);
  }
  async cancelInitialAck() {
    const ack = this.context.initial_ack;
    if (!this.initialAckPending()) return;
    ack.cancelled = true;
    const stop = this.systemVoiceAction(
      "playback_stop",
      { stop: "all" },
      "cancel-initial-ack",
    );
    await this.persist();
    const result = await stop;
    if (!result.ok) {
      ack.stop_unconfirmed = true;
      this.requestControlledStop("initial_ack_stop_unconfirmed");
      await this.persist();
    }
  }
  async playInitialAck() {
    if (
      this.env.OUTBOUND_INITIAL_ACK !== "true" ||
      this.context.initial_ack ||
      this.context.output_audit?.released_responses > 0 ||
      !this.context.answered_at ||
      !this.context.call_id ||
      !this.streamId ||
      !this.context.dialogue_candidate_observed ||
      this.ended ||
      this.failing ||
      this.modelMustRemainSilent() ||
      this.controller.speaking ||
      this.activity?.active ||
      this.now() < this.controller.acousticGuardUntil ||
      this.marks.pending.size ||
      this.controller.playback.remaining(this.now()) > 0
    )
      return;
    // A single fixed, non-task-bearing acknowledgement is independent of model
    // generation. Never replay it after a cancellation or an uncertain dispatch.
    const state = Buffer.from(
      JSON.stringify({
        request_id: this.context.request_id,
        nonce: this.context.nonce,
        phase: "initial_ack",
        token: uuid(),
      }),
    ).toString("base64");
    const ack = {
      state,
      requested_at: this.now(),
      cancelled: false,
      accepted_at: null,
      completed_at: null,
    };
    this.context.initial_ack = ack;
    await this.persist();
    const result = await this.systemVoiceAction(
      "speak",
      {
        payload: "はい、よろしくお願いします。",
        payload_type: "text",
        voice: "female",
        language: "ja-JP",
        client_state: state,
      },
      "initial-ack-once",
      () =>
        !this.ended &&
        !this.failing &&
        !ack.cancelled &&
        !this.modelMustRemainSilent() &&
        !this.controller.speaking &&
        !this.activity?.active,
    );
    if (result.skipped) ack.cancelled = true;
    else if (result.ok) ack.accepted_at = this.now();
    else if (!ack.cancelled && !this.ended) {
      await this.cancelInitialAck();
      this.requestControlledStop("initial_ack_dispatch_unconfirmed");
    }
    await this.persist();
  }
  completeBufferedResponse(id, response, release) {
    if (response.finalized) return;
    if (release) {
      if (
        !response.validated ||
        response.suppressed ||
        id !== this.controller.responseId
      )
        throw Error("Invalid buffered speech release");
      this.encoder = new MuLawEncoder(this.outputRate);
      for (const chunk of response.chunks) {
        response.rendered += chunk.length;
        this.controller.event({
          type: "assistant_audio",
          bytes: chunk.length,
          rate: this.outputRate,
        });
        for (const pcmu of this.encoder.append(chunk))
          this.sendMedia({
            event: "media",
            media: { payload: pcmu.toString("base64") },
          });
      }
      for (const pcmu of this.encoder.drain(true))
        this.sendMedia({
          event: "media",
          media: { payload: pcmu.toString("base64") },
        });
      this.spokenBlocks = 0;
      this.silence.activity();
    } else response.suppressed = true;
    response.finalized = true;
    response.waitingForQuiet = false;
    response.chunks = [];
    if (id === this.controller.responseId) {
      this.controller.event({
        type: "assistant_completed",
        text: response.suppressed ? "" : response.text,
        no_audio: !response.rendered,
      });
      this.marks.commit(id, response.rendered > 0);
    }
    const audit = (this.context.output_audit ??= {
      completed_responses: 0,
      released_responses: 0,
      blocked_responses: 0,
      released_pcm_bytes: 0,
      recipient_reception_proven: false,
    });
    if (response.completed) audit.completed_responses++;
    else audit.unfinished_responses = (audit.unfinished_responses ?? 0) + 1;
    if (response.rendered > 0) {
      audit.released_responses++;
      audit.released_pcm_bytes += response.rendered;
    } else audit.blocked_responses++;
    this.context.response_audit = [
      ...(this.context.response_audit ?? []),
      {
        response_digest: sha256(String(id)).slice(0, 16),
        created_at: response.createdAt,
        first_audio_at: response.firstAudioAt ?? null,
        first_text_at: response.firstTextAt ?? null,
        completed_at: response.completedAt ?? null,
        finalized_at: this.now(),
        generated_pcm_bytes: response.bytes,
        released_pcm_bytes: response.rendered,
        reason: response.rendered
          ? "validated_release"
          : (response.blockReason ?? "no_validated_audio"),
      },
    ].slice(-4);
    this.background(this.persist());
  }
  flushBufferedResponses() {
    for (const [id, response] of this.responses) {
      if (!response.waitingForQuiet || response.finalized) continue;
      if (
        this.ended ||
        this.failing ||
        response.suppressed ||
        id !== this.controller.responseId ||
        this.modelMustRemainSilent() ||
        (!this.initialAckPending() &&
          this.now() >=
            Math.max(
              response.quietDeadline,
              (this.context.initial_ack?.completed_at ?? 0) + 2000,
            ))
      ) {
        response.blockReason ??= "quiet_wait_cancelled_or_expired";
        this.completeBufferedResponse(id, response, false);
      } else if (
        !this.systemActionsPending &&
        !this.initialAckPending() &&
        !this.activity?.active &&
        !this.controller.speaking
      )
        this.completeBufferedResponse(id, response, true);
    }
  }
  async checkDialogue() {
    if (this.ended || this.failing || !this.controller || this.dialogueBusy)
      return;
    this.dialogueBusy = true;
    try {
      const c = this.controller;
      // Nova can leave the transfer announcement's turn open throughout hold
      // music. Energy alone does not make that stale announcement a new human
      // sentence. This exception is limited to an expired routing lease and a
      // whole, unchanged wait-only interim observed at least five seconds ago.
      c.routingHoldAudioOnly = !!(
        this.env.EXTERNAL_STT === "true" &&
        this.routingWait() &&
        this.recipientInterim?.waitOnly &&
        this.now() - this.recipientInterim.changedAt >= 5000
      );
      if (
        c.hold &&
        this.now() >= c.hold.deadline &&
        this.context.closure_timing?.hold_deadline !== c.hold.deadline
      ) {
        this.context.closure_timing = { hold_deadline: c.hold.deadline };
        this.observeClosurePhase("timeout_observed", {
          speaking: c.speaking,
          routing_audio_only: c.routingHoldAudioOnly,
          acoustic_guard_pending: this.now() < c.acousticGuardUntil,
          transport_pending: this.marks.pending.size > 0,
        });
      }
      await this.playInitialAck();
      if (this.initialAckPending() && this.modelMustRemainSilent())
        await this.cancelInitialAck();
      if (
        this.initialAckPending() &&
        this.now() - this.context.initial_ack.requested_at >= 10000
      ) {
        await this.cancelInitialAck();
        this.requestControlledStop("initial_ack_playback_unconfirmed");
      }
      this.flushBufferedResponses();
      const active = this.responses.get(c.responseId);
      if (
        active &&
        !active.completed &&
        !active.suppressed &&
        this.now() - active.createdAt >= 15000
      )
        await this.rejectSpokenResponse(c.responseId, "generation_timeout");
      if (
        c.recipientTerminal ||
        c.hold ||
        c.holdExpired ||
        c.pending ||
        this.context.controlled_close_requested
      )
        this.suppressCurrentResponse("recipient_wait_or_close");
      const noQueuedAudio =
        !this.marks.pending.size &&
        c.playback.remaining(this.now()) <= 0 &&
        !this.speakingOutput();
      if (
        (c.recipientTerminal || c.holdExpired || c.pending) &&
        !c.responseActive &&
        noQueuedAudio
      )
        c.event({ type: "output_queue_empty" });
      // A silent start is backed by received carrier media, not an invented
      // transcript or a model assertion that the recipient finished speaking.
      if (
        c.lastSpeechEnd === null &&
        !c.speaking &&
        !this.activity?.active &&
        this.lastMediaAt !== undefined &&
        this.now() - this.lastMediaAt < 1000
      )
        c.lastSpeechEnd = this.now();
      const action = this.silence.next({
        live: !!this.context.call_id && !!this.streamId,
        quiet:
          !c.speaking &&
          !this.activity?.active &&
          this.now() >= c.acousticGuardUntil,
        held:
          !!c.hold ||
          !!c.menu?.isIvr ||
          this.context.ivr_progress?.state === "awaiting_transition" ||
          this.routingWait(),
        terminal:
          !!c.recipientTerminal ||
          !!c.pending ||
          !!this.context.controlled_close_requested,
        outputPending: c.responseActive || !noQueuedAudio,
        awaitingAnswer: c.assistantQuestionPending,
        heardRecipient: !!this.context.recipient_heard,
      });
      if (
        c.menu?.isIvr &&
        !c.hold &&
        !c.recipientTerminal &&
        !c.speaking &&
        !this.activity?.active &&
        noQueuedAudio &&
        this.now() - c.menu.at >= 25000 &&
        this.context.ivr_progress?.state !== "awaiting_transition"
      )
        this.requestControlledStop("ivr_no_selection_timeout");
      if (action === "check") await this.playAttention();
      if (action === "close")
        this.requestControlledStop("recipient_silence_timeout");
      await c.tick();
    } finally {
      this.dialogueBusy = false;
    }
  }
  beginTurn() {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.recipientInterim = null;
    this.controller.routingHoldAudioOnly = false;
    const answeringCompletedQuestion =
      this.controller.assistantQuestionPending &&
      this.controller.playback.remaining(this.now()) <= 0;
    const answeringAttention =
      !!this.context.attention &&
      !this.context.attention.cancelled &&
      !this.context.attention.completed;
    this.overlapped =
      this.speakingOutput() &&
      !answeringCompletedQuestion &&
      !answeringAttention;
    this.cancelledForTurn = false;
    this.silence.activity();
    this.controller.event({ type: "input_audio_buffer.speech_started" });
  }
  observeRecipientInterim(text) {
    const normalized = menuText(text);
    if (!normalized) return;
    const waitOnly = routingOnlyInterim(text);
    if (
      this.recipientInterim?.normalized !== normalized ||
      this.recipientInterim?.waitOnly !== waitOnly
    )
      this.recipientInterim = {
        normalized,
        changedAt: this.now(),
        waitOnly,
      };
    // Withdraw the exception synchronously, including while the farewell's
    // storage/API await is in flight. A partial greeting is not ignored merely
    // because it shares the still-open STT turn with the old announcement.
    if (!waitOnly) {
      this.controller.routingHoldAudioOnly = false;
      if (
        this.context.controlled_closing &&
        !this.context.controlled_closing.cancelled &&
        this.controller.holdExpired &&
        !isBackchannel(text)
      )
        this.background(this.cancelControlledFarewell());
    }
  }
  currentHoldFiller(text) {
    return !!(
      (this.controller?.hold || this.controller?.holdExpired) &&
      isHoldFiller(text)
    );
  }
  deliverTranscript(text) {
    if (this.ended || this.failing) return;
    this.recipientInterim = null;
    this.controller.routingHoldAudioOnly = false;
    if (this.context.stt_observations && /[五5].{0,6}押してください/.test(text))
      this.context.stt_observations.delivered_five++;
    const holdFiller = this.currentHoldFiller(text);
    const p = this.context.ivr_progress;
    const evidence = p ? progressEvidence(p.baseline, text) : null;
    const dialogueEvidence = evidence ?? progressEvidence("", text);
    if (dialogueEvidence?.kind === "human_greeting_candidate")
      this.context.dialogue_candidate_observed = {
        at: this.now(),
        digest: dialogueEvidence.digest,
      };
    const preserveRoutingHold =
      this.routingWait() &&
      !["human_greeting_candidate", "changed_menu"].includes(evidence?.kind);
    if (this.controller.speaking)
      this.controller.event({ type: "input_audio_buffer.speech_stopped" });
    this.controller.event({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: text,
      preserve_hold: preserveRoutingHold,
    });
    const turn = classifyRecipientTurn(text, { overlapped: this.overlapped });
    const deferredCheck = this.deferInitialAudibilityCheck(text);
    const listening =
      turn.kind === "backchannel" ||
      holdFiller ||
      deferredCheck ||
      this.deferInitialBackchannel(text);
    if (deferredCheck)
      this.context.deferred_audibility_checks =
        (this.context.deferred_audibility_checks ?? 0) + 1;
    const expiredHoldRepeated =
      this.controller.holdExpired && turn.kind === "hold_request";
    if (!listening) {
      this.silence.activity();
      this.context.recipient_heard = true;
      this.controller.event({ type: "recipient_answer" });
      if (
        !expiredHoldRepeated &&
        !this.controller.recipientTerminal &&
        !this.context.close_dispatched &&
        this.context.controlled_close_requested
      ) {
        this.controller.pending = null;
        this.controller.farewell = null;
        this.background(this.cancelControlledFarewell());
      }
    }
    if (
      !listening &&
      !expiredHoldRepeated &&
      (this.overlapped ||
        this.speakingOutput() ||
        this.controller.responseActive)
    )
      this.cancelOutput();
    this.background(this.observeIvrProgress(text));
    this.context.filtered_aizuchi =
      (this.context.filtered_aizuchi ?? 0) + (listening ? 1 : 0);
    this.turnOpen = false;
    if (
      this.controller.recipientTerminal ||
      this.controller.hold ||
      this.controller.holdExpired ||
      this.controller.pending
    )
      this.suppressCurrentResponse("recipient_wait_or_close");
    if (!listening && this.voice?.readyState === 1)
      this.voice.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        }),
      );
  }
  async openVoice() {
    if (
      this.voice ||
      this.opening ||
      this.ended ||
      this.context?.close_dispatched ||
      this.context?.failure
    )
      return;
    this.opening = true;
    this.voiceReadyPromise = new Promise((resolve) => {
      this.voiceReadyResolve = resolve;
    });
    const r = await fetchSocketUpgrade(
      this.providerFetch,
      "https://api.telnyx.com/v2/ai/assistants/" +
        encodeURIComponent(this.env.OUTBOUND_ASSISTANT_ID) +
        "/conversation?input_sample_rate=8000&output_sample_rate=8000",
      {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer " + this.env.TELNYX_API_KEY,
        },
        redirect: "manual",
      },
    );
    if (r.status !== 101 || !r.webSocket) {
      this.opening = false;
      throw Error("Voice session unavailable");
    }
    if (this.ended || this.failing) {
      r.webSocket.close();
      return;
    }
    this.voice = r.webSocket;
    this.voice.accept();
    this.voice.send(
      JSON.stringify({
        type: "session.update",
        session: {
          assistant: {
            dynamic_variables: {
              outbound_mode: "true",
              outbound_language: this.context.language,
              outbound_task: composeOutboundTask(this.context.instructions, {
                systemInitialAck: this.env.OUTBOUND_INITIAL_ACK === "true",
              }),
              outbound_request_id: this.context.request_id,
            },
          },
        },
      }),
    );
    if (this.env.EXTERNAL_STT === "true")
      this.voiceHeartbeat = setInterval(() => {
        if (this.voice?.readyState === 1)
          this.voice.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: Buffer.alloc(1600).toString("base64"),
            }),
          );
      }, 5000);
    this.voice.addEventListener("message", (e) =>
      this.onVoice(JSON.parse(e.data)).catch(() =>
        this.fail("voice_event_failed"),
      ),
    );
    this.voice.addEventListener("close", () => {
      if (!this.ended) this.fail("voice_disconnected");
    });
    this.voice.addEventListener("error", () =>
      this.fail("voice_connection_error"),
    );
  }
  async attachMedia(socket) {
    this.media = socket;
    this.controller = new CallController({
      now: this.now,
      stripCumulativeHistory: this.env.EXTERNAL_STT !== "true",
      maxRoutingHoldMs: this.routingHoldLimit(),
      playFarewell:
        this.env.CONTROLLED_FAREWELL === "true"
          ? (outcome, op) => this.playControlledFarewell(outcome, op)
          : null,
      sendDigit: (digits, op) => this.sendIvrDigit(digits, op),
      close: async (outcome, op) => this.terminate(outcome, op.operationId),
    });
    this.marks = new PlaybackMarks({
      sendMark: (m) => this.sendMedia(m),
      onPlayed: (responseId) => {
        this.controller.event({ type: "playback_confirmed", responseId });
        this.silence.activity();
      },
    });
    if (this.env.EXTERNAL_STT === "true") {
      this.activity = new MediaActivity({
        now: this.now,
        // Energy detects possible barge-in, not a new semantic menu/turn.
        onStart: () => {
          this.controller.acousticGuardUntil = this.now() + 2000;
        },
        onStop: () => {
          this.controller.acousticGuardUntil = Math.max(
            this.controller.acousticGuardUntil,
            this.now() + 320,
          );
        },
      });
      this.turns = new SttTurns({
        onStart: () => this.beginTurn(),
        onInterim: (text) => {
          this.observeRecipientInterim(text);
          this.observeRoutingInterim(text);
          this.controller.event({
            type: "recipient_interim_transcript",
            transcript: text,
          });
          if (
            this.overlapped &&
            !this.currentHoldFiller(text) &&
            genuineInterruption(text) &&
            !this.deferInitialAudibilityCheck(text)
          )
            this.cancelOutput();
        },
        onFinal: (text) => {
          this.deliverTranscript(text);
        },
        onEnd: ({ hasTranscript }) => {
          if (!hasTranscript && this.turnOpen) {
            this.recipientInterim = null;
            this.controller.routingHoldAudioOnly = false;
            this.turnOpen = false;
            this.controller.event({
              type: "recipient_turn_untranscribed",
              interrupted: !!this.cancelledForTurn,
            });
          }
        },
      });
      this.inputPump = setInterval(() => {
        if (this.ended || this.failing) return;
        const bytes = this.sttQueue?.length
          ? this.sttQueue.splice(0, 160)
          : null;
        const frame = bytes
          ? Buffer.concat([
              Buffer.from(bytes),
              Buffer.alloc(160 - bytes.length, 255),
            ])
          : Buffer.alloc(160, 255);
        this.activity.observe(frame);
        if (this.stt?.readyState === 1) this.stt.send(decodeMuLaw(frame));
      }, 20);
    }
    this.timer = setInterval(() => {
      this.controller.transportQueuePending = this.marks.pending.size > 0;
      void this.checkDialogue().catch(() => this.fail("controller_failed"));
      void this.checkIvrDeadline().catch(() =>
        this.fail("ivr_watchdog_failed"),
      );
    }, 50);
    this.deadline = setTimeout(() => this.fail("media_deadline"), 330000);
  }
  sendMedia(frame) {
    if (!this.ended && !this.streamingStopped && this.media?.readyState === 1)
      this.media.send(JSON.stringify(frame));
  }
  async onMedia(frame) {
    if (this.ended) return;
    // Telnyx sends connected before start, without a stream identity.
    if (frame.event === "connected") {
      if (this.streamId) throw Error("Unexpected connected frame after start");
      return;
    }
    if (frame.event === "start") {
      if (this.streamId) throw Error("Duplicate stream start");
      const state = parseState(frame.start?.client_state);
      if (
        state?.request_id !== this.context.request_id ||
        state.nonce !== this.context.nonce ||
        frame.start.from !== this.context.from ||
        frame.start.to !== this.context.destination
      )
        throw Error("Stream identity mismatch");
      if (
        frame.start.media_format?.encoding !== "PCMU" ||
        frame.start.media_format.sample_rate !== 8000 ||
        frame.start.media_format.channels !== 1
      )
        throw Error("Unsupported input codec");
      this.streamId = frame.stream_id;
      this.silence.activity();
      await this.bindCall(frame.start.call_control_id);
      await this.openVoice();
      return;
    }
    if (frame.stream_id !== this.streamId || !this.streamId)
      throw Error("Stream identity mismatch");
    if (frame.event === "media") {
      if (frame.media?.track !== "inbound") return;
      const sequence = Number(frame.media.chunk);
      if (!Number.isSafeInteger(sequence) || sequence < 0)
        throw Error("Invalid media sequence");
      if (this.lastChunk !== undefined && sequence <= this.lastChunk) return;
      this.incoming.set(sequence, frame.media.payload);
      if (this.lastChunk === undefined) this.lastChunk = sequence - 1;
      if (this.incoming.size > 10) throw Error("Input media gap");
      while (this.incoming.has(this.lastChunk + 1)) {
        this.lastChunk++;
        const bytes = Buffer.from(this.incoming.get(this.lastChunk), "base64");
        this.incoming.delete(this.lastChunk);
        if (!bytes.length || bytes.length > 8000)
          throw Error("Invalid media length");
        this.lastMediaAt = this.now();
        if (this.env.EXTERNAL_STT === "true") {
          this.sttQueue.push(...bytes);
          if (this.sttQueue.length > 16000) throw Error("Speech input backlog");
          continue;
        }
        const pcm = decodeMuLaw(bytes);
        if (this.voiceReady)
          this.voice.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: pcm.toString("base64"),
            }),
          );
        else {
          this.inputQueue ??= [];
          this.inputQueue.push(pcm);
          this.inputQueuedBytes = (this.inputQueuedBytes ?? 0) + pcm.length;
          if (this.inputQueuedBytes > 160000)
            throw Error("Voice startup exceeded");
        }
      }
    } else if (frame.event === "mark") this.marks.acknowledge(frame.mark?.name);
    else if (frame.event === "stop") {
      this.streamingStopped = true;
      this.mediaStopTimer = setTimeout(() => {
        if (!this.ended) this.background(this.disconnected());
      }, 500);
    } else if (frame.event === "error") throw Error("Media transport error");
  }
  async onVoice(frame) {
    if (this.ended) return;
    if (
      this.env.EXTERNAL_STT === "true" &&
      (frame.type.startsWith("input_audio_buffer.") ||
        frame.type === "conversation.item.input_audio_transcription.completed")
    )
      return;
    const id = frame.response_id ?? frame.response?.id;
    if (frame.type === "response.created" && this.responses.has(id)) return;
    this.controller?.event(frame);
    if (frame.type === "session.created") {
      if (frame.session?.audio?.input?.format?.rate !== 8000)
        throw Error("Unsupported negotiated input rate");
      const rate = frame.session?.audio?.output?.format?.rate;
      this.encoder = new MuLawEncoder(rate);
      this.outputRate = rate;
      this.context.conversation_id = frame.session.conversation_id;
      await this.persist();
      await this.bindConversation();
      for (const pcm of this.inputQueue ?? [])
        this.voice.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: pcm.toString("base64"),
          }),
        );
      this.inputQueue = [];
      this.inputQueuedBytes = 0;
      this.voiceReady = true;
      this.voiceReadyResolve?.(true);
    } else if (frame.type === "response.created") {
      if (this.responses.has(id)) return;
      for (const [previousId, previous] of this.responses)
        if (previous.waitingForQuiet && !previous.finalized)
          this.completeBufferedResponse(previousId, previous, false);
      if (this.responses.size >= 64) {
        for (const [key, value] of this.responses) {
          if (
            key !== this.controller.responseId &&
            (value.completed || value.suppressed)
          )
            this.responses.delete(key);
          if (this.responses.size < 48) break;
        }
        if (this.responses.size >= 64) throw Error("Response state limit");
      }
      this.responses.set(id, {
        text: "",
        bytes: 0,
        rendered: 0,
        chunks: [],
        createdAt: this.now(),
        suppressed: this.modelMustRemainSilent(),
        blockReason: this.modelMustRemainSilent()
          ? "dialogue_or_control_gate"
          : null,
      });
      if (
        !this.context.initial_dialogue_response &&
        this.context.dialogue_candidate_observed &&
        !this.responses.get(id).suppressed
      )
        this.context.initial_dialogue_response = { id, started_at: this.now() };
      if (this.responses.get(id).suppressed) {
        if (this.voice?.readyState === 1)
          this.voice.send(
            JSON.stringify({ type: "response.cancel", response_id: id }),
          );
        this.controller?.event({
          type: "assistant_completed",
          text: "",
          no_audio: true,
        });
      }
    } else if (
      frame.type === "conversation.item.input_audio_transcription.completed"
    ) {
      const active =
        this.controller?.responseActive ||
        this.marks?.pending.size > 0 ||
        this.controller?.playback.remaining(this.now()) > 0;
      if (active && !isBackchannel(this.controller.inputText)) {
        if (this.voice?.readyState === 1)
          this.voice.send(JSON.stringify({ type: "response.cancel" }));
        this.marks.clear((m) => this.sendMedia(m));
        this.encoder = new MuLawEncoder(this.outputRate);
        this.controller.event({ type: "response.cancelled" });
      }
    } else if (
      ["response.output_audio.delta", "response.audio.delta"].includes(
        frame.type,
      )
    ) {
      if (this.controller.closing || this.controller.closed) return;
      const bytes = Buffer.from(frame.delta, "base64");
      const response = this.responses.get(id);
      if (!response || response.completed || response.finalized) return;
      response.firstAudioAt ??= this.now();
      response.bytes += bytes.length;
      if (this.modelMustRemainSilent()) response.suppressed = true;
      if (response.suppressed) return;
      if (response.bytes > this.outputRate * 2 * this.speechLimit()) {
        await this.rejectSpokenResponse(id, "utterance_length_limit");
        return;
      }
      // Audio and transcript deltas have no trusted word-level alignment.
      // Keep this short utterance private until its final transcript is checked.
      response.chunks.push(bytes);
    } else if (
      [
        "response.output_audio_transcript.delta",
        "response.audio_transcript.delta",
      ].includes(frame.type)
    ) {
      const response = this.responses.get(id);
      if (
        response &&
        !response.completed &&
        !response.finalized &&
        !response.guardRejected
      ) {
        response.firstTextAt ??= this.now();
        const delta = frame.delta ?? "";
        if (response.text.length + delta.length > 3000)
          await this.rejectSpokenResponse(id, "transcript_length_limit");
        else response.text += delta;
      }
    } else if (frame.type === "response.done") {
      const response = this.responses.get(id);
      if (!response || response.completed || response.finalized) return;
      response.completed = true;
      response.completedAt = this.now();
      if (frame.response?.status === "cancelled") {
        response.blockReason ??= "provider_cancelled";
        if (response.rendered && id === this.controller.responseId) {
          this.marks.clear((m) => this.sendMedia(m));
          this.controller.event({ type: "response.cancelled" });
        }
        this.completeBufferedResponse(id, response, false);
        if (id === this.controller.responseId)
          this.encoder = new MuLawEncoder(this.outputRate);
      } else if (response) {
        if (id !== this.controller.responseId) {
          response.blockReason ??= "superseded";
          this.completeBufferedResponse(id, response, false);
          return;
        }
        // Do not release model audio ahead of a fixed-speech cancellation.
        if (this.systemActions) await this.systemActions;
        if (this.ended || this.failing || id !== this.controller.responseId) {
          this.completeBufferedResponse(id, response, false);
          return;
        }
        response.suppressed ||= this.modelMustRemainSilent();
        const transcript = (frame.response?.output ?? [])
          .flatMap((item) =>
            (item.content ?? [])
              .filter(
                (c) =>
                  ["audio", "output_audio"].includes(c.type) &&
                  typeof c.transcript === "string",
              )
              .map((c) => c.transcript),
          )
          .join("\n");
        if (transcript) response.text = transcript;
        // The controller has already provided this non-task-bearing first turn.
        // Do not repeat it or play a model greeting generated before pickup.
        if (
          this.context.initial_ack &&
          !this.context.initial_ack.cancelled &&
          this.context.initial_dialogue_response?.id === id &&
          /^(?:はい[、,\s]*)?(?:よろしくお願いします|聞こえています)[。.!！\s]*$/.test(
            response.text,
          )
        ) {
          response.suppressed = true;
          response.blockReason = "system_initial_ack_duplicate";
        }
        if (
          this.env.CONTROLLED_FAREWELL === "true" &&
          !response.suppressed &&
          this.controller.recipientClosing &&
          /失礼(?:いた)?します[。.!！\s]*$/.test(response.text)
        )
          this.requestControlledStop("recipient_farewell");
        const violation =
          response.bytes && !response.suppressed
            ? frame.response?.status !== "completed"
              ? "incomplete_response"
              : speechViolation(response.text, { final: true })
            : null;
        if (violation) await this.rejectSpokenResponse(id, violation);
        if (!response.suppressed && response.chunks.length) {
          response.validated = true;
          // The transcript is final and immutable. Wait briefly for real quiet;
          // a raw acoustic tail must not permanently discard a safe first reply.
          // Meaningful new turns, holds, closure and newer responses still cancel.
          response.waitingForQuiet = true;
          response.quietDeadline = response.completedAt + 2000;
          this.flushBufferedResponses();
        } else this.completeBufferedResponse(id, response, false);
      }
    } else if (
      frame.type === "conversation.item.created" &&
      frame.item?.type === "function_call"
    ) {
      let args;
      try {
        args = JSON.parse(frame.item.arguments);
      } catch {
        args = null;
      }
      if (
        this.env.CONTROLLED_FAREWELL === "true" &&
        frame.item.name === "finish_call_after_goodbye"
      ) {
        this.context.controlled_close_requested = true;
        this.context.closing_request_response = this.controller.responseId;
      }
      const result = await this.controller.command(
        frame.item.call_id,
        frame.item.name,
        args,
      );
      if (["read_current_menu", "press_ivr_digit"].includes(frame.item.name)) {
        const c = this.controller;
        this.context.ivr_gate = {
          at: this.now(),
          tool: frame.item.name,
          ok: result.ok,
          reason: result.reason ?? null,
          snapshot_ready: c.menuSnapshotReady(),
          action_ready: c.menuReady(),
          known_ivr_replay: c.knownMenuReplay(),
          dispatch_guard: this.context.ivr_progress?.dispatch_guard ?? null,
          speaking: c.speaking,
          last_speech_gap_ms:
            c.lastSpeechEnd === null ? null : this.now() - c.lastSpeechEnd,
          menu_complete: !!c.menu?.complete,
          advertised_digits: c.menu?.digits ?? [],
          menu_age_ms: c.menu ? this.now() - c.menu.at : null,
          spent: !!c.menu?.spent,
          exact_token:
            frame.item.name === "press_ivr_digit"
              ? result.ok && this.context.ivr_dispatch?.exact_menu_token
                ? true
                : args?.menu_token === c.menu?.token
              : null,
          current_token_matches:
            frame.item.name === "press_ivr_digit"
              ? args?.menu_token === c.menu?.token
              : null,
        };
        this.context.ivr_gate_history = [
          ...(this.context.ivr_gate_history ?? []),
          {
            at: this.now(),
            tool: frame.item.name,
            ok: result.ok,
            reason: result.reason ?? null,
            exact_token: this.context.ivr_gate.exact_token,
            complete: !!c.menu?.complete,
            spent: !!c.menu?.spent,
          },
        ].slice(-4);
        // Diagnostic metadata is best effort and never part of consent, action
        // readiness or the tool response's provider deadline. No raw text/token.
        this.background(
          this.persist()
            .then(() => this.bindConversation(true))
            .catch(() => {}),
        );
      }
      if (frame.item.name === "finish_call_after_goodbye" && !result.ok)
        this.context.controlled_close_requested = false;
      if (
        frame.item.name === "finish_call_after_goodbye" &&
        result.ok &&
        this.env.CONTROLLED_FAREWELL === "true"
      )
        this.suppressCurrentResponse("controlled_farewell");
      if (
        this.env.CONTROLLED_FAREWELL === "true" &&
        ["RETRY_LIMIT", "MENU_LIMIT", "SENSITIVE_MENU"].includes(result.reason)
      ) {
        this.context.stop_reason = result.reason.toLowerCase();
        this.context.controlled_close_requested = true;
        this.context.closing_request_response = this.controller.responseId;
        await this.persist();
        await this.controller.command(
          "stop:" + frame.item.call_id,
          "finish_call_after_goodbye",
          { outcome: "unable_to_proceed" },
        );
      }
      if (
        frame.item.name === "finish_call_after_goodbye" &&
        result.ok &&
        this.controller.farewell &&
        this.env.CONTROLLED_FAREWELL !== "true"
      )
        return;
      if (this.voice?.readyState === 1)
        this.voice.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: frame.item.call_id,
              output: JSON.stringify(result),
            },
          }),
        );
    } else if (
      frame.type === "error" &&
      frame.error?.code !== "conversation_ended"
    )
      throw Error("Voice provider error");
  }
  async forwardInsight(request) {
    await this.load();
    if (!this.context?.call_id)
      return json({ received: true, ignored_prewarm: true });
    await this.bindConversation();
    return this.env.PHONE_API.fetch(
      "https://phone.internal/webhooks/telnyx/insights",
      { method: "POST", headers: request.headers, body: await request.text() },
    );
  }
  async callback(status, duration) {
    const fields = new URLSearchParams({
      CallSid: this.context.call_id,
      CallStatus: status,
      ...(duration !== undefined ? { CallDuration: String(duration) } : {}),
    });
    const r = await this.env.PHONE_API.fetch(
      "https://phone.internal/webhooks/outbound-status/" +
        this.context.request_id +
        "/" +
        this.context.callback_token,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: fields,
      },
    );
    if (!r.ok) throw Error("Status delivery failed");
  }
  async onWebhook(event) {
    if (this.webhookOperations.has(event.id))
      return this.webhookOperations.get(event.id);
    const pending = this.processWebhook(event);
    this.webhookOperations.set(event.id, pending);
    try {
      return await pending;
    } finally {
      this.webhookOperations.delete(event.id);
    }
  }
  async processWebhook(event) {
    await this.load();
    if (!this.context) return json({ error: "Unknown call" }, 404);
    if (String(event.payload?.connection_id) !== String(this.env.VOICE_APP_ID))
      return json({ error: "Connection mismatch" }, 403);
    const payload = event.payload ?? {},
      state = parseState(payload.client_state);
    if (
      !state ||
      state.request_id !== this.context.request_id ||
      state.nonce !== this.context.nonce
    )
      return json({ error: "Webhook context mismatch" }, 403);
    if (payload.call_leg_id) {
      if (
        this.context.call_leg_id &&
        this.context.call_leg_id !== payload.call_leg_id
      )
        return json({ error: "Call leg mismatch" }, 403);
      this.context.call_leg_id = payload.call_leg_id;
    }
    await this.bindCall(payload.call_control_id);
    if (
      (this.context.terminal_at || this.context.close_dispatched) &&
      event.event_type !== "call.hangup"
    )
      return json({ received: true, ignored: true });
    if (await this.storage.get("event/" + event.id))
      return json({ received: true, duplicate: true });
    if (event.event_type === "call.answered") {
      this.context.answered_at ??= event.occurred_at;
      this.silence.activity();
      await this.persist();
      await this.callback("answered");
      if (this.context.failure)
        this.background(this.fail(this.context.failure));
    } else if (event.event_type === "call.initiated")
      this.background(
        this.openVoice().catch(() => this.fail("voice_startup_failed")),
      );
    else if (event.event_type === "call.hangup") {
      const duration = this.context.answered_at
        ? Math.max(
            0,
            Math.floor(
              (Date.parse(event.occurred_at) -
                Date.parse(this.context.answered_at)) /
                1000,
            ),
          )
        : 0;
      await this.callback(
        this.context.failure
          ? "failed"
          : statusForEnd(payload, !!this.context.answered_at),
        Number.isFinite(duration) ? duration : undefined,
      );
      if (this.context.failure === "ivr_transition_timeout")
        await this.env.DB.prepare(
          "UPDATE outbound_requests SET last_error = ? WHERE id = ? AND callback_token = ? AND telnyx_call_id = ? AND status = 'failed'",
        )
          .bind(
            this.context.failure,
            this.context.request_id,
            this.context.callback_token,
            this.context.call_id,
          )
          .run();
      await this.recordEvent("hangup_completed", "call-termination", {
        hangup_source: ["caller", "callee"].includes(payload.hangup_source)
          ? payload.hangup_source
          : "unknown",
        outcome: this.context.close_outcome ?? "unspecified",
      });
      this.context.terminal_at = event.occurred_at;
      await this.persist();
      this.ended = true;
      this.cleanup();
      // Remote hangup also publishes the latest audit. Status delivery above
      // remains successful if this optional metadata service is unavailable.
      await this.bindConversation(true).catch(() => {});
    } else if (
      event.event_type === "call.speak.ended" &&
      this.context.initial_ack?.state === payload.client_state &&
      !this.context.initial_ack.cancelled &&
      payload.status === "completed"
    ) {
      this.context.initial_ack.completed_at ??= this.now();
      this.silence.activity();
      await this.persist();
      this.flushBufferedResponses();
    } else if (
      event.event_type === "call.speak.ended" &&
      this.context.attention?.state === payload.client_state &&
      !this.context.attention.cancelled &&
      payload.status === "completed"
    ) {
      this.context.attention.completed = true;
      clearTimeout(this.attentionDeadline);
      this.silence.checkCompleted();
      await this.recordEvent("silence_attention_completed", "once");
      await this.persist();
    } else if (
      event.event_type === "call.speak.ended" &&
      this.context.controlled_closing?.state === payload.client_state &&
      !this.context.controlled_closing.cancelled &&
      payload.status === "completed"
    ) {
      this.context.system_farewell_played = true;
      this.context.controlled_closing.completed = true;
      this.observeClosurePhase("farewell_completed");
      clearTimeout(this.controlledFarewellDeadline);
      await this.persist();
      this.controller?.event({ type: "system_farewell_completed" });
    } else if (
      event.event_type === "call.speak.ended" &&
      this.context.fallback_state &&
      payload.client_state === this.context.fallback_state &&
      payload.status === "completed"
    ) {
      await this.finishFallback();
    }
    await this.storage.put("event/" + event.id, true);
    return json({ received: true });
  }
  async disconnected() {
    if (this.ended) return;
    await this.load();
    if (!this.context?.call_id) {
      this.cleanup();
      return;
    }
    try {
      const r = await this.providerFetch(
        "https://api.telnyx.com/v2/calls/" +
          encodeURIComponent(this.context.call_id),
        {
          headers: { Authorization: "Bearer " + this.env.TELNYX_API_KEY },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        },
      );
      const body = r.ok ? await r.json() : null;
      if (body?.data?.is_alive === false) {
        this.ended = true;
        this.cleanup();
        return;
      }
    } catch {}
    await this.fail("media_disconnected");
  }
  async fail(reason) {
    if (this.ended || this.failing) return;
    this.failing = true;
    await this.load();
    if (!this.context) {
      this.cleanup();
      return;
    }
    this.context.failure ??= reason;
    if (this.controller) this.controller.closing = true;
    if (!this.context.call_id) {
      await this.persist();
      this.cleanup();
      this.failing = false;
      return;
    }
    if (!this.context.answered_at) {
      await this.persist();
      this.failing = false;
      return;
    }
    this.context.fallback_state ??= Buffer.from(
      JSON.stringify({
        request_id: this.context.request_id,
        nonce: this.context.nonce,
        phase: "fallback",
        token: uuid(),
      }),
    ).toString("base64");
    await this.persist();
    try {
      await this.bindConversation(true);
    } catch {
      /* Closing must not depend on summary metadata availability. */
    }
    // This is an outbound-only Voice API call, never a TeXML/AI-managed call.
    if (this.voice?.readyState === 1) this.voice.close();
    if (this.media?.readyState === 1)
      this.marks?.clear((m) => this.sendMedia(m));
    await this.voiceAPI(
      "speak",
      {
        payload:
          reason === "ivr_transition_timeout"
            ? "操作後の応答を確認できませんでしたので、失礼いたします。"
            : "申し訳ございません。接続に問題があるため、失礼いたします。",
        payload_type: "text",
        voice: "female",
        language: "ja-JP",
        client_state: this.context.fallback_state,
      },
      "technical-farewell",
    );
    // One shared idempotency key for callback and deadline; never duplicate hangup.
    if (!this.ended)
      this.fallbackDeadline = setTimeout(
        () => this.background(this.finishFallback()),
        20000,
      );
  }
  cleanup() {
    clearInterval(this.timer);
    clearInterval(this.inputPump);
    clearInterval(this.sttKeepAlive);
    clearInterval(this.voiceHeartbeat);
    try {
      this.stt?.close();
    } catch {}
    clearTimeout(this.deadline);
    clearTimeout(this.orphanTimer);
    clearTimeout(this.cleanupDelay);
    clearTimeout(this.mediaStopTimer);
    clearTimeout(this.fallbackDeadline);
    clearTimeout(this.attentionDeadline);
    clearTimeout(this.controlledFarewellDeadline);
    this.turns?.close();
    for (const [id, response] of this.responses) {
      if (!response.finalized) {
        response.blockReason ??= response.completed
          ? "call_ended_before_release"
          : "call_ended_before_response_done";
        this.completeBufferedResponse(id, response, false);
      }
      response.chunks = [];
    }
    try {
      this.voice?.close();
    } catch {}
    try {
      this.media?.close();
    } catch {}
  }
}
