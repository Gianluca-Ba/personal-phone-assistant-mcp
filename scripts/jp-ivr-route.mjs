import { normalizeMenuTranscript } from "./jp-menu-text.mjs";

export const RETAIL_ROUTE_DIRECTIVE =
  "Menu IVR autorizzato: Apple Kawasaki, solo tasto 5 per altre domande.";
const profile = "apple_kawasaki_other_questions_v1";

// Read only the immutable, owner-approved request snapshot, never recipient
// speech, tool arguments or model-provided route/consent metadata.
export function outboundRoutingPolicy({ destination, instructions }) {
  const directives = String(instructions ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("Menu IVR autorizzato:"));
  // Ordinary MCP requests already have a canonical Goal line. Constrain the
  // narrow, explicit consumer walk-in use case too, without a magic client flag.
  // This can only restrict offered digits; it is never authority to call.
  if (!directives.length) {
    const goal =
      /^Goal: ([^\r\n]+)(?:\r?\n|$)/.exec(String(instructions ?? ""))?.[1] ??
      "";
    const consumerStock =
      /iPhone|アイフォーン|アイフォン/i.test(goal) &&
      /walk[ -]?in|senza prenotazione|予約なし/i.test(goal) &&
      /disponibil|stock|在庫|availability|acquist|購入|buy/i.test(goal) &&
      !/aziendal|法人|business|company|bulk|riparazion|assistenza tecnica|technical support|repair|サポート|修理/i.test(
        goal,
      );
    return destination === "+81445775100" && consumerStock
      ? Object.freeze({ profile, digit: "5", category: "other_questions" })
      : null;
  }
  if (
    directives.length !== 1 ||
    directives[0].trim() !== RETAIL_ROUTE_DIRECTIVE ||
    destination !== "+81445775100"
  )
    throw Error("Invalid authorized IVR route");
  return Object.freeze({ profile, digit: "5", category: "other_questions" });
}

// Japanese label-before-digit grammar. Punctuation is optional in normalized
// ASR. Do not confuse an introductory option count with an offered selection.
export function menuOptions(value) {
  const text = normalizeMenuTranscript(String(value ?? ""));
  const options = [];
  let from = 0;
  for (const m of text.matchAll(/([0-9*#])(?:番)?を/g)) {
    const label = text
      .slice(from, m.index)
      .replace(/^[。、,\s]*(?:押してください[。、,\s]*)?/, "")
      .trim();
    options.push({ digit: m[1], label });
    from = m.index + m[0].length;
  }
  return options;
}

export function routeConstraint(menu, policy, { used = false } = {}) {
  if (!policy) return null;
  if (
    policy.profile !== profile ||
    policy.digit !== "5" ||
    policy.category !== "other_questions"
  )
    throw Error("Invalid IVR policy");
  if (used)
    return {
      profile,
      authorized_digits: [],
      reason: "AUTHORIZED_ROUTE_ALREADY_USED",
    };
  const options = menuOptions(menu);
  const choices = options.filter((o) => o.digit === "5");
  const match =
    choices.length === 1 &&
    /^(?:その他|それ以外)の(?:ご)?(?:質問|お問い合わせ)(?:について)?(?:の(?:お客様|方))?は[。、,\s]*$/.test(
      choices[0].label,
    );
  return {
    profile,
    authorized_digits: match ? ["5"] : [],
    reason: match ? null : "AUTHORIZED_ROUTE_NOT_OFFERED",
  };
}
