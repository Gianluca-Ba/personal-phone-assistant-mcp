import { MediaActivity, SttTurns, genuineInterruption } from "./turns.mjs";
import { isBackchannel } from "../../../scripts/jp-backchannel.mjs";
import { CallController } from "../../../scripts/jp-call-controller.mjs";
import { PlaybackMarks } from "../../../scripts/jp-playback-marks.mjs";
import { decodeMuLaw, MuLawEncoder } from "./audio.mjs";
import { dialPayload, taskFingerprint, statusForEnd } from "./contract.mjs";
import { sha256, sameSecret, parseState } from "./security.mjs";
const json = (body, status = 200) => Response.json(body, { status });
const uuid = () => crypto.randomUUID();
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
    { providerFetch = fetch, now = () => Date.now() } = {},
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
  }
  async load() {
    this.context ??= await this.storage.get("context");
    return this.context;
  }
  async register(body) {
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
      const r = await this.providerFetch(
        "https://api.telnyx.com/v2/ai/assistants/" +
          encodeURIComponent(this.env.OUTBOUND_ASSISTANT_ID),
        {
          headers: { Authorization: "Bearer " + this.env.TELNYX_API_KEY },
          redirect: "error",
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
        await Promise.all([
          this.openVoice(),
          ...(this.env.EXTERNAL_STT === "true" ? [this.openStt()] : []),
        ]);
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
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      result = {
        ok: r.ok,
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
  async bindConversation(force = false) {
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
            transcript_source:
              this.env.EXTERNAL_STT === "true"
                ? "external_stt_flux_multi"
                : "voice_assistant",
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!r.ok) throw Error("Conversation binding failed");
    this.context.metadata_prebound = true;
    this.context.metadata_bound = !!this.context.call_id;
    await this.persist();
  }
  async terminate(outcome, operation) {
    this.context.close_outcome = outcome;
    await this.bindConversation(true);
    await this.persist();
    const result = await this.voiceAPI("hangup", {}, operation);
    if (!result.ok) throw Error("Hangup unconfirmed");
    this.ended = true;
    clearInterval(this.inputPump);
    clearInterval(this.timer);
    try {
      this.media?.close();
    } catch {}
    this.cleanupDelay = setTimeout(() => this.cleanup(), 15000);
  }
  async playControlledFarewell(outcome, op) {
    const state = Buffer.from(
      JSON.stringify({
        request_id: this.context.request_id,
        nonce: this.context.nonce,
        phase: "closing",
        token: uuid(),
      }),
    ).toString("base64");
    this.context.controlled_closing = { state, outcome, cancelled: false };
    await this.persist();
    const result = await this.voiceAPI(
      "speak",
      {
        payload: "ありがとうございます。失礼いたします。",
        payload_type: "text",
        voice: "female",
        language: "ja-JP",
        client_state: state,
      },
      "closing:" + op.operationId,
    );
    if (!result.ok) throw Error("Farewell playback unconfirmed");
  }
  async cancelControlledFarewell() {
    this.context.controlled_close_requested = false;
    const current = this.context.controlled_closing;
    if (!current || current.cancelled || this.context.close_dispatched) return;
    const alreadyPlayed = this.context.system_farewell_played;
    this.context.system_farewell_played = false;
    current.cancelled = true;
    await this.persist();
    this.controller.event({ type: "system_farewell_cancelled" });
    if (!alreadyPlayed)
      await this.voiceAPI(
        "playback_stop",
        { stop: "all" },
        "cancel-closing:" + sha256(current.state),
      );
  }
  async openStt() {
    if (this.stt) return;
    const query = new URLSearchParams({
      transcription_engine: "Deepgram",
      model: "flux-multi",
      input_format: "mulaw",
      sample_rate: "8000",
      language: "ja",
      interim_results: "true",
      eot_threshold: "0.8",
      eot_timeout_ms: "2000",
    });
    const r = await this.providerFetch(
      "https://api.telnyx.com/v2/speech-to-text/transcription?" + query,
      {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer " + this.env.TELNYX_API_KEY,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (r.status !== 101 || !r.webSocket)
      throw Error("Speech recognition unavailable");
    this.stt = r.webSocket;
    this.stt.accept();
    this.stt.addEventListener("message", (e) => {
      try {
        this.turns?.accept(JSON.parse(e.data));
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
    if (
      this.context.controlled_closing &&
      !this.context.controlled_closing.cancelled
    )
      return true;
    return (
      !!this.controller &&
      (this.controller.playback.remaining(this.now()) > 0 ||
        this.marks?.pending.size > 0 ||
        (this.controller.responseActive &&
          this.responses.get(this.controller.responseId)?.bytes > 0))
    );
  }
  cancelOutput() {
    if (this.cancelledForTurn) return;
    this.cancelledForTurn = true;
    const previous = this.responses.get(this.controller.responseId);
    if (previous) previous.suppressed = true;
    if (
      this.context.controlled_closing &&
      !this.context.controlled_closing.cancelled
    )
      this.background(this.cancelControlledFarewell());
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
  beginTurn() {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.overlapped = this.speakingOutput();
    this.cancelledForTurn = false;
    this.controller.event({ type: "input_audio_buffer.speech_started" });
  }
  deliverTranscript(text) {
    if (this.ended || this.failing) return;
    if (this.controller.speaking)
      this.controller.event({ type: "input_audio_buffer.speech_stopped" });
    this.controller.event({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: text,
    });
    const listening = this.overlapped && isBackchannel(text);
    if (
      !listening &&
      (this.overlapped ||
        this.speakingOutput() ||
        this.controller.responseActive)
    )
      this.cancelOutput();
    this.context.filtered_aizuchi =
      (this.context.filtered_aizuchi ?? 0) + (listening ? 1 : 0);
    this.turnOpen = false;
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
    const r = await this.providerFetch(
      "https://api.telnyx.com/v2/ai/assistants/" +
        encodeURIComponent(this.env.OUTBOUND_ASSISTANT_ID) +
        "/conversation?input_sample_rate=8000&output_sample_rate=8000",
      {
        headers: {
          Upgrade: "websocket",
          Authorization: "Bearer " + this.env.TELNYX_API_KEY,
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
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
              outbound_task: this.context.instructions,
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
      playFarewell:
        this.env.CONTROLLED_FAREWELL === "true"
          ? (outcome, op) => this.playControlledFarewell(outcome, op)
          : null,
      sendDigit: async (digits, op) =>
        this.voiceAPI("send_dtmf", { digits }, op.operationId),
      close: async (outcome, op) => this.terminate(outcome, op.operationId),
    });
    this.marks = new PlaybackMarks({
      sendMark: (m) => this.sendMedia(m),
      onPlayed: (responseId) =>
        this.controller.event({ type: "playback_confirmed", responseId }),
    });
    if (this.env.EXTERNAL_STT === "true") {
      this.activity = new MediaActivity({
        now: this.now,
        onStart: () => this.beginTurn(),
        onStop: () => {
          this.controller.event({ type: "input_audio_buffer.speech_stopped" });
          if (this.pendingTranscript) {
            const text = this.pendingTranscript;
            this.pendingTranscript = null;
            this.deliverTranscript(text);
          }
        },
      });
      this.turns = new SttTurns({
        onStart: () => this.beginTurn(),
        onInterim: (text) => {
          if (this.overlapped && genuineInterruption(text)) this.cancelOutput();
        },
        onFinal: (text) => {
          this.deliverTranscript(text);
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
        if (this.stt?.readyState === 1) this.stt.send(frame);
      }, 20);
    }
    this.timer = setInterval(() => {
      this.controller.transportQueuePending = this.marks.pending.size > 0;
      void this.controller.tick().catch(() => this.fail("controller_failed"));
    }, 50);
    this.deadline = setTimeout(() => this.fail("media_deadline"), 330000);
  }
  sendMedia(frame) {
    if (!this.ended && !this.streamingStopped && this.media?.readyState === 1)
      this.media.send(JSON.stringify(frame));
  }
  async onMedia(frame) {
    if (this.ended) return;
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
    this.controller?.event(frame);
    const id = frame.response_id ?? frame.response?.id;
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
      this.responses.set(id, {
        text: "",
        bytes: 0,
        rendered: 0,
        suppressed:
          this.controller?.menu?.complete ||
          /暗証|認証コード|パスワード|本人確認|PIN|OTP/i.test(
            this.controller?.inputText ?? "",
          ) ||
          (this.context.controlled_closing &&
            !this.context.controlled_closing.cancelled) ||
          (this.context.controlled_close_requested &&
            id !== this.context.closing_request_response),
      });
      if (this.responses.get(id).suppressed)
        this.controller?.event({
          type: "assistant_completed",
          text: "",
          no_audio: true,
        });
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
      if (!response) throw Error("Uncorrelated audio");
      response.bytes += bytes.length;
      if (
        (this.activity?.active && !this.overlapped) ||
        (this.context.controlled_closing &&
          !this.context.controlled_closing.cancelled)
      )
        response.suppressed = true;
      if (response.suppressed) return;
      response.rendered += bytes.length;
      this.controller.event({
        type: "assistant_audio",
        bytes: bytes.length,
        rate: this.outputRate,
      });
      for (const pcmu of this.encoder.append(bytes))
        this.sendMedia({
          event: "media",
          media: { payload: pcmu.toString("base64") },
        });
    } else if (
      [
        "response.output_audio_transcript.delta",
        "response.audio_transcript.delta",
      ].includes(frame.type)
    ) {
      const response = this.responses.get(id);
      if (response) response.text += frame.delta ?? "";
    } else if (frame.type === "response.done") {
      const response = this.responses.get(id);
      if (frame.response?.status === "cancelled") {
        if (id !== this.controller.responseId) return;
        this.marks.clear((m) => this.sendMedia(m));
        this.controller.event({ type: "response.cancelled" });
        this.encoder = new MuLawEncoder(this.outputRate);
      } else if (response) {
        for (const pcmu of this.encoder.drain(true))
          this.sendMedia({
            event: "media",
            media: { payload: pcmu.toString("base64") },
          });
        this.controller.event({
          type: "assistant_completed",
          text: response.suppressed ? "" : response.text,
          no_audio: !response.rendered,
        });
        this.marks.commit(id, response.rendered > 0);
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
      if (frame.item.name === "finish_call_after_goodbye" && !result.ok)
        this.context.controlled_close_requested = false;
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
      this.context.terminal_at = event.occurred_at;
      await this.persist();
      this.ended = true;
      this.cleanup();
    } else if (
      event.event_type === "call.speak.ended" &&
      this.context.controlled_closing?.state === payload.client_state &&
      !this.context.controlled_closing.cancelled &&
      payload.status === "completed"
    ) {
      this.context.system_farewell_played = true;
      await this.persist();
      this.controller?.event({ type: "system_farewell_completed" });
    } else if (
      event.event_type === "call.speak.ended" &&
      this.context.fallback_state &&
      payload.client_state === this.context.fallback_state &&
      payload.status === "completed"
    ) {
      await this.voiceAPI("hangup", {}, "fallback-completed");
      this.ended = true;
      this.cleanup();
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
          redirect: "error",
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
    this.context.failure = reason;
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
    // This is an outbound-only Voice API call, never a TeXML/AI-managed call.
    if (this.voice?.readyState === 1) this.voice.close();
    if (this.media?.readyState === 1)
      this.marks?.clear((m) => this.sendMedia(m));
    const result = await this.voiceAPI(
      "speak",
      {
        payload: "申し訳ございません。接続に問題があるため、失礼いたします。",
        payload_type: "text",
        voice: "female",
        language: "ja-JP",
        client_state: this.context.fallback_state,
      },
      "technical-farewell",
    );
    if (!result.ok) {
      /* The provider's 300-second call limit remains the final bound. */
    }
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
    try {
      this.voice?.close();
    } catch {}
    try {
      this.media?.close();
    } catch {}
  }
}
