import { expect, it } from "vitest";
const { progressEvidence, dtmfTuning, menuText } = await import(
  new URL("../workers/voice/src/ivr-progress.mjs", import.meta.url).href
);
const baseline =
  "営業時間は一を、サポートは二を、法人のお客様は三を、その他のご質問は五を押してください。";
it("never infers a transition from the same menu, a partial repetition or a choice-free introduction", () => {
  for (const text of [
    baseline,
    baseline.replace("一", "1").replace("五", "5"),
    "その他のご質問は五を押してください。",
    "次の四つの中からご希望の番号を選択してください。",
  ])
    expect(progressEvidence(baseline, text)).toBeNull();
  expect(menuText("五を 押してください。")).toBe(menuText("5を押してください"));
});
it("never declares progression from a kana-only numeric transcription variation", () => {
  const original = "サポートは二を、その他のご質問は五を押してください。";
  const kana = "サポートは ニを、その他のご質問はゴーを押してください。";
  expect(menuText(original)).toBe(menuText(kana));
  expect(progressEvidence(original, kana)).toBeNull();
});
it("distinguishes routing observations and a new submenu from conditional option labels", () => {
  expect(
    progressEvidence(baseline, "担当者におつなぎいたします。"),
  ).toMatchObject({ kind: "routing_announcement" });
  expect(
    progressEvidence(
      baseline,
      "購入相談は一を、修理相談は二を押してください。",
    ),
  ).toMatchObject({ kind: "changed_menu" });
  expect(
    progressEvidence(baseline, "サポートに転送するには二を押してください。")
      ?.kind,
  ).not.toBe("routing_announcement");
});
it("labels a possible human greeting as a candidate, never as proven human contact", () => {
  expect(
    progressEvidence(baseline, "お待たせしました。担当のテストです。"),
  ).toMatchObject({ kind: "human_greeting_candidate" });
});
it("does not release a routing hold for an announcement that asks the caller to keep waiting", () => {
  for (const text of [
    "お待たせしました。少々お待ちください。",
    "お待たせしております。",
    "Thank you for holding. Please hold.",
  ])
    expect(progressEvidence(baseline, text)?.kind).not.toBe(
      "human_greeting_candidate",
    );
});
it("recognizes the observed post-transfer audibility question as a dialogue candidate, never task success", () => {
  for (const text of [
    "お声届いておりますでしょうか。",
    "ございますでしょうか?",
    "Non so se ますでしょうか。",
  ])
    expect(progressEvidence(baseline, text)).toMatchObject({
      kind: "human_greeting_candidate",
    });
  for (const text of ["ご視聴ありがとうございました", "उसमें से", "Posso"])
    expect(progressEvidence(baseline, text)?.kind).not.toBe(
      "human_greeting_candidate",
    );
});
it("uses the later live greeting in a mixed transfer/STT turn and preserves a genuinely renewed wait instruction", () => {
  for (const text of [
    "次の四つの中がお電話を転送しております。もしもし",
    "お電話を転送しております。お待たせいたしました。担当のテストです。",
  ])
    expect(progressEvidence(baseline, text)).toMatchObject({
      kind: "human_greeting_candidate",
    });
  for (const text of [
    "もしもし。お電話を転送しております。",
    "お電話を転送しております。もしもし。少々お待ちください。",
  ])
    expect(progressEvidence(baseline, text)).toMatchObject({
      kind: "routing_announcement",
    });
});
it("recognizes the observed ongoing transfer without confusing conditional or quoted menu labels", () => {
  for (const text of [
    "お電話を転送しております。",
    "ただいま担当者におつなぎしております。",
    "お電話を転送いたしますので少々お待ちください。",
    "営業時間や道順お電話を転送しております。 हमारी यात्रा उसमें मतलब प्रकार से खेलते हैं.",
  ])
    expect(progressEvidence(baseline, text)).toMatchObject({
      kind: "routing_announcement",
    });
  for (const text of [
    "Appleケアに転送するには二を押してください。",
    "転送しておりますか？",
    "「お電話を転送しております」と案内されています。",
  ])
    expect(progressEvidence(baseline, text)?.kind).not.toBe(
      "routing_announcement",
    );
});
it("bounds supported DTMF duration and no-transition waiting without a transmission-method override", () => {
  expect(dtmfTuning({})).toEqual({ duration: 250, timeout: 45000 });
  expect(
    dtmfTuning({
      OUTBOUND_DTMF_DURATION_MS: "500",
      OUTBOUND_IVR_TRANSITION_TIMEOUT_MS: "10000",
    }),
  ).toEqual({ duration: 500, timeout: 10000 });
  for (const duration of ["99", "501", "NaN"])
    expect(() => dtmfTuning({ OUTBOUND_DTMF_DURATION_MS: duration })).toThrow();
  for (const timeout of ["0", "120001", "bad"])
    expect(() =>
      dtmfTuning({ OUTBOUND_IVR_TRANSITION_TIMEOUT_MS: timeout }),
    ).toThrow();
});
it("recognizes the recorded staff greeting after routing without requiring moshi-moshi", () => {
  for (const greeting of [
    "お電話ありがとうございます。アップル川崎です。",
    "AppleStore銀座のテストです。",
    "Apple丸の内店舗案内です。",
    "AppleShibuya店舗案内でございます。",
    "Apple表参道店舗案内でございます。",
  ]) {
    expect(progressEvidence(baseline, greeting)).toMatchObject({
      kind: "human_greeting_candidate",
    });
    expect(
      progressEvidence(baseline, "お電話を転送しております。" + greeting),
    ).toMatchObject({ kind: "human_greeting_candidate" });
    expect(
      progressEvidence(baseline, greeting + "少々お待ちください。")?.kind,
    ).not.toBe("human_greeting_candidate");
    expect(
      progressEvidence(baseline, "「" + greeting + "」と言っています。")?.kind,
    ).not.toBe("human_greeting_candidate");
  }
  expect(
    progressEvidence(
      baseline,
      "AppleStore銀座にお電話いただきありがとうございます。",
    ),
  ).toBeNull();
});

it("recognizes a fact-bearing address/hours announcement as observable IVR progress, never human contact", () => {
  const hoursMenu = "営業時間やアクセスのご案内については1を押してください。";
  for (const text of [
    "ストアは駅前の広場の近くにあります。",
    "店舗の住所は神奈川県川崎市堀川町七十二の一です。",
    "営業時間は午前10時から午後9時までです。",
    "Our address is 72-1 Horikawacho.",
  ])
    expect(progressEvidence(hoursMenu, text)).toMatchObject({
      kind: "information_announcement",
    });
  for (const text of [
    "営業時間やアクセスについてご案内します。",
    "住所については1を押してください。",
    "営業時間は",
    hoursMenu,
  ])
    expect(progressEvidence(hoursMenu, text)?.kind).not.toBe(
      "information_announcement",
    );
});
