// Narrow listening-signal recognition, not authorization or task completion.
// Context belongs to the caller: the same はい after a question is an answer.
export const normalizeJapaneseTurn = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .replace(/\u200b/g, "")
    .trim();

export const isBackchannel = (text) =>
  /^(?:あ[、,\s]+)?(?:(?:はい|はーい|ええ|ええー|うん|そうですね|なるほど)[。、,!！\s]*){1,3}$/.test(
    normalizeJapaneseTurn(text),
  );

// Explicit conversational cues only. These do not authorize any action.
const holdRequest =
  /(?:少々|少し|しばらく|ちょっと|そのまま|このまま|一旦)?(?:お待ち(?:ください|下さい|いただ|頂|願)|待って(?:ください|下さい|いただ|頂)|待ちください)|保留(?:に|で|と)|please\s+(?:hold|wait)/i;
const holdNegation =
  /待(?:た|つ|って|ち)[^。！？]{0,30}(?:必要は(?:ありま|ございま)せん|必要(?:が|は)ない|不要|なくて(?:も|結構)|(?:いただか|頂か)なくて)/;
const holdReturn =
  /お待たせ(?:しました|いたしました|致しました)|お待ち(?:どうさま|どおさま)|確認(?:できました|が取れました)|もしもし|お電話ありがとうございます(?:[。.!！、,\s]|$)|(?:Apple|アップル)(?:Store|ストア)?[、,\s]*(?:川崎|カワサキ|銀座|ギンザ|丸の内|マルノウチ)(?:店|ストア)?(?:店舗案内)?(?:[、,\s]|の.{1,12})?(?:です|でございます)|thank you for (?:holding|waiting)/i;
// A direct first-person checking commitment commonly precedes a silent hold.
// Require the affirmative commitment at the end, never a question or a quote.
const verificationPause =
  /確認(?:いたします|致します|します|(?:を)?して(?:まいります|参ります|きます)|(?:を)?させて(?:いただきます|頂きます)|を取って(?:まいります|参ります))[。.!！\s]*$/;
export const isRoutingHold = (text) => {
  const value = normalizeJapaneseTurn(text);
  if (/[「」『』“”"?？]/.test(value)) return false;
  const declarations = [
    ...value.matchAll(
      /(?:おつなぎ|お繋ぎ|転送)(?:いたしております|しております|しています|いたします|します)(?:[。、.!！\s]|ので|$)/g,
    ),
  ];
  const latest = declarations.at(-1);
  if (!latest) return false;
  // A final STT turn can contain the old recording followed by the live staff
  // greeting. Honor cue order instead of keeping the historical hold forever.
  const after = value.slice(latest.index + latest[0].length);
  const returned = [...after.matchAll(new RegExp(holdReturn.source, "ig"))].at(
    -1,
  );
  if (returned) {
    const remaining = after.slice(returned.index + returned[0].length);
    if (!holdRequest.test(remaining) && !verificationPause.test(remaining))
      return false;
  }
  return true;
};
export const isHoldRequest = (text) => {
  const value = normalizeJapaneseTurn(text);
  const implicit =
    !/[「」『』“”"]/.test(value) && verificationPause.test(value);
  return (
    (holdRequest.test(value) || implicit || isRoutingHold(value)) &&
    !holdNegation.test(value)
  );
};
export const isHoldReturn = (text) => {
  const value = normalizeJapaneseTurn(text);
  return !/[「」『』“”"]/.test(value) && holdReturn.test(value);
};
const ongoingWaitApology =
  /^(?:(?:大変|長らく|長時間)[、,\s]*)?お待たせ(?:しております|しています|して(?:しまい)?(?:申し訳(?:ございません|ありません)|すみません))(?:[。.!！\s]*(?:大変)?申し訳(?:ございません|ありません))?[。.!！\s]*$/;
export const isHoldFiller = (text) =>
  ongoingWaitApology.test(normalizeJapaneseTurn(text)) ||
  /^(?:\[(?:music|hold music|silence|long silence|音楽|保留音|無音)\]|\((?:music|hold music|silence|long silence|音楽|保留音|無音)\)|音楽|保留音|無音)[。、.\s]*$/i.test(
    normalizeJapaneseTurn(text),
  );
