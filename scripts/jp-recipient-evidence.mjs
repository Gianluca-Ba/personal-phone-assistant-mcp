import {
  isHoldRequest,
  isHoldFiller,
  isBackchannel,
} from "./jp-backchannel.mjs";

// These are conservative text cues, not authentication of a human speaker.
// Unknown speech during a hold keeps the original bounded hold alive.
export function isHoldAnnouncement(value) {
  const s = String(value ?? "").normalize("NFKC");
  return (
    isHoldFiller(s) ||
    /ヨドバシ(?:ドットコム|ドットコム|\.com)|インターネット|通販サイト|オンライン(?:ストア|ショップ)|店舗受[け取]*取(?:り)?サービス|ぜひご利用|在庫(?:状況|情報).{0,40}(?:お店ごと|店舗ごと|リアルタイム)|在庫のある商品を.{0,50}(?:ご用意|用意|お受け取り)|本日も.{0,60}ありがとうございます|お電話(?:を|いただき|いただきまして)?ありがとうございます|品質向上|通話.{0,20}録音/i.test(
      s,
    )
  );
}

const quoted = /[「」『』“”"]/;
const question = /[?？]|(?:ですか|ますか|でしょうか|ませんか)[。\s]*$/;

export function hasAffirmativeStock(value) {
  const s = String(value ?? "").normalize("NFKC");
  return (
    !quoted.test(s) &&
    !question.test(s) &&
    !isHoldAnnouncement(s) &&
    /(?:在庫|商品|端末|製品).{0,24}(?:が|は|を)?(?:ございます|あります|ご用意できます|購入できます|販売しております)[。\s]*(?:ので|$)/.test(
      s,
    ) &&
    !/ありません|ございません|在庫なし|品切れ|売り切れ|完売|ない|未定|なら|場合|予定|という|とのこと/.test(
      s,
    )
  );
}

export function substantiveAnswer(value) {
  const s = String(value ?? "")
    .normalize("NFKC")
    .trim();
  if (
    !s ||
    s.length > 8192 ||
    quoted.test(s) ||
    question.test(s) ||
    isHoldAnnouncement(s) ||
    isHoldRequest(s) ||
    isBackchannel(s)
  )
    return null;
  if (
    hasAffirmativeStock(s) ||
    /空いて(?:います|おります)/.test(s) ||
    /(?:在庫|入荷).{0,30}(?:なし|無し)/.test(s) ||
    /(?:在庫|空き|席|予約|入荷|再入荷|販売|購入|確認).{0,55}(?:ありません|ございません|未定|ない|できません|できない|できかね|承れません|満席|売り切れ|品切れ|完売)|(?:予約|お席).{0,50}(?:承りました|承っております|確定しました|お取りしました|お取りいたしました)|(?:reservation|appointment|booking).{0,40}(?:confirmed|booked)|(?:conferm[oa]|confermata).{0,30}(?:prenotazione|appuntamento)|(?:out of stock|restock.{0,20}unknown)/i.test(
      s,
    ) ||
    /^(?:申し訳ございません[、。\s]*)?(?:ありません|ございません|未定(?:です|でございます)(?:ね)?)[。\s]*(?:申し訳ございません[。\s]*)?$/.test(
      s,
    )
  )
    return s;
  return null;
}

export function holdReturnText(value) {
  const s = String(value ?? "")
    .normalize("NFKC")
    .trim();
  if (!s || s.length > 8192 || quoted.test(s)) return null;
  // Choose a later interactive return when STT combines an old recording and
  // new staff speech. Never pass the preceding advertisement as an answer.
  const marker =
    /お待たせ(?:いた)?しました|お待ち(?:どうさま|どおさま)|(?:お)?電話(?:を)?代わりました|[^。！？]{1,25}と申します|ご用件|どのような|もしもし|確認(?:できました|が取れました)(?!ら|なら)/g;
  const matches = [...s.matchAll(marker)];
  for (const m of matches.reverse()) {
    const tail = s.slice(m.index).trim();
    if (!isHoldAnnouncement(tail) && !isHoldRequest(tail)) return tail;
  }
  if (isHoldAnnouncement(s) || isHoldRequest(s) || isBackchannel(s))
    return null;
  // A current menu is a routing transition, not an employee/stock answer.
  if (/[0-9０-９一二三四五六七八九].{0,6}押してください/.test(s)) return s;
  return question.test(s) ||
    /質問があります|質問したい|その前に|訂正|変更/.test(s) ||
    substantiveAnswer(s)
    ? s
    : null;
}

export function outcomeSources(sources) {
  let held = false;
  const eligible = new Map();
  for (const source of sources) {
    if (source.role !== "user") continue;
    const text = source.text;
    if (isHoldRequest(text) && !holdReturnText(text)) {
      held = true;
      continue;
    }
    let body = text;
    if (held || isHoldAnnouncement(text)) {
      body = holdReturnText(text);
      if (!body) continue;
      held = false;
    }
    if (substantiveAnswer(body)) eligible.set(source.source_id, body);
  }
  return eligible;
}
