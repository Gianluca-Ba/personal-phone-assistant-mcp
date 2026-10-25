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
