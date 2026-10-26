import { expect, it } from "vitest";
const { normalizeMenuTranscript } = await import(
  new URL("../scripts/jp-menu-text.mjs", import.meta.url).href
);
it("normalizes the recorded numeric kana only at a selection boundary", () => {
  expect(
    normalizeMenuTranscript(
      "アップルケアに転送するには ニを、その他はゴーを押してください。",
    ),
  ).toBe("アップルケアに転送するには 2を、その他は5を押してください。");
  expect(normalizeMenuTranscript("ﾆ番を押してください。")).toBe(
    "2番を押してください。",
  );
  for (const text of [
    "カニを買いたいです。",
    "ゴールを目指します。",
    "にを言い換えます。",
    "ニューを選びます。",
  ])
    expect(normalizeMenuTranscript(text)).toBe(text);
});
