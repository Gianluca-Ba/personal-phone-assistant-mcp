import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export interface DestinationEnv {
  OUTBOUND_DESTINATION_POLICY?: string;
  OUTBOUND_ALLOWED_DESTINATIONS?: string;
  OUTBOUND_ALLOWED_DESTINATIONS_SECRET?: string;
  OUTBOUND_BLOCKED_PREFIXES?: string;
  OUTBOUND_BLOCKED_DESTINATIONS?: string;
  OUTBOUND_BLOCKED_NUMBER_TYPES?: string;
}
export const DEFAULT_BLOCKED_PREFIXES = [
  "+870",
  "+878",
  "+881",
  "+882",
  "+883",
  "+979",
];
const standardTypes = new Set([
  "MOBILE",
  "FIXED_LINE",
  "FIXED_LINE_OR_MOBILE",
  "VOIP",
]);
const knownTypes = new Set([
  ...standardTypes,
  "PREMIUM_RATE",
  "TOLL_FREE",
  "SHARED_COST",
  "PERSONAL_NUMBER",
  "PAGER",
  "UAN",
  "VOICEMAIL",
]);
const e164 = /^\+[1-9]\d{1,14}$/;
const legacyNumber = /^\+[1-9]\d{7,14}$/;
function list(
  raw: string | undefined,
  fallback: string[],
  valid: (s: string) => boolean,
) {
  try {
    const values: unknown = raw === undefined ? fallback : JSON.parse(raw);
    if (
      !Array.isArray(values) ||
      values.length > 1000 ||
      !values.every((v) => typeof v === "string" && valid(v))
    )
      throw new Error();
    return values as string[];
  } catch {
    throw new Error("INVALID_DESTINATION_POLICY");
  }
}
export function destinationAllowed(
  destination: string,
  env: DestinationEnv,
): boolean {
  const policy = env.OUTBOUND_DESTINATION_POLICY ?? "allowlist";
  if (policy !== "allowlist" && policy !== "all_standard")
    throw new Error("INVALID_DESTINATION_POLICY");
  if (!e164.test(destination)) return false;
  if (policy === "allowlist") {
    if (!legacyNumber.test(destination)) return false;
    // Backward-compatible private allowlist precedence is confined to this mode.
    return list(
      env.OUTBOUND_ALLOWED_DESTINATIONS_SECRET ??
        env.OUTBOUND_ALLOWED_DESTINATIONS,
      [],
      (value) => legacyNumber.test(value),
    ).includes(destination);
  }
  // Never read or parse the allowlist Secret in all_standard mode.
  const prefixes = list(
    env.OUTBOUND_BLOCKED_PREFIXES,
    DEFAULT_BLOCKED_PREFIXES,
    (value) => /^\+[1-9]\d{0,14}$/.test(value),
  );
  const blocked = list(env.OUTBOUND_BLOCKED_DESTINATIONS, [], (value) =>
    /^\+[1-9]\d{1,14}$/.test(value),
  );
  const types = list(env.OUTBOUND_BLOCKED_NUMBER_TYPES, [], (value) =>
    knownTypes.has(value),
  );
  if (
    blocked.includes(destination) ||
    prefixes.some((prefix) => destination.startsWith(prefix))
  )
    return false;
  const phone = parsePhoneNumberFromString(destination);
  if (!phone || phone.number !== destination || !phone.isValid()) return false;
  const type = phone.getType();
  // Short/emergency codes, premium, special services and unknown categories
  // are never classified as standard. Metadata is not a price/routing lookup.
  return !!type && standardTypes.has(type) && !types.includes(type);
}
