import { sha256 } from "./security.mjs";
import {
  isRoutingHold,
  isHoldRequest,
  isHoldFiller,
} from "../../../scripts/jp-backchannel.mjs";
export const menuText = (text) =>
  text
    .normalize("NFKC")
    .replace(/[一二三四五六七八九〇]/g, (c) =>
      String("〇一二三四五六七八九".indexOf(c)),
    )
    .replace(/[。、,.\s]/g, "")
    .toLowerCase();
const ivr =
  /押してください|選択してください|入力してください|お選びください|\bpress\b|\bdial\b/i;
export function progressEvidence(baseline, transcript, seen = []) {
  const text = menuText(transcript),
    old = menuText(baseline);
  if (
    !text ||
    old.includes(text) ||
    text === old ||
    seen.includes(sha256(text))
  )
    return null;
  // A routing announcement is evidence of a new observable state, not proof of
  // carrier DTMF reception. Conditional menu labels such as 転送するには do not qualify.
  if (isRoutingHold(transcript))
    return { kind: "routing_announcement", digest: sha256(text) };
  if (
    ivr.test(transcript) &&
    /[0-9*#](?:番)?(?:を|に|です|[、,]|\s)/.test(
      transcript
        .normalize("NFKC")
        .replace(/[一二三四五六七八九〇]/g, (c) =>
          String("〇一二三四五六七八九".indexOf(c)),
        ),
    )
  ) {
    // Reject partial/repeated announcements with minor ASR variation.
    const grams = (s) =>
      new Set(
        Array.from({ length: Math.max(0, s.length - 1) }, (_, i) =>
          s.slice(i, i + 2),
        ),
      );
    const a = grams(old),
      b = grams(text),
      intersection = [...b].filter((x) => a.has(x)).length;
    if (intersection / Math.max(1, Math.min(a.size, b.size)) >= 0.7)
      return null;
    return { kind: "changed_menu", digest: sha256(text) };
  }
  // A fact-bearing automatic announcement is observable progress even when it
  // does not introduce another numbered menu. It is not proof of a human or of
  // the accuracy of ASR-derived address/time details.
  if (
    !ivr.test(transcript) &&
    /(?:住所|所在地)(?:は|が).{4,120}(?:です|でございます)|(?:当店|店舗|ストア|弊社).{0,16}(?:は|が).{4,80}(?:にあります|にございます)|.{2,40}(?:の近く|付近|隣|向かい).{0,16}(?:にあります|にございます|です)|(?:営業(?:時間)?|開店|閉店)(?:は|時刻は|時間は).{0,60}[0-9０-９一二三四五六七八九十]{1,4}時|(?:our )?(?:address is|located at)|(?:business|opening) hours (?:are|is).{0,60}\d/i.test(
      transcript,
    )
  )
    return { kind: "information_announcement", digest: sha256(text) };
  if (
    !ivr.test(transcript) &&
    !isHoldRequest(transcript) &&
    !isHoldFiller(transcript) &&
    (/お待たせ(?:いた)?しました|担当の.{1,12}(?:です|でございます)|ご用件(?:を|は)|どのような|もしもし|お名前|お声.{0,12}届|聞こえ|確認(?:できました|が取れました)|(?:アップル|Apple)(?:ストア)?[、,\s]*川崎(?:店)?(?:の|[、,\s])[^。！？]{1,20}(?:です|でございます)|how (?:may|can) I help|thank you for (?:holding|waiting)/i.test(
      transcript,
    ) ||
      /(?:でしょうか|ですか|ますか)[。?？\s]*$/.test(transcript))
  )
    return { kind: "human_greeting_candidate", digest: sha256(text) };
  return null;
}
export function dtmfTuning(env) {
  const duration = Number(env.OUTBOUND_DTMF_DURATION_MS ?? 250),
    timeout = Number(env.OUTBOUND_IVR_TRANSITION_TIMEOUT_MS ?? 45000);
  if (!Number.isInteger(duration) || duration < 100 || duration > 500)
    throw Error("Invalid DTMF duration");
  if (!Number.isInteger(timeout) || timeout < 10000 || timeout > 120000)
    throw Error("Invalid IVR transition timeout");
  return { duration, timeout };
}
