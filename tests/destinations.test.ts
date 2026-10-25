import { expect, it } from "vitest";
import { destinationAllowed } from "../workers/mcp/src/destinations";
const standard = { OUTBOUND_DESTINATION_POLICY: "all_standard" };
it.each([
  "+818042887648",
  "+81364256814",
  "+819012345678",
  "+39066982",
  "+12133734253",
  "+442079460018",
  "+815012345678",
  "+6834000",
])("accepts standard national-plan numbers: %s", (number) => {
  expect(destinationAllowed(number, standard)).toBe(true);
});
it.each([
  "110",
  "112",
  "119",
  "911",
  "+81110",
  "+39112",
  "+8199",
  "+999123456789",
  "+19002345678",
  "+81570123456",
  "+81120123456",
  "+818001234567",
  "+881612345678",
  "+979123456789",
  "+81364256814;ext=1",
  "+81 3 6425 6814",
  "+810364256814",
])(
  "rejects emergency, special, premium, risky and malformed numbers: %s",
  (number) => {
    expect(destinationAllowed(number, standard)).toBe(false);
  },
);
it("all_standard ignores restrictive or malformed legacy allowlist Secrets", () => {
  for (const secret of ['["+819012345678"]', "[]", "not-json"])
    expect(
      destinationAllowed("+81364256814", {
        ...standard,
        OUTBOUND_ALLOWED_DESTINATIONS_SECRET: secret,
      }),
    ).toBe(true);
});
it("allowlist mode preserves private precedence and is the backward-compatible default", () => {
  const env = {
    OUTBOUND_ALLOWED_DESTINATIONS: '["+81364256814"]',
    OUTBOUND_ALLOWED_DESTINATIONS_SECRET: '["+818042887648"]',
  };
  expect(destinationAllowed("+818042887648", env)).toBe(true);
  expect(destinationAllowed("+81364256814", env)).toBe(false);
  expect(
    destinationAllowed("+81364256814", {
      OUTBOUND_DESTINATION_POLICY: "allowlist",
    }),
  ).toBe(false);
});
it("configured country/range/exact/type restrictions apply to otherwise standard numbers", () => {
  for (const restriction of [
    { OUTBOUND_BLOCKED_PREFIXES: '["+81"]' },
    { OUTBOUND_BLOCKED_PREFIXES: '["+81364"]' },
    { OUTBOUND_BLOCKED_DESTINATIONS: '["+81364256814"]' },
    { OUTBOUND_BLOCKED_NUMBER_TYPES: '["FIXED_LINE"]' },
  ])
    expect(
      destinationAllowed("+81364256814", { ...standard, ...restriction }),
    ).toBe(false);
});
it("invalid policies and malformed restrictions fail closed, while an empty extra type block cannot enable premium", () => {
  for (const restriction of [
    { OUTBOUND_DESTINATION_POLICY: "typo" },
    { OUTBOUND_BLOCKED_PREFIXES: '[""]' },
    { OUTBOUND_BLOCKED_DESTINATIONS: "null" },
    { OUTBOUND_BLOCKED_NUMBER_TYPES: '["TYPO"]' },
  ])
    expect(() =>
      destinationAllowed("+81364256814", { ...standard, ...restriction }),
    ).toThrow("INVALID_DESTINATION_POLICY");
  expect(
    destinationAllowed("+19002345678", {
      ...standard,
      OUTBOUND_BLOCKED_NUMBER_TYPES: "[]",
    }),
  ).toBe(false);
});
