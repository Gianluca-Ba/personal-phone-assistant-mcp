// Sanitized outbound-only contract snapshot. Never deploy this fixture.
const encoder = new TextEncoder();
function reply(body,status=200){return Response.json(body,{status})}
const OUTBOUND_MAX_SECONDS = 300;

function outboundAuthorized(request, secret) {
  const authorization = request.headers.get(
    "authorization"
  );

  return Boolean(
    secret &&
    secret.length >= 32 &&
    authorization === `Bearer ${secret}`
  );
}

function validOutboundNumber(number) {
  if (typeof number !== "string") return false;

  // E.164 format, up to 15 digits.
  if (!/^\+[1-9]\d{7,14}$/.test(number)) {
    return false;
  }

  // Japan: geographic and mobile numbers.
  // Exclude common special/non-geographic prefixes.
  if (number.startsWith("+81")) {
    return (
      /^\+81[1-9]\d{8,9}$/.test(number) &&
      !/^\+81(?:120|570|990|800)/.test(number)
    );
  }

  // Italy.
  if (number.startsWith("+39")) {
    return (
      /^\+39\d{9,11}$/.test(number) &&
      !/^\+39(?:89|144|166|899)/.test(number)
    );
  }

  // USA: basic NANP format, excluding 900 numbers.
  if (number.startsWith("+1")) {
    return (
      /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(number) &&
      !/^\+1\d{3}900\d{4}$/.test(number)
    );
  }

  return false;
}

async function createOutboundRequest(request, env, db) {
  if (
    !outboundAuthorized(
      request,
      env.OUTBOUND_API_SECRET
    )
  ) {
    return reply({ error: "Unauthorized" }, 401);
  }

  const length = request.headers.get("content-length");

  if (length && Number(length) > 8192) {
    return reply({ error: "Request too large" }, 413);
  }

  let body;

  try {
    const raw = await request.text();

    if (encoder.encode(raw).length > 8192) {
      return reply({ error: "Request too large" }, 413);
    }

    body = JSON.parse(raw);
  } catch {
    return reply({ error: "Invalid JSON" }, 400);
  }

  const number = body?.destination_number;
  const instructions = body?.instructions;
  const language = body?.language || "auto";

  if (!validOutboundNumber(number)) {
    return reply({
      error: "Invalid or unsupported destination number"
    }, 422);
  }

  if (
    typeof instructions !== "string" ||
    instructions.trim().length < 10 ||
    instructions.length > 3000
  ) {
    return reply({
      error: "Instructions must contain 10-3000 characters"
    }, 422);
  }

  if (
    typeof language !== "string" ||
    !["auto", "ja", "it", "en", "pt"].includes(language)
  ) {
    return reply({
      error: "Unsupported language"
    }, 422);
  }

  const id = crypto.randomUUID();

  await db.prepare(`
    INSERT INTO outbound_requests (
      id,
      destination_number,
      instructions,
      language,
      status
    )
    VALUES (?, ?, ?, ?, 'pending_approval')
  `).bind(
    id,
    number,
    instructions.trim(),
    language
  ).run();

  return reply({
    id,
    status: "pending_approval",
    destination_number: number,
    instructions: instructions.trim(),
    language,
    maximum_duration_seconds: OUTBOUND_MAX_SECONDS,
    authorized: false
  }, 201);
}

async function approveOutboundRequest(
  request,
  env,
  db,
  requestId
) {
  if (
    !outboundAuthorized(
      request,
      env.OUTBOUND_APPROVAL_SECRET
    )
  ) {
    return reply({ error: "Unauthorized" }, 401);
  }

  const row = await db.prepare(`
    SELECT *
    FROM outbound_requests
    WHERE id = ?
  `).bind(requestId).first();

  if (!row) {
    return reply({ error: "Request not found" }, 404);
  }

  if (row.status !== "pending_approval") {
    return reply({
      error: "Request is not awaiting approval",
      status: row.status
    }, 409);
  }

  if (
    !validOutboundNumber(row.destination_number)
  ) {
    return reply({
      error: "Destination is no longer valid"
    }, 422);
  }

  // Atomically claim this request.
  // Only one outbound request can be dialing.
  const claim = await db.prepare(`
    UPDATE outbound_requests
    SET
      status = 'dialing',
      authorized_at = CURRENT_TIMESTAMP,
      started_at = CURRENT_TIMESTAMP,
      last_error = NULL
    WHERE id = ?
      AND status = 'pending_approval'
      AND NOT EXISTS (
        SELECT 1
        FROM outbound_requests
        WHERE status = 'dialing'
          AND id != ?
      )
  `).bind(requestId, requestId).run();

  if (claim.meta?.changes !== 1) {
    return reply({
      error: "Already processing or another outbound call is active"
    }, 409);
  }

  const required = [
    "TELNYX_API_KEY",
    "TELNYX_TEXML_APP_ID",
    "TELNYX_ASSISTANT_ID",
    "TELNYX_OUTBOUND_FROM"
  ];

  if (required.some(key => !env[key])) {
    await db.prepare(`
      UPDATE outbound_requests
      SET status = 'failed',
          last_error = 'configuration_missing',
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(requestId).run();

    return reply({
      error: "Telnyx configuration missing"
    }, 503);
  }

  const endpoint =
    "https://api.telnyx.com/v2/texml/ai_calls/" +
    encodeURIComponent(env.TELNYX_TEXML_APP_ID);


const callbackToken = crypto.randomUUID();

  await db.prepare(`
    UPDATE outbound_requests
    SET callback_token = ?
    WHERE id = ? AND status = 'dialing'
  `).bind(callbackToken, requestId).run();

  const callbackUrl =
    `https://phone.example` +
    `/webhooks/outbound-status/${requestId}/${callbackToken}`;

  const telnyxPayload = {
    From: env.TELNYX_OUTBOUND_FROM,
    To: row.destination_number,
    AIAssistantId: env.TELNYX_ASSISTANT_ID,
    TimeLimit: OUTBOUND_MAX_SECONDS,
    Timeout: 30,
    StatusCallback: callbackUrl,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent:
      "initiated ringing answered completed no-answer busy canceled failed",
    AIAssistantDynamicVariables: {
      outbound_mode: "true",
      outbound_task: row.instructions,
      outbound_language: row.language || "auto",
      outbound_request_id: row.id
    }
  };

  let response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${env.TELNYX_API_KEY}`,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify(telnyxPayload),
      redirect: "manual"
    });

} catch (error) {
  // Only log the error class and a controlled category.
  // Never log API keys, request bodies or personal data.

  const errorName =
    error instanceof Error ? error.name : "Unknown";

  const rawMessage =
    error instanceof Error ? error.message : "";

  const errorCategory =
    /invalid url/i.test(rawMessage)
      ? "invalid_url"
      : /fetch failed/i.test(rawMessage)
      ? "fetch_failed"
      : /connection|network|dns/i.test(rawMessage)
      ? "network_error"
      : /redirect/i.test(rawMessage)
      ? "redirect_error"
      : "other_fetch_error";

  console.error("TELNYX_OUTBOUND_FETCH_FAILED",
    JSON.stringify({
      error_name: errorName,
      error_category: errorCategory,
      app_id_type: typeof env.TELNYX_TEXML_APP_ID,
      api_key_configured: Boolean(env.TELNYX_API_KEY)
    })
  );

  await db.prepare(`
    UPDATE outbound_requests
    SET last_error = ?
    WHERE id = ?
  `).bind(
    errorCategory,
    requestId
  ).run();

  return reply({
    status: "dispatch_unknown",
    error_category: errorCategory,
    message: "Verify Telnyx before another attempt"
  }, 202);
}


  if (!response.ok) {
    await db.prepare(`
      UPDATE outbound_requests
      SET
        status = 'failed',
        last_error = ?,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      `telnyx_http_${response.status}`,
      requestId
    ).run();

    return reply({
      status: "failed",
      provider_status: response.status
    }, 502);
  }

  let result;

  try {
    result = await response.json();
  } catch {
    result = {};
  }

  const callSid =
    typeof result.call_sid === "string"
      ? result.call_sid
      : null;

  await db.prepare(`
    UPDATE outbound_requests
    SET telnyx_call_id = ?
    WHERE id = ?
  `).bind(callSid, requestId).run();

  return reply({
    id: requestId,
    status: "dialing",
    destination_number: row.destination_number,
    telnyx_call_id: callSid,
    maximum_duration_seconds: OUTBOUND_MAX_SECONDS
  }, 202);
}


async function handleOutboundStatus(request, db, requestId, token) {
  if (request.method !== "POST") {
    return reply({ error: "Method not allowed" }, 405);
  }

  const row = await db.prepare(`
    SELECT status, callback_token, telnyx_call_id
    FROM outbound_requests
    WHERE id = ?
  `).bind(requestId).first();

  if (!row || !row.callback_token || row.callback_token !== token) {
    return reply({ error: "Unauthorized" }, 401);
  }

  const raw = await request.text();

  if (raw.length > 8192) {
    return reply({ error: "Payload too large" }, 413);
  }

  let fields;

  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      fields = JSON.parse(raw);
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw));
    }
  } catch {
    return reply({ error: "Invalid callback" }, 400);
  }

  const callSid = String(fields.CallSid || fields.call_sid || "");
  const status = String(
    fields.CallStatus || fields.CallStatusEvent ||
    fields.CallStatusCallbackEvent || fields.call_status || ""
  ).toLowerCase();

  // Never update a different call.
  if (row.telnyx_call_id && callSid !== row.telnyx_call_id) {
    return reply({ error: "Call ID mismatch" }, 409);
  }

  const terminal = new Set([
    "completed", "no-answer", "busy", "canceled", "failed"
  ]);

  if (status === "answered") {
    await db.prepare(`
      UPDATE outbound_requests
      SET answered_at = COALESCE(answered_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND status = 'dialing'
    `).bind(requestId).run();
  }

  if (terminal.has(status)) {
    const duration = Number(fields.CallDuration);

    await db.prepare(`
      UPDATE outbound_requests
      SET status = ?,
          completed_at = CURRENT_TIMESTAMP,
          duration_seconds = ?,
          last_error = CASE
            WHEN ? = 'completed' THEN NULL
            ELSE ?
          END
      WHERE id = ?
        AND status = 'dialing'
    `).bind(
      status === "completed" ? "completed" : "failed",
      Number.isFinite(duration) && duration >= 0
        ? Math.floor(duration) : null,
      status,
      status,
      requestId
    ).run();
  }

  return reply({ received: true });
}



export default { async fetch(request,env) {
 const url=new URL(request.url),db=env['phone-assistant-db'];
 if(url.pathname==='/outbound/requests')return createOutboundRequest(request,env,db);
 const a=/^\/outbound\/requests\/([a-f0-9-]{36})\/approve$/.exec(url.pathname);
 if(a)return approveOutboundRequest(request,env,db,a[1]);
 const c=/^\/webhooks\/outbound-status\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(url.pathname);
 if(c)return handleOutboundStatus(request,db,c[1],c[2]);
 return reply({error:'Not found'},404);
}};
