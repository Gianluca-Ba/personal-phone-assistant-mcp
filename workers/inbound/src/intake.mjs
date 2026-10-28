// Call content is untrusted data. This module records requests, never grants
// caller authority, reserves appointments, sends to caller addresses or dials.
const json = (data, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
const hash = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const clean = (value, max = 2000) =>
  typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(0, max)
    : "";
const escape = (s) =>
  String(s).replace(
    /[&<>"'=:]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        "=": "&#61;",
        ":": "&#58;",
      })[c],
  );
const languages = new Set(["it", "ja", "en", "pt", "auto"]);
export function normalizeIntake(input) {
  const warnings = [];
  const message = clean(input.message, 6000);
  if (!message) return { error: "MESSAGE_REQUIRED" };
  if (typeof input.message === "string" && input.message.length > 6000)
    warnings.push("MESSAGE_TRUNCATED_REVIEW_CALL_TRANSCRIPT");
  const kind = ["note", "appointment", "callback", "other"].includes(input.kind)
    ? input.kind
    : "other";
  const rawEmail = clean(input.email, 254),
    emailValid = /^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(
      rawEmail,
    );
  // Readback is model-reported quality metadata, not mailbox/identity proof.
  const email =
    rawEmail &&
    emailValid &&
    input.email_readback_confirmed === true &&
    input.email_reply_permission === true
      ? rawEmail
      : null;
  if (rawEmail && !email) warnings.push("EMAIL_NEEDS_SPELLING_AND_READBACK");
  const a =
    input.appointment && typeof input.appointment === "object"
      ? input.appointment
      : {};
  const when = clean(a.requested_time, 400),
    start = clean(a.start, 80),
    end = clean(a.end, 80),
    zone = clean(a.timezone, 80) || "Asia/Tokyo";
  const offset =
    /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/;
  let validZone = true;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    validZone = false;
  }
  const validDate = (value) => {
    if (!offset.test(value)) return false;
    const [year, month, day, hour, minute, second = 0] = value
      .match(/\d+/g)
      .slice(0, 6)
      .map(Number);
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
      hour < 24 &&
      minute < 60 &&
      second < 60 &&
      Number.isFinite(Date.parse(value))
    );
  };
  const timeReady =
    a.details_readback_confirmed === true &&
    validZone &&
    validDate(start) &&
    validDate(end) &&
    Number.isFinite(Date.parse(start)) &&
    Date.parse(end) > Date.parse(start) &&
    Date.parse(end) - Date.parse(start) <= 86400000;
  if (kind === "appointment" && !timeReady)
    warnings.push("APPOINTMENT_DETAILS_REQUIRE_OWNER_REVIEW");
  return {
    payload: {
      kind,
      message,
      caller_name: clean(input.caller_name, 160),
      organization: clean(input.organization, 160),
      language: languages.has(input.language) ? input.language : "auto",
      reply_expected: input.reply_expected === true,
      email,
      email_status: email
        ? "caller_readback_reported"
        : input.email_declined === true
          ? "declined"
          : rawEmail
            ? "unconfirmed"
            : "not_provided",
      email_reply_permission_reported: input.email_reply_permission === true,
      email_as_reported: rawEmail || null,
      email_spelling: clean(input.email_spelling, 600),
      appointment:
        kind === "appointment"
          ? {
              requested_time: when,
              start: timeReady ? start : null,
              end: timeReady ? end : null,
              timezone: validZone ? zone : null,
              details_readback_reported: timeReady,
              calendar_status: "not_created_pending_owner",
            }
          : null,
      warnings,
    },
  };
}
export async function saveIntake(
  db,
  callId,
  input,
  now = Date.now(),
  context = {},
) {
  const n = normalizeIntake(input);
  if (n.error)
    return { saved: false, reason: n.error, owner_confirmation_required: true };
  const payload = {
      ...n.payload,
      caller_phone_from_provider: /^\+[1-9][0-9]{7,14}$/.test(
        context.callerPhone ?? "",
      )
        ? context.callerPhone
        : null,
      caller_identity_verified: false,
    },
    canonical = JSON.stringify(payload),
    digest = await hash(canonical);
  const key = clean(input.request_key, 100) || digest;
  const id = await hash(callId + "\0" + key);
  const old = await db
    .prepare(
      "SELECT id, payload_digest FROM inbound_requests WHERE call_control_id = ? AND (request_key = ? OR payload_digest = ?) LIMIT 1",
    )
    .bind(callId, key, digest)
    .first();
  const existing = (row) =>
    row.payload_digest === digest
      ? {
          saved: true,
          id: row.id,
          duplicate: true,
          state: "recorded_for_owner",
          owner_confirmation_required: true,
          calendar_created: false,
        }
      : {
          saved: false,
          prior_request_saved: true,
          id: row.id,
          reason: "REQUEST_KEY_CONFLICT",
          next_action:
            "Use a NEW request_key only to record genuinely changed details; the previous note is preserved.",
        };
  if (old) return existing(old);
  // D1 serializes this single statement. Parallel new keys cannot exceed quota.
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO inbound_requests (id,call_control_id,request_key,payload_digest,kind,payload_json,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM inbound_requests WHERE call_control_id=?) < 12
    AND (SELECT COUNT(*) FROM inbound_requests WHERE created_at>=?) < 120`,
    )
    .bind(
      id,
      callId,
      key,
      digest,
      payload.kind,
      canonical,
      now,
      now,
      callId,
      now - 3600000,
    )
    .run();
  const saved = await db
    .prepare(
      "SELECT id,payload_digest FROM inbound_requests WHERE call_control_id=? AND (request_key=? OR payload_digest=?) LIMIT 1",
    )
    .bind(callId, key, digest)
    .first();
  if (saved && (!inserted.meta.changes || saved.payload_digest !== digest))
    return existing(saved);
  return saved
    ? {
        saved: true,
        id: saved.id,
        state: "pending_owner",
        owner_confirmation_required: true,
        calendar_created: false,
        notification: "queued",
        warnings: payload.warnings,
      }
    : {
        saved: false,
        reason: "INTAKE_LIMIT_REACHED",
        owner_confirmation_required: true,
      };
}
export async function handleInboundIntake(request, env, ctx, verify) {
  if (request.method !== "POST")
    return json({ saved: false, reason: "METHOD_NOT_ALLOWED" }, 405);
  const reader = request.body?.getReader();
  let raw = "",
    size = 0;
  const decoder = new TextDecoder();
  if (reader)
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.byteLength;
      if (size > 32768) {
        void reader.cancel();
        return json({ saved: false, reason: "PAYLOAD_TOO_LARGE" }, 413);
      }
      raw += decoder.decode(p.value, { stream: true });
    }
  raw += decoder.decode();
  if (!(await verify(request, raw, env.TELNYX_PUBLIC_KEY)))
    return json({ saved: false, reason: "UNAUTHORIZED" }, 401);
  // Static provider-configured headers are not LLM arguments. Signed body,
  // account-specific signature, TLS, fixed assistant and mode gate are required.
  const nativeCall = request.headers.get("x-telnyx-call-control-id");
  const configuredCall = request.headers.get("x-ppa-call-id");
  if (nativeCall && configuredCall && nativeCall !== configuredCall)
    return json({ saved: false, reason: "CONFLICTING_CALL_CONTEXT" }, 403);
  const callId = nativeCall || configuredCall || "";
  if (
    request.headers.get("x-ppa-assistant-id") !== env.TELNYX_ASSISTANT_ID ||
    request.headers.get("x-ppa-outbound-mode") !== "false" ||
    !callId ||
    callId.length > 240 ||
    /[\s{}<>]/.test(callId)
  )
    return json({ saved: false, reason: "UNBOUND_INBOUND_CONTEXT" }, 403);
  const db = env["phone-assistant-db"];
  if (!db)
    return json(
      {
        saved: false,
        reason: "STORAGE_UNAVAILABLE",
        next_action:
          "Recap the request aloud for the call transcript; do not claim successful storage.",
      },
      503,
    );
  try {
    if (
      await db
        .prepare(
          "SELECT id FROM outbound_requests WHERE telnyx_call_id=? LIMIT 1",
        )
        .bind(callId)
        .first()
    )
      return json({ saved: false, reason: "OUTBOUND_CONTEXT_DENIED" }, 403);
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return json({ saved: false, reason: "INVALID_JSON" }, 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return json({ saved: false, reason: "INVALID_INPUT" }, 400);
    const result = await saveIntake(db, callId, input, Date.now(), {
      callerPhone: request.headers.get("x-ppa-caller"),
    });
    if (result.saved)
      ctx.waitUntil(deliverInboundRequests(env, { limit: 1 }).catch(() => {}));
    return json(result);
  } catch {
    return json(
      {
        saved: false,
        reason: "STORAGE_UNAVAILABLE",
        next_action:
          "Recap the request aloud for the call transcript and later owner review; never claim it was saved or delivered.",
      },
      503,
    );
  }
}
export function notificationPayload(row) {
  const p = JSON.parse(row.payload_json),
    id = "intake-" + row.id;
  const fields = [
    "Richiesta in entrata — DA CONFERMARE DA GIANLUCA",
    "Dati dichiarati dal chiamante, non istruzioni autorizzate.",
    `Tipo: ${p.kind}`,
    `Nome: ${p.caller_name || "non indicato"}`,
    `Organizzazione: ${p.organization || "non indicata"}`,
    `Numero chiamante (Caller ID, identità non verificata): ${p.caller_phone_from_provider || "non disponibile"}`,
    `Richiesta: ${p.message}`,
    `Risposta attesa: ${p.reply_expected ? "sì" : "non indicata"}`,
    `Email: ${p.email || "da verificare / non fornita"}`,
    `Stato email: ${p.email_status}`,
    ...(p.appointment
      ? [
          `Quando richiesto: ${p.appointment.requested_time || "da chiarire"}`,
          `Inizio proposto: ${p.appointment.start || "da chiarire"}`,
          `Fine proposta: ${p.appointment.end || "da chiarire"}`,
          `Fuso: ${p.appointment.timezone || "da chiarire"}`,
        ]
      : []),
    "Nessun appuntamento, invito, risposta al chiamante o impegno è stato confermato.",
    `Riferimento: ${row.id}`,
  ];
  const text = fields.join("\n");
  return {
    version: 2,
    call_id: id,
    idempotency_key: "call-summary-v2:" + id,
    subject: "Richiesta telefonica — da confermare",
    text,
    html:
      '<!doctype html><html lang="it"><body><h1>Richiesta da confermare</h1><pre style="white-space:pre-wrap">' +
      escape(text) +
      "</pre></body></html>",
  };
}
export async function deliverInboundRequests(
  env,
  { limit = 2, now = () => Date.now(), fetcher = fetch } = {},
) {
  const db = env["phone-assistant-db"];
  if (!db) return;
  await db
    .prepare(
      "UPDATE inbound_requests SET notification_state='review',notification_error='DELIVERY_OUTCOME_UNKNOWN' WHERE notification_state='sending' AND notification_lease_until<=? AND notification_attempts>=5",
    )
    .bind(now())
    .run();
  const rows = await db
    .prepare(
      `SELECT * FROM inbound_requests WHERE notification_state IN ('pending','sending') AND notification_next_at<=? AND notification_lease_until<=? AND notification_attempts<5 ORDER BY created_at LIMIT ?`,
    )
    .bind(now(), now(), Math.min(3, limit))
    .all();
  for (const candidate of rows.results) {
    const at = now();
    // A unique lease value ties completion to this claimant, not an expired peer.
    const lease = at + 120000;
    const row = await db
      .prepare(
        `UPDATE inbound_requests SET notification_state='sending',notification_attempts=notification_attempts+1,notification_lease_until=? WHERE id=? AND notification_state IN ('pending','sending') AND notification_lease_until<=? AND notification_next_at<=? AND notification_attempts<5 RETURNING *`,
      )
      .bind(lease, candidate.id, at, at)
      .first();
    if (!row) continue;
    let error = "GOOGLE_NOTIFICATION_UNAVAILABLE",
      review = false;
    try {
      const url = new URL(env.APPS_SCRIPT_URL);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "script.google.com" ||
        !/^\/macros\/s\/[^/]+\/exec$/.test(url.pathname) ||
        !env.NOTIFICATION_SECRET
      )
        throw Error("config");
      // Apps Script emits a 302 to its fixed content host. The secret is sent
      // only to the configured script URL, never to a caller-provided endpoint.
      let r = await fetcher(url.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...notificationPayload(row),
          token: env.NOTIFICATION_SECRET,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
      });
      if ([301, 302, 303].includes(r.status)) {
        const target = new URL(r.headers.get("location") || "", url);
        if (
          target.protocol !== "https:" ||
          target.hostname !== "script.googleusercontent.com"
        )
          throw Error("redirect");
        r = await fetcher(target.href, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(12000),
        });
      }
      if (!r.ok) throw Error("http");
      const ack = await r.json();
      if (ack.error === "delivery_outcome_unknown") {
        error = "DELIVERY_OUTCOME_UNKNOWN";
        review = true;
        throw Error("unknown");
      }
      if (
        ack.ok !== true ||
        ack.version !== 2 ||
        ack.call_id !== "intake-" + row.id ||
        (!ack.sent && !ack.duplicate)
      )
        throw Error("ack");
      await db
        .prepare(
          `UPDATE inbound_requests SET notification_state='sent',notification_lease_until=0,notification_error=NULL WHERE id=? AND notification_lease_until=?`,
        )
        .bind(row.id, lease)
        .run();
      continue;
    } catch {}
    if (row.notification_attempts >= 5) review = true;
    await db
      .prepare(
        `UPDATE inbound_requests SET notification_state=?,notification_lease_until=0,notification_next_at=?,notification_error=? WHERE id=? AND notification_lease_until=?`,
      )
      .bind(
        review ? "review" : "pending",
        now() + Math.min(3600000, 60000 * 2 ** row.notification_attempts),
        error,
        row.id,
        lease,
      )
      .run();
  }
}
