// Append to the existing notification project. RECIPIENT, APP_NAME and reply
// remain owned by that project. Never accept a recipient from the request.
function handleSummaryV2(data, properties) {
  if (
    typeof data.call_id !== "string" ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(data.call_id) ||
    data.idempotency_key !== "call-summary-v2:" + data.call_id ||
    typeof data.subject !== "string" ||
    !data.subject.trim() ||
    data.subject.length > 240 ||
    /[\r\n]/.test(data.subject) ||
    typeof data.text !== "string" ||
    !data.text.trim() ||
    data.text.length > 200000 ||
    typeof data.html !== "string" ||
    !data.html.startsWith("<!doctype html>") ||
    data.html.length > 350000 ||
    /<(?:script|iframe|object|embed|form|img|link|svg)\b|\bon\w+\s*=|javascript\s*:/i.test(
      data.html,
    )
  ) {
    return reply({ ok: false, error: "invalid_v2_payload" });
  }
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    data.call_id,
    Utilities.Charset.UTF_8,
  );
  // Same key as legacy notifications: do not resend a call already delivered by v1.
  const key =
    "email_sent_" +
    digest
      .map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0"))
      .join("");
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const state = properties.getProperty(key);
    if (state === "yes")
      return reply({
        ok: true,
        version: 2,
        call_id: data.call_id,
        duplicate: true,
      });
    // MailApp has no idempotency primitive. Persist BEFORE sending. A process
    // crash leaves an uncertain state that requires reconciliation, never resend.
    if (state === "sending_v2")
      return reply({ ok: false, error: "delivery_outcome_unknown" });
    properties.setProperty(key, "sending_v2");
    MailApp.sendEmail({
      to: RECIPIENT,
      name: APP_NAME,
      subject: data.subject,
      body: data.text,
      htmlBody: data.html,
    });
    properties.setProperty(key, "yes");
    return reply({ ok: true, version: 2, call_id: data.call_id, sent: true });
  } catch (_) {
    return reply({ ok: false, error: "delivery_outcome_unknown" });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}
// Public non-sensitive capability check, no configuration or secrets.
function doGet() {
  return reply({ ok: true, version: 2, format: "call-summary-v2" });
}
