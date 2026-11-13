// Observed appointment slots, never authorization or a completed booking.
// Ambiguous dates/times are deliberately left unresolved.
const number = (value) => {
  const digits = "〇一二三四五六七八九";
  if (!value.includes("十"))
    return Number([...value].map((c) => digits.indexOf(c)).join(""));
  const [tens, units] = value.split("十");
  return (
    (tens ? digits.indexOf(tens) : 1) * 10 + (units ? digits.indexOf(units) : 0)
  );
};
const normalize = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .replace(/零/g, "〇")
    .replace(/[〇一二三四五六七八九十]+(?=月|日|時|分)/g, (s) =>
      String(number(s)),
    );
const dates = (text) =>
  [...text.matchAll(/(\d{1,2})月\s*(\d{1,2})日/g)]
    .filter((m) => +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31)
    .map((m) => ({
      month: +m[1],
      day: +m[2],
      index: m.index,
      end: m.index + m[0].length,
    }));
const times = (text) =>
  [...text.matchAll(/(午前|午後)?\s*(\d{1,2})時(?:\s*(\d{1,2})分|\s*(半))?/g)]
    .map((m) => ({
      hour: (+m[2] % (m[1] ? 12 : 24)) + (m[1] === "午後" ? 12 : 0),
      minute: m[4] ? 30 : +(m[3] ?? 0),
      valid: +m[2] <= (m[1] ? 12 : 23) && +(m[3] ?? 0) <= 59,
      index: m.index,
      end: m.index + m[0].length,
    }))
    .filter((t) => t.valid);
const safeText = (text) => !/[「」『』“”"]/.test(text);
const slot = (date, time) => ({
  month: date.month,
  day: date.day,
  hour: time.hour,
  minute: time.minute,
});
const unique = (values) => [
  ...new Map(values.map((v) => [JSON.stringify(v), v])).values(),
];
export function appointmentRequest(text) {
  const value = normalize(text);
  return (
    /(?:変更|振替|予約|取り直).{0,30}(?:お願い|して(?:いただ|頂|もら|ください)|してもよろしい|したい|いたします|します)/.test(
      value,
    ) ||
    (dates(value).length > 0 &&
      times(value).length > 0 &&
      /(?:時(?:\d{1,2}分|半)?)(?:[、,\s]*(?:に|で|へ))?[、,\s]*お願い/.test(
        value,
      ))
  );
}
function candidateSlots(text) {
  const found = dates(text);
  return found.flatMap((date, index) => {
    const before = text.slice(Math.max(0, date.index - 12), date.index);
    const fragment = text.slice(
      date.end,
      found[index + 1]?.index ?? text.length,
    );
    // An original appointment mentioned for identification is not a target.
    if (/(?:現在の|元の|もとの|今日|本日)[^。！？]{0,6}$/.test(before))
      return [];
    const clock = times(fragment);
    if (clock.length !== 1) return [];
    if (/の予約を/.test(fragment.slice(clock[0].end)) && found.length > 1)
      return [];
    return [slot(date, clock[0])];
  });
}
export function playedAppointmentQuestion(text) {
  const value = normalize(text);
  if (
    !safeText(value) ||
    !/予約|変更|振替|空き|空いて|枠|お時間|時間帯/.test(value) ||
    !/か[。?？\s]*$|でしょうか|いかが/.test(value)
  )
    return null;
  const candidates = unique(candidateSlots(value));
  if (candidates.length === 1) return candidates[0];
  const calendar = dates(value);
  return calendar.length === 1 && times(value).length === 0
    ? {
        month: calendar[0].month,
        day: calendar[0].day,
        hour: null,
        minute: null,
      }
    : null;
}
export function recipientAppointmentOffer(text, playedQuestion = null) {
  const value = normalize(text);
  if (
    !safeText(value) ||
    /[?？]|ですか|ますか|でしょうか|ません|ない|未定|難しい/.test(value) ||
    !/空いて(?:います|おります)|空き(?:が|は)?(?:あります|ございます)|(?:予約|ご案内|お取り).{0,15}(?:できます|可能です|可能でございます)/.test(
      value,
    )
  )
    return null;
  const calendar = dates(value),
    clock = times(value);
  if (calendar.length > 1 || clock.length !== 1) return null;
  const date = calendar[0] ?? playedQuestion;
  return date ? slot(date, clock[0]) : null;
}
export function appointmentMismatch(text, offered) {
  if (!offered || !appointmentRequest(text)) return null;
  const candidates = unique(candidateSlots(normalize(text)));
  if (
    candidates.length !== 1 ||
    JSON.stringify(candidates[0]) !== JSON.stringify(offered)
  )
    return { reason: "APPOINTMENT_OFFER_MISMATCH", offered_slot: offered };
  return null;
}
