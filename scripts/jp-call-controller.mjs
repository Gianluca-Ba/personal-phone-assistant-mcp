// Transport-independent action gate. State events must come from the authenticated
// media adapter, never from model arguments. Production uses signed Telnyx media.
import { createHash, randomUUID } from "node:crypto";
import {
  isBackchannel,
  isHoldRequest,
  isHoldReturn,
  isHoldFiller,
  isRoutingHold,
} from "./jp-backchannel.mjs";
import { PlaybackClock } from "./jp-playback-clock.mjs";
import { normalizeMenuTranscript } from "./jp-menu-text.mjs";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const normalize = normalizeMenuTranscript;
const terminal = new Set([
  "confirmed",
  "refused",
  "wrong_number",
  "unable_to_proceed",
]);
// Telnyx ends a client-side tool after 5 seconds. Return a bounded pending
// observation before that deadline; a long menu is observed across fresh reads.
const menuReadWaitMs = 3500;
const selectionWaitMs = 3500;
const menuNotComplete = () => ({
  ok: false,
  reason: "MENU_NOT_COMPLETE",
  action_not_executed: true,
  next_action: "read_current_menu",
  instruction:
    "Wait silently for the complete current menu and read it again. No menu token was issued. Never invent a token or send a digit before a successful read.",
});
// A fixed invitation variation affects replay matching and duplicate detection,
// never option text, advertised digits or the owner's approved task.
const normalizeInvitation = (value) =>
  value.replace(
    /ご希望の番号を選択してくだい/g,
    "ご希望の番号を選択してください",
  );
const replayText = (value) =>
  normalizeInvitation(normalize(String(value ?? "")).toLowerCase()).replace(
    /[、。，,.!！\s]/g,
    "",
  );
const replayIntroduction = (value) =>
  normalize(value).match(/次の([2-9])(?:つ|個)(?:の中)?から/);
function replayPrefix(menu, value, cursor) {
  if (
    !menu?.replayIntro ||
    !menu.replayContent ||
    /[「」『』“”"?？]|違|変更|ではなく|いいえ|もしもし|ご用件|担当者/.test(
      value,
    )
  )
    return null;
  const observed = replayText(value);
  if (!observed) return null;
  const candidate = observed.startsWith(replayText(menu.replayIntro))
    ? observed
    : cursor?.token === menu.token
      ? cursor.text + observed
      : "";
  return candidate && menu.replayContent.startsWith(candidate)
    ? candidate
    : null;
}
// Conservative signals from authenticated recipient transcripts. Quoted,
// hypothetical and interrogative wording is not a terminal declaration.
export function recipientTerminalSignal(value) {
  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g, "");
  for (const clause of text.split(/[。.!！\n]/)) {
    if (
      !clause.trim() ||
      /[?？]|(?:ですか|ますか|ませんか|でしょうか|なのか|かね)[、,\s]*$/.test(
        clause,
      )
    )
      continue;
    if (
      /わけでは(?:ない|ありません)|訳では(?:ない|ありません)|ということでは(?:ない|ありません)|(?:営業時間外|閉店|休業)では(?:ない|ありません|ございません)|(?:の場合|のとき|でしたら|ならば)/.test(
        clause,
      )
    )
      continue;
    if (
      /(?:営業時間外|閉店|営業しておりません).{0,12}(?:という|といった|など|と表示|と案内|ですと)/.test(
        clause,
      )
    )
      continue;
    if (
      /(?:お(?:掛け|かけ)間違い)(?:では|じゃ)(?:ない|ありません|ございません)/.test(
        clause,
      )
    )
      continue;
    if (
      /(?:おつなぎ|お繋ぎ|転送)(?:し|いたし)ます|対応(?:が)?できます|(?:予約|ご案内|お問い合わせ|受付|お受け).{0,16}(?:できます|可能です|承れます|受け付け(?:ており|てい)ます)/.test(
        clause,
      )
    )
      continue;
    if (
      /(?:ただ今|只今|現在|今の時間|本日|当店|ストア|店舗|お店|こちら).{0,30}(?:営業(?:して|いたして)(?:おり|い)ません|営業時間外(?:です|でございます|となっております)|閉店(?:して)?(?:おり|い)ます|休業(?:して)?(?:おり|い)ます|営業(?:を)?終了(?:しました|いたしました|しております))|営業時間外(?:です|でございます|となっております)|本日は休業(?:です|いたします)|(?:we (?:are|['’]re)|the store is) (?:currently )?closed|outside (?:our )?business hours/i.test(
        clause,
      )
    )
      return { kind: "closed" };
    if (
      /お(?:掛け|かけ)間違い|(?:お電話番号|電話番号|おかけになった番号).{0,12}(?:が違います|を間違え|間違って)|wrong (?:phone )?number/i.test(
        clause,
      )
    )
      return { kind: "wrong_number" };
    if (
      /(?:現在|ただ今|只今).{0,16}電話に(?:出ることができません|出られません)|おつなぎ(?:することが)?できません|(?:no one|nobody) is (?:currently )?available|cannot (?:take|answer) your call/i.test(
        clause,
      )
    )
      return { kind: "unavailable" };
    if (
      /(?:承れません|お断り(?:いた)?します|対応できません|ご案内できません).*(?:失礼|切らせ|終了)/.test(
        clause,
      )
    )
      return {
        kind: /承れません|お断り|no thank you/i.test(clause)
          ? "refused"
          : "unavailable",
      };
  }
  if (
    /(?:承れません|お断り(?:いた)?します|対応できません|ご案内できません)[。.!！\s]+(?:それでは|では|大変申し訳ありませんが|恐れ入りますが)?[、,\s]*(?:失礼(?:いた)?します|お電話を切らせて)/.test(
      text,
    ) ||
    /(?:no thank you|cannot (?:fulfill|help with) (?:this|your) request)[.!\s]+(?:goodbye|good bye)/i.test(
      text,
    )
  )
    return {
      kind: /承れません|お断り|no thank you/i.test(text)
        ? "refused"
        : "unavailable",
    };
  return null;
}
const terminalOutcome = (signal) =>
  signal.kind === "wrong_number"
    ? "wrong_number"
    : signal.kind === "refused"
      ? "refused"
      : "unable_to_proceed";
export class CallController {
  constructor({
    sendDigit,
    close,
    now = () => performance.now(),
    token = randomUUID,
    requirePlaybackAck = true,
    stripCumulativeHistory = true,
    playFarewell = null,
    maxHoldMs = 90000,
    maxRoutingHoldMs = 180000,
  }) {
    if (!Number.isInteger(maxHoldMs) || maxHoldMs < 10000 || maxHoldMs > 90000)
      throw Error("Invalid hold limit");
    this.maxHoldMs = maxHoldMs;
    if (
      !Number.isInteger(maxRoutingHoldMs) ||
      maxRoutingHoldMs < 10000 ||
      maxRoutingHoldMs > 180000
    )
      throw Error("Invalid routing hold limit");
    this.maxRoutingHoldMs = maxRoutingHoldMs;
    this.hold = null;
    this.holdExpired = false;
    this.holdExpiry = null;
    this.recipientTerminal = null;
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
    if (e.type === "recipient_hold") this.enterHold(at);
    if (e.type === "recipient_return") this.leaveHold();
    // Adapter-only events: silence/empty queues prove no pending playback,
    // never that a real recipient answered a question or heard a farewell.
    if (e.type === "output_queue_empty") this.playbackAck = true;
    if (e.type === "recipient_answer") this.assistantQuestionPending = false;
    if (e.type === "recipient_turn_untranscribed") {
      this.speaking = false;
      this.lastSpeechEnd = at;
      if (!e.interrupted && this.suspendedClosing) {
        this.pending ??= this.suspendedClosing.pending;
        this.farewell ??= this.suspendedClosing.farewell;
        this.playbackAck ||= this.suspendedClosing.playbackAck;
      } else if (e.interrupted) {
        this.pending = null;
        this.farewell = null;
        this.playbackAck = false;
      }
      this.suspendedClosing = null;
    }
    if (e.type === "input_audio_buffer.speech_started") {
      this.menuReplayToken = null;
      this.menuReplayUntil = 0;
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
    if (e.type === "recipient_interim_transcript") {
      this.menuReplayToken = null;
      this.menuReplayUntil = 0;
      const text = String(e.transcript ?? "").normalize("NFKC");
      const m = this.menu;
      if (
        this.speaking &&
        this.menuSnapshotReady() &&
        m?.isIvr &&
        !m.spent &&
        m.replayIntro &&
        m.replayContent &&
        !/[「」『』“”"?？]|違|変更|ではなく|いいえ|もしもし|ご用件|担当者/.test(
          text,
        )
      ) {
        // Match the same count, exact introduction and every observed option
        // against an already complete snapshot. Unknown speech never qualifies.
        if (replayPrefix(m, text, this.replayCursor)) {
          this.menuReplayToken = m.token;
          this.menuReplayUntil = at + 1000;
        }
      }
    }
    if (e.type === "input_audio_buffer.speech_stopped") {
      this.speaking = false;
      this.lastSpeechEnd = at;
    }
    if (e.type === "conversation.item.input_audio_transcription.completed") {
      this.menuReplayToken = null;
      this.menuReplayUntil = 0;
      const raw = normalize(e.transcript ?? "");
      // STT can commit the last choice and the start of the replay together.
      // Finish the old announcement before processing the new introduction;
      // otherwise its count would discard the very choice just received.
      const boundary = [
        ...raw.matchAll(/次の[2-9](?:つ|個)(?:の中)?から/g),
      ].find(
        (m) =>
          m.index > 0 &&
          /押してくだ(?:さい|い)[。\s]*$/.test(raw.slice(0, m.index)),
      );
      if (boundary && (this.menuAssembly || this.menu?.complete)) {
        const tail = raw.slice(0, boundary.index).trim();
        if (
          !this.menu?.complete ||
          !replayText(this.menu.text).endsWith(replayText(tail))
        )
          this.event({ ...e, transcript: tail });
        this.event({ ...e, transcript: raw.slice(boundary.index) });
        return;
      }
      const old = this.lastRawTranscript;
      const cumulative =
        this.stripCumulativeHistory &&
        old &&
        raw.startsWith(old) &&
        /^[\s]+/.test(raw.slice(old.length)) &&
        /[。.!?]|押してください$/.test(old);
      const fragment = cumulative ? raw.slice(old.length).trimStart() : raw;
      this.lastRawTranscript = raw;
      const replay =
        this.menuSnapshotReady() && !this.menu.spent
          ? replayPrefix(this.menu, fragment, this.replayCursor)
          : null;
      if (replay) {
        // Consecutive STT finals can split the same replay across turns. Keep
        // a cursor only through its exact observed prefix; never renew menu.at.
        this.replayCursor = {
          token: this.menu.token,
          text: replay,
          startedAt:
            this.replayCursor?.token === this.menu.token
              ? this.replayCursor.startedAt
              : at,
        };
        this.menuAssembly = null;
        this.inputText = this.menu.text;
        this.lastTranscript = at;
        this.suspendedClosing = null;
        return;
      }
      const cursor = this.replayCursor;
      if (
        cursor?.token === this.menu?.token &&
        this.menuSnapshotReady() &&
        this.menu.replayCount &&
        at - cursor.startedAt < 30000 &&
        !replayIntroduction(fragment) &&
        !/[「」『』“”"]/.test(fragment)
      ) {
        // An unmatching continuation revokes the old token. The count and text
        // actually re-heard in THIS replay still constrain its fresh assembly;
        // never inherit unobserved choices from the old complete snapshot.
        this.menuAssembly = {
          text: cursor.text,
          expected: this.menu.replayCount,
          startedAt: cursor.startedAt,
        };
      }
      this.replayCursor = null;
      const countMatch = fragment.match(/次の([2-9])(?:つ|個)/);
      const interruptedMenu =
        isHoldReturn(fragment) ||
        isHoldRequest(fragment) ||
        isBackchannel(fragment) ||
        !!recipientTerminalSignal(fragment) ||
        /[?？]|(?:ですか|ますか|でしょうか)[。\s]*$/.test(fragment);
      const assembly = this.menuAssembly;
      const continueMenu =
        assembly &&
        !interruptedMenu &&
        at - assembly.startedAt < 30000 &&
        !(countMatch && at - assembly.startedAt > 5000);
      if (continueMenu) {
        this.inputText = fragment.startsWith(assembly.text)
          ? fragment
          : assembly.text.endsWith(fragment)
            ? assembly.text
            : assembly.text + fragment;
      } else {
        this.menuAssembly = null;
        if (
          assembly ||
          interruptedMenu ||
          this.menu?.complete ||
          this.lastTranscript === null ||
          at - this.lastTranscript > 750
        )
          this.inputText = "";
        if (fragment.startsWith(this.inputText)) this.inputText = fragment;
        else if (!this.inputText.endsWith(fragment)) this.inputText += fragment;
      }
      if (this.inputText.length > 4096) {
        this.inputText = fragment;
        this.menuAssembly = null;
      }
      this.lastTranscript = at;
      const text = this.inputText;
      const previousMenu = this.menu;
      if (
        (isBackchannel(text) ||
          ((this.hold || this.holdExpired) && isHoldFiller(fragment))) &&
        this.suspendedClosing
      ) {
        this.pending = this.suspendedClosing.pending;
        this.farewell ??= this.suspendedClosing.farewell;
        this.playbackAck ||= this.suspendedClosing.playbackAck;
      }
      this.suspendedClosing = null;
      const signal = recipientTerminalSignal(text);
      if (signal && !this.recipientTerminal) {
        this.recipientTerminal = { ...signal, at };
        this.hold = null;
        this.holdExpired = false;
        this.holdExpiry = null;
        this.assistantQuestionPending = false;
      }
      if (!this.recipientTerminal) {
        if (isHoldRequest(fragment))
          this.enterHold(at, isRoutingHold(fragment) ? "routing" : "requested");
        else if (
          isHoldReturn(fragment) ||
          ((this.hold || this.holdExpired) &&
            !e.preserve_hold &&
            !isBackchannel(fragment) &&
            !isHoldFiller(fragment) &&
            fragment.trim())
        )
          this.leaveHold();
        else if (!this.hold && !this.holdExpired && isHoldRequest(text))
          this.enterHold(at, isRoutingHold(text) ? "routing" : "requested");
      }
      this.recipientClosing =
        !!this.recipientTerminal ||
        /失礼(?:いた)?します|変更しました|承れません|間違い|できません|空いていません/.test(
          text,
        );
      this.closingBlocked =
        !this.recipientTerminal &&
        !this.holdExpired &&
        (this.hold !== null ||
          /確認します(?:ので|から|[。\s]*$)|質問があります|質問したい|その前|ちょっと待|\bquestion\b|[?？]/i.test(
            text,
          ));
      const core = text.replace(
        /選択を確認できませんでした[。\s]*|もう一度|もう1度|再度/g,
        "",
      );
      this.menu = {
        at,
        isIvr: /押|選択|入力|メニュー|お選び|press|dial/i.test(text),
        text,
        token: this.token(),
        core: digest(normalizeInvitation(core).replace(/[。、,.\s]/g, "")),
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
      const expected = countMatch
        ? Number(countMatch[1])
        : continueMenu
          ? assembly.expected
          : null;
      if (expected && this.menu.digits.length < expected)
        this.menu.complete = false;
      const partialMenu =
        !interruptedMenu &&
        (!this.menu.complete || !this.menu.digits.length) &&
        (continueMenu ||
          countMatch ||
          this.menu.isIvr ||
          /[0-9*#](?:番)?を/.test(fragment));
      this.menuAssembly = partialMenu
        ? {
            text: this.inputText,
            startedAt: continueMenu ? assembly.startedAt : at,
            expected,
          }
        : null;
      const intro = replayIntroduction(text);
      const previousIntro = previousMenu?.replayIntro;
      const inherited =
        !intro &&
        previousIntro &&
        previousMenu.digits.length === 0 &&
        at - previousMenu.at < 30000;
      const introduction = intro?.[0] ?? (inherited ? previousIntro : null);
      const count = intro ? Number(intro[1]) : previousMenu?.replayCount;
      if (introduction && this.menu.isIvr) {
        this.menu.replayIntro = introduction;
        this.menu.replayCount = count;
        if (this.menu.complete && this.menu.digits.length === count) {
          const body = intro ? text.slice(intro.index) : introduction + text;
          this.menu.replayContent = replayText(body);
        }
      }
      const exactReplayPrefix =
        !/[「」『』“”"?？]|違|変更|ではなく|いいえ|もしもし|ご用件|担当者/.test(
          fragment,
        ) &&
        previousMenu?.replayIntro &&
        replayText(fragment).startsWith(replayText(previousMenu.replayIntro)) &&
        previousMenu.replayContent?.startsWith(replayText(fragment));
      if (
        previousMenu?.complete &&
        previousMenu.digits.length &&
        !previousMenu.spent &&
        at - previousMenu.at < 30000 &&
        (exactReplayPrefix || this.menu.core === previousMenu.core)
      ) {
        // The original completed choice snapshot stays immutable through a replay intro.
        this.menu = previousMenu;
        this.inputText = previousMenu.text;
        this.menuAssembly = null;
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
      if (!e.no_audio && String(e.text ?? "").trim())
        this.assistantQuestionPending ||= /でしょうか|ですか|ますか|[?？]/.test(
          e.text,
        );
      if (this.assistantQuestionPending) this.farewell = null;
    }
    if (
      e.type === "assistant_completed" &&
      !this.playFarewell &&
      !e.no_audio &&
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
  enterHold(at = this.now(), kind = "requested") {
    if (
      this.recipientTerminal ||
      this.closed ||
      this.closing ||
      this.holdExpired
    )
      return;
    // Repeated hold announcements, music and aizuchi never refresh the lease.
    this.hold ??= {
      since: at,
      deadline:
        at + (kind === "routing" ? this.maxRoutingHoldMs : this.maxHoldMs),
      kind,
    };
    this.closingBlocked = true;
    this.pending = null;
    this.farewell = null;
    this.suspendedClosing = null;
  }
  leaveHold() {
    this.hold = null;
    this.holdExpired = false;
    this.holdExpiry = null;
    this.closingBlocked = false;
    if (this.pending?.reason === "hold_timeout") {
      this.pending = null;
      this.farewell = null;
    }
  }
  actionBlock(name) {
    if (!["read_current_menu", "press_ivr_digit"].includes(name)) return null;
    if (this.recipientTerminal)
      return {
        ok: false,
        reason: "RECIPIENT_TERMINAL",
        outcome: terminalOutcome(this.recipientTerminal),
        action_not_executed: true,
      };
    if (this.hold || this.holdExpired)
      return { ok: false, reason: "HOLD_PENDING", action_not_executed: true };
    return null;
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
    const blocked = this.actionBlock(name);
    if (blocked) {
      const work = Promise.resolve(blocked);
      this.operations.set(id, work);
      return work;
    }
    if (
      name === "read_current_menu" &&
      args &&
      !Array.isArray(args) &&
      Object.keys(args).length === 0 &&
      !this.menuSnapshotReady()
    ) {
      const work = new Promise((resolve) =>
        this.readWaiters.push({
          resolve,
          deadline: this.now() + menuReadWaitMs,
        }),
      );
      this.operations.set(id, work);
      return work;
    }
    if (
      name === "press_ivr_digit" &&
      !this.menuReady() &&
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
          deadline: this.now() + selectionWaitMs,
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
    const blocked = this.actionBlock(name);
    if (blocked) return blocked;
    if (this.systemFarewellStarted && name !== "read_current_menu")
      return { ok: false, reason: "CLOSING_PENDING" };
    if (!args || Array.isArray(args) || typeof args !== "object")
      return { ok: false, reason: "INVALID_ARGUMENTS" };
    if (name === "read_current_menu") {
      if (Object.keys(args).length)
        return { ok: false, reason: "INVALID_ARGUMENTS" };
      if (!this.menuSnapshotReady()) return menuNotComplete();
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
          action_not_executed: true,
          next_action: "read_current_menu",
          instruction:
            "Read the current menu again and use only the exact menu_token returned by the server. A guessed, placeholder, expired or previous-menu token is never valid. No digit was sent.",
          ...(this.menuReady()
            ? {
                current_menu: {
                  text: m.text,
                  menu_token: m.token,
                  advertised_digits: m.digits,
                },
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
      const dispatchGuard = this.knownMenuReplay()
        ? "matching_ivr_replay"
        : "recipient_quiet";
      // Reserve before awaiting any side effect: concurrent or uncertain requests
      // cannot execute the same selection again.
      m.spent = true;
      this.replayCursor = null;
      this.menuAssembly = null;
      this.inputText = "";
      this.lastTranscript = null;
      this.depth++;
      this.selections.set(key, count + 1);
      this.lastSelection = { key, digits: args.digits };
      try {
        return await this.sendDigit(args.digits, {
          operationId,
          dispatchGuard,
          exactMenuToken: true,
        });
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
        this.assistantQuestionPending &&
        !this.recipientTerminal &&
        !this.holdExpired
      )
        return { ok: false, reason: "AWAITING_RECIPIENT_ANSWER" };
      if (
        args.outcome === "unable_to_proceed" &&
        !this.recipientTerminal &&
        !this.holdExpired &&
        this.menu?.isIvr &&
        !this.menu.digits.length &&
        !/暗証|認証|パスワード|PIN|OTP|payment|支払/i.test(this.menu.text)
      )
        return { ok: false, reason: "MENU_NOT_COMPLETE" };
      this.pending = {
        outcome: this.recipientTerminal
          ? terminalOutcome(this.recipientTerminal)
          : this.holdExpired
            ? "unable_to_proceed"
            : args.outcome,
        operationId: this.holdExpired
          ? "hold-timeout:" + this.holdExpiry.since
          : operationId,
        ...(this.recipientTerminal
          ? { reason: "recipient_terminal" }
          : this.holdExpired
            ? { reason: "hold_timeout" }
            : {}),
      };
      return {
        ok: true,
        status: "CLOSURE_PENDING_FINISH_FAREWELL_THEN_REMAIN_SILENT",
      };
    }
    return { ok: false, reason: "UNKNOWN_ACTION" };
  }
  menuSnapshotReady() {
    return (
      !this.recipientTerminal &&
      !this.hold &&
      !this.holdExpired &&
      !!this.menu?.complete &&
      (this.menu.digits.length > 0 ||
        /暗証|認証|パスワード|PIN|OTP/i.test(this.menu.text)) &&
      this.now() - this.menu.at < 30000
    );
  }
  menuReady() {
    return (
      this.menuSnapshotReady() &&
      (this.knownMenuReplay() ||
        (!this.speaking &&
          this.lastSpeechEnd !== null &&
          this.now() - this.lastSpeechEnd >= 750))
    );
  }
  knownMenuReplay() {
    return !!(
      this.menuSnapshotReady() &&
      !this.menu.spent &&
      this.menuReplayToken === this.menu.token &&
      this.now() < this.menuReplayUntil
    );
  }
  async tick() {
    const at = this.now();
    if (this.closed || this.closing) {
      for (const waiter of [...this.readWaiters, ...this.selectionWaiters])
        waiter.resolve({ ok: false, reason: "CLOSED" });
      this.readWaiters = [];
      this.selectionWaiters = [];
      return false;
    }
    if (this.hold && at >= this.hold.deadline) {
      this.holdExpiry = {
        since: this.hold.since,
        deadline: this.hold.deadline,
      };
      this.hold = null;
      this.holdExpired = true;
      this.closingBlocked = false;
      this.assistantQuestionPending = false;
    }
    // A new acoustic turn suspends pending closing. Repeated hold instructions,
    // music or aizuchi cannot renew an expired lease or lose its stop request.
    // A genuine return/answer explicitly clears holdExpired via leaveHold().
    if (this.holdExpired && !this.pending) {
      this.closingBlocked = false;
      this.assistantQuestionPending = false;
      this.pending = {
        outcome: "unable_to_proceed",
        reason: "hold_timeout",
        operationId: "hold-timeout:" + this.holdExpiry.since,
      };
    }
    if (
      this.recipientTerminal &&
      !this.speaking &&
      this.lastSpeechEnd !== null &&
      at - this.lastSpeechEnd >= 1500 &&
      !this.pending
    ) {
      this.closingBlocked = false;
      this.assistantQuestionPending = false;
      this.pending = {
        outcome: terminalOutcome(this.recipientTerminal),
        reason: "recipient_terminal",
        operationId: "recipient-terminal:" + this.recipientTerminal.kind,
      };
    }
    const waiting = this.readWaiters;
    this.readWaiters = [];
    for (const w of waiting) {
      if (this.actionBlock("read_current_menu"))
        w.resolve(this.actionBlock("read_current_menu"));
      else if (this.menuSnapshotReady())
        w.resolve(await this.execute("read_current_menu", {}));
      else if (at >= w.deadline) w.resolve(menuNotComplete());
      else this.readWaiters.push(w);
    }
    const selections = this.selectionWaiters;
    this.selectionWaiters = [];
    for (const w of selections) {
      if (this.closed || this.closing)
        w.resolve({ ok: false, reason: "CLOSED" });
      else if (this.actionBlock("press_ivr_digit"))
        w.resolve(this.actionBlock("press_ivr_digit"));
      else if (this.menu?.token !== w.args.menu_token)
        w.resolve({
          ok: false,
          reason: "STALE_OR_INCOMPLETE_MENU",
          action_not_executed: true,
          next_action: "read_current_menu",
        });
      else if (this.menuReady())
        w.resolve(await this.execute("press_ivr_digit", w.args, w.id));
      else if (at >= w.deadline) w.resolve(menuNotComplete());
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
