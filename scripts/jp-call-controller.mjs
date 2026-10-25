// Transport-independent action gate. State events must come from the authenticated
// media adapter, never from model arguments. Production uses signed Telnyx media.
import { createHash, randomUUID } from "node:crypto";
import { isBackchannel } from "./jp-backchannel.mjs";
import { PlaybackClock } from "./jp-playback-clock.mjs";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const normalize = (text) =>
  text
    .normalize("NFKC")
    .replace(/[一二三四五六七八九〇]/g, (c) =>
      String("〇一二三四五六七八九".indexOf(c)),
    );
const terminal = new Set([
  "confirmed",
  "refused",
  "wrong_number",
  "unable_to_proceed",
]);
export class CallController {
  constructor({
    sendDigit,
    close,
    now = () => performance.now(),
    token = randomUUID,
    requirePlaybackAck = true,
    stripCumulativeHistory = true,
    playFarewell = null,
  }) {
    this.requirePlaybackAck = requirePlaybackAck;
    this.stripCumulativeHistory = stripCumulativeHistory;
    this.transportQueuePending = false;
    this.playFarewell = playFarewell;
    this.systemFarewellStarted = false;
    this.playbackAck = false;
    this.sendDigit = sendDigit;
    this.close = close;
    this.now = now;
    this.token = token;
    this.playback = new PlaybackClock();
    this.operations = new Map();
    this.operationInputs = new Map();
    this.readWaiters = [];
    this.selectionWaiters = [];
    this.acousticGuardUntil = 0;
    this.inputText = "";
    this.lastTranscript = null;
    this.lastRawTranscript = "";
    this.lastSelection = null;
    this.selections = new Map();
    this.depth = 0;
    this.menu = null;
    this.speaking = false;
    this.lastSpeechEnd = null;
    this.pending = null;
    this.farewell = null;
    this.responseActive = false;
    this.assistantQuestionPending = false;
    this.closed = false;
    this.closing = false;
  }
  event(e) {
    if (this.closed || this.closing) return;
    const at = this.now();
    if (e.type === "input_audio_buffer.speech_started") {
      this.speaking = true;
      this.suspendedClosing ??= {
        pending: this.pending,
        farewell: this.farewell,
        playbackAck: this.playbackAck,
      };
      this.playbackAck = false;
      this.pending = null;
      this.farewell = null;
    }
    if (e.type === "input_audio_buffer.speech_stopped") {
      this.speaking = false;
      this.lastSpeechEnd = at;
    }
    if (e.type === "conversation.item.input_audio_transcription.completed") {
      const raw = normalize(e.transcript ?? "");
      const old = this.lastRawTranscript;
      const cumulative =
        this.stripCumulativeHistory &&
        old &&
        raw.startsWith(old) &&
        /^[\s]+/.test(raw.slice(old.length)) &&
        /[。.!?]|押してください$/.test(old);
      const fragment = cumulative ? raw.slice(old.length).trimStart() : raw;
      this.lastRawTranscript = raw;
      if (this.lastTranscript === null || at - this.lastTranscript > 750)
        this.inputText = "";
      if (fragment.startsWith(this.inputText)) this.inputText = fragment;
      else if (!this.inputText.endsWith(fragment)) this.inputText += fragment;
      this.lastTranscript = at;
      const text = this.inputText;
      const previousMenu = this.menu;
      if (isBackchannel(text) && this.suspendedClosing) {
        this.pending = this.suspendedClosing.pending;
        this.farewell ??= this.suspendedClosing.farewell;
        this.playbackAck ||= this.suspendedClosing.playbackAck;
      }
      this.suspendedClosing = null;
      this.recipientClosing =
        /失礼(?:いた)?します|変更しました|承れません|間違い|できません|空いていません/.test(
          text,
        );
      this.closingBlocked =
        /お待ち|保留|確認します|質問があります|質問したい|その前|ちょっと待|hold|wait|question|[?？]/i.test(
          text,
        );
      const core = text.replace(
        /選択を確認できませんでした[。\s]*|もう一度|もう1度|再度/g,
        "",
      );
      this.menu = {
        at,
        isIvr: /押|選択|入力|メニュー|お選び|press|dial/i.test(text),
        text,
        token: this.token(),
        core: digest(core.replace(/[。、,.\s]/g, "")),
        spent: false,
        complete:
          /押してください|選択してください|入力してください|お選びください|press|dial/i.test(
            text,
          ),
        retry:
          /確認できません|もう一度|もう1度|再度|再入力|again|invalid/i.test(
            text,
          ),
        digits: [
          ...new Set(
            [...text.matchAll(/([0-9*#])(?:番)?(?:を|に|です|[、,]|\s)/g)].map(
              (m) => m[1],
            ),
          ),
        ],
      };
      const genericReplayIntro =
        /選択|メニュー|お選び|menu|select/i.test(fragment) &&
        !/([0-9*#])(?:番)?(?:を|に|です|[、,]|\s)/.test(fragment);
      if (
        previousMenu?.complete &&
        previousMenu.digits.length &&
        !previousMenu.spent &&
        at - previousMenu.at < 30000 &&
        (genericReplayIntro || this.menu.core === previousMenu.core)
      ) {
        // The original completed choice snapshot stays immutable through a replay intro.
        this.menu = previousMenu;
        this.inputText = previousMenu.text;
      }
    }
    if (e.type === "system_farewell_completed") {
      this.farewell = { at };
      this.playbackAck = true;
      this.responseActive = false;
    }
    if (e.type === "system_farewell_cancelled") {
      this.systemFarewellStarted = false;
      this.pending = null;
      this.farewell = null;
      this.playbackAck = false;
      this.suspendedClosing = null;
    }
    if (e.type === "response.created") {
      this.responseActive = true;
      this.playbackAck = false;
      this.responseId = e.response?.id;
    }
    if (e.type === "playback_confirmed" && e.responseId === this.responseId)
      this.playbackAck = true;
    if (e.type === "response.cancelled") {
      this.suspendedClosing = null;
      this.responseActive = false;
      this.farewell = null;
      this.playback.clear(at);
    }
    if (e.type === "assistant_audio") this.playback.append(e.bytes, e.rate, at);
    if (e.type === "assistant_completed") {
      this.responseActive = false;
      if (e.no_audio) this.playbackAck = true;
      this.assistantQuestionPending = /でしょうか|ですか|ますか|[?？]/.test(
        e.text ?? "",
      );
      if (this.assistantQuestionPending) this.farewell = null;
    }
    if (
      e.type === "assistant_completed" &&
      /失礼(?:いた)?します|失礼いたします/.test(e.text ?? "")
    ) {
      this.farewell = { at };
      if (
        !this.pending &&
        !this.closingBlocked &&
        this.recipientClosing &&
        /失礼(?:いた)?します[。.!！\s]*$/.test(e.text ?? "")
      ) {
        // A call may end without establishing whether the task succeeded.
        this.pending = {
          outcome: "unspecified",
          reason: "completed_farewell_silence_fallback",
        };
      }
    }
  }
  async command(id, name, args) {
    if (typeof id !== "string" || !id)
      return { ok: false, reason: "INVALID_OPERATION_ID" };
    const input = JSON.stringify([
      name,
      args && typeof args === "object" && !Array.isArray(args)
        ? Object.fromEntries(
            Object.entries(args).sort(([a], [b]) => a.localeCompare(b)),
          )
        : args,
    ]);
    if (this.operations.has(id))
      return this.operationInputs.get(id) === input
        ? this.operations.get(id)
        : { ok: false, reason: "OPERATION_CONFLICT" };
    if (this.closed || this.closing) return { ok: false, reason: "CLOSED" };
    if (this.operations.size >= 64)
      return { ok: false, reason: "TOOL_REQUEST_LIMIT" };
    this.operationInputs.set(id, input);
    if (
      name === "read_current_menu" &&
      args &&
      !Array.isArray(args) &&
      Object.keys(args).length === 0 &&
      !this.menuReady()
    ) {
      const work = new Promise((resolve) =>
        this.readWaiters.push({ resolve, deadline: this.now() + 4000 }),
      );
      this.operations.set(id, work);
      return work;
    }
    if (
      name === "press_ivr_digit" &&
      this.speaking &&
      args &&
      Object.keys(args).sort().join(",") === "digits,menu_token" &&
      /^[0-9*#]$/.test(args.digits) &&
      this.menu?.token === args.menu_token &&
      !this.menu.spent
    ) {
      const work = new Promise((resolve) =>
        this.selectionWaiters.push({
          resolve,
          args,
          id,
          deadline: this.now() + 8000,
        }),
      );
      this.operations.set(id, work);
      return work;
    }
    const work = this.execute(name, args, id);
    this.operations.set(id, work);
    return work;
  }
  async execute(name, args, operationId) {
    if (this.closed || this.closing) return { ok: false, reason: "CLOSED" };
    if (this.systemFarewellStarted && name !== "read_current_menu")
      return { ok: false, reason: "CLOSING_PENDING" };
    if (!args || Array.isArray(args) || typeof args !== "object")
      return { ok: false, reason: "INVALID_ARGUMENTS" };
    if (name === "read_current_menu") {
      if (Object.keys(args).length)
        return { ok: false, reason: "INVALID_ARGUMENTS" };
      if (!this.menuReady()) return { ok: false, reason: "MENU_NOT_COMPLETE" };
      return {
        ok: true,
        menu: this.menu.text,
        menu_token: this.menu.token,
        advertised_digits: this.menu.digits,
      };
    }
    if (name === "press_ivr_digit") {
      if (
        Object.keys(args).sort().join(",") !== "digits,menu_token" ||
        typeof args.digits !== "string" ||
        !/^[0-9*#]$/.test(args.digits)
      )
        return { ok: false, reason: "INVALID_ARGUMENTS" };
      const m = this.menu;
      if (!this.menuReady() || !m || m.token !== args.menu_token)
        return {
          ok: false,
          reason: "STALE_OR_INCOMPLETE_MENU",
          ...(this.menuReady()
            ? {
                current_menu: {
                  text: m.text,
                  menu_token: m.token,
                  advertised_digits: m.digits,
                },
                action_not_executed: true,
              }
            : {}),
        };
      if (m.spent) return { ok: false, reason: "MENU_ALREADY_USED" };
      if (
        /暗証|認証コード|パスワード|電話番号|会員番号|口座|予約番号|お客様番号|本人確認|PIN|password|OTP|account|phone number/i.test(
          m.text,
        )
      )
        return { ok: false, reason: "SENSITIVE_MENU" };
      const selected = m.text
        .split(/[、。,.\n]/)
        .filter((part) => part.includes(args.digits))
        .join(" ");
      if (/支払|購入|クレジット|payment|purchase|credit/i.test(selected))
        return { ok: false, reason: "SENSITIVE_MENU" };
      if (!m.digits.includes(args.digits))
        return { ok: false, reason: "DIGIT_NOT_ADVERTISED" };
      const key =
          m.retry && this.lastSelection?.digits === args.digits
            ? this.lastSelection.key
            : m.core + ":" + args.digits,
        count = this.selections.get(key) ?? 0;
      if (this.depth >= 5) return { ok: false, reason: "MENU_LIMIT" };
      if (count >= 2 || (count > 0 && !m.retry))
        return { ok: false, reason: "RETRY_LIMIT" };
      // Reserve before awaiting any side effect: concurrent or uncertain requests
      // cannot execute the same selection again.
      m.spent = true;
      this.inputText = "";
      this.lastTranscript = null;
      this.depth++;
      this.selections.set(key, count + 1);
      this.lastSelection = { key, digits: args.digits };
      try {
        return await this.sendDigit(args.digits, { operationId });
      } catch {
        return { ok: false, reason: "DELIVERY_UNCONFIRMED_DO_NOT_RETRY" };
      }
    }
    if (name === "finish_call_after_goodbye") {
      if (
        Object.keys(args).join(",") !== "outcome" ||
        !terminal.has(args.outcome)
      )
        return { ok: false, reason: "INVALID_ARGUMENTS" };
      if (this.speaking) return { ok: false, reason: "RECIPIENT_SPEAKING" };
      if (this.closingBlocked)
        return { ok: false, reason: "HOLD_OR_QUESTION_PENDING" };
      if (
        args.outcome === "unable_to_proceed" &&
        this.menu?.isIvr &&
        !this.menu.digits.length &&
        !/暗証|認証|パスワード|PIN|OTP|payment|支払/i.test(this.menu.text)
      )
        return { ok: false, reason: "MENU_NOT_COMPLETE" };
      this.pending = { outcome: args.outcome, operationId };
      return {
        ok: true,
        status: "CLOSURE_PENDING_FINISH_FAREWELL_THEN_REMAIN_SILENT",
      };
    }
    return { ok: false, reason: "UNKNOWN_ACTION" };
  }
  menuReady() {
    return (
      !this.speaking &&
      !!this.menu?.complete &&
      (this.menu.digits.length > 0 ||
        /暗証|認証|パスワード|PIN|OTP/i.test(this.menu.text)) &&
      this.now() - this.menu.at < 30000 &&
      this.lastSpeechEnd !== null &&
      this.now() - this.lastSpeechEnd >= 750
    );
  }
  async tick() {
    const at = this.now();
    const waiting = this.readWaiters;
    this.readWaiters = [];
    for (const w of waiting) {
      if (this.menuReady())
        w.resolve(await this.execute("read_current_menu", {}));
      else if (at >= w.deadline)
        w.resolve({ ok: false, reason: "MENU_NOT_COMPLETE" });
      else this.readWaiters.push(w);
    }
    const selections = this.selectionWaiters;
    this.selectionWaiters = [];
    for (const w of selections) {
      if (this.closed || this.closing)
        w.resolve({ ok: false, reason: "CLOSED" });
      else if (this.menu?.token !== w.args.menu_token)
        w.resolve({ ok: false, reason: "STALE_OR_INCOMPLETE_MENU" });
      else if (this.menuReady())
        w.resolve(await this.execute("press_ivr_digit", w.args, w.id));
      else if (at >= w.deadline)
        w.resolve({ ok: false, reason: "MENU_NOT_COMPLETE" });
      else this.selectionWaiters.push(w);
    }
    if (
      !this.pending ||
      this.closed ||
      this.closing ||
      this.speaking ||
      this.selectionWaiters.length > 0 ||
      at < this.acousticGuardUntil ||
      (this.requirePlaybackAck && !this.playbackAck) ||
      this.responseActive ||
      this.assistantQuestionPending ||
      this.closingBlocked ||
      (!this.farewell && !this.playFarewell) ||
      this.transportQueuePending ||
      this.lastSpeechEnd === null
    )
      return false;
    if (
      at - this.lastSpeechEnd < 750 ||
      at - this.playback.end < 250 ||
      (this.farewell && at - this.farewell.at < 250)
    )
      return false;
    if (this.playFarewell && !this.farewell) {
      if (!this.systemFarewellStarted) {
        this.systemFarewellStarted = true;
        this.playbackAck = false;
        await this.playFarewell(this.pending.outcome, {
          operationId:
            this.pending.operationId ?? "controlled-close:" + this.responseId,
        });
      }
      return false;
    }
    this.closing = true;
    try {
      await this.close(this.pending.outcome, {
        operationId: this.pending.operationId ?? "farewell:" + this.responseId,
      });
      this.closed = true;
      return true;
    } finally {
      this.pending =
        null; /* unknown close result is not automatically retried */
    }
  }
}
