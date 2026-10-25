// Sanitized notification-only contract snapshot. Never deploy.
async function sendOne(env, db, row) {
  // Atomic claim to prevent concurrent sends
  // of the same notification.
  const claim = await db.prepare(`
    UPDATE call_summaries
    SET notification_status='sending',
        notification_attempts=COALESCE(notification_attempts,0)+1,
        notification_next_attempt_at=datetime('now','+5 minutes')
    WHERE id=?
      AND notification_status IN ('pending','sending')
      AND (
        notification_next_attempt_at IS NULL
        OR notification_next_attempt_at<=CURRENT_TIMESTAMP
      )
  `).bind(row.id).run();

  if (claim.meta?.changes !== 1) return 'skipped';

  // Existing Apps Script accepts the same 'summary' property. Add
  // authenticated outbound context only for correctly correlated calls.
  let emailSummary = row.summary_it;
  if (row.direction === 'outbound' && row.outbound_request_id) {
    const details = [
      'CHIAMATA IN USCITA',
      `Numero chiamato: ${row.destination_number || 'Non disponibile'}`,
      `Lingua richiesta: ${row.language || 'auto'}`,
      `Stato: ${row.outbound_status || 'non disponibile'}`,
      `Durata: ${row.duration_seconds == null ? 'non disponibile' : row.duration_seconds + ' secondi'}`,
      `Compito autorizzato: ${row.instructions || 'Non disponibile'}`,
      '',
      'RIEPILOGO TELNYX',
      row.summary_it
    ];
    emailSummary = details.join('\n');
  }

  try {
    if (!env.APPS_SCRIPT_URL || !env.NOTIFICATION_SECRET) {
      throw new Error('ConfigurationMissing');
    }

    const endpoint = new URL(env.APPS_SCRIPT_URL.trim());

    if (
      endpoint.protocol !== 'https:' ||
      endpoint.hostname !== 'script.google.com' ||
      !endpoint.pathname.startsWith('/macros/s/') ||
      !endpoint.pathname.endsWith('/exec')
    ) {
      throw new Error('InvalidScriptEndpoint');
    }

    const response = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        token: env.NOTIFICATION_SECRET,
        call_id: row.call_id,
        summary: emailSummary,
        created_at: row.created_at
      }),
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error('EmailHTTPFailure');
    }

    const result = await response.json();

    if (result?.ok !== true) {
      throw new Error('EmailRejected');
    }

    await db.prepare(`
      UPDATE call_summaries
      SET notification_status='sent',
          notification_next_attempt_at=NULL,
          notification_last_error=NULL
      WHERE id=?
    `).bind(row.id).run();

    console.log(
      'NOTIFICATION_SENT',
      JSON.stringify({
        duplicate: result.duplicate === true
      })
    );

    return 'sent';

  } catch (error) {
    const name = safeError(error);

    const attemptRow = await db.prepare(`
      SELECT notification_attempts AS n
      FROM call_summaries
      WHERE id=?
    `).bind(row.id).first();

    const attempts = Number(attemptRow?.n || 1);

    const minutes = Math.min(
      360,
      10 * Math.pow(2, Math.min(attempts - 1, 6))
    );

    await db.prepare(`
      UPDATE call_summaries
      SET notification_status='pending',
          notification_next_attempt_at=datetime('now', ?),
          notification_last_error=?
      WHERE id=?
    `).bind(
      `+${minutes} minutes`,
      name,
      row.id
    ).run();

    console.error(
      'NOTIFICATION_RETRY_SCHEDULED',
      JSON.stringify({
        error_type: name,
        attempt: attempts,
        delay_minutes: minutes
      })
    );

    return 'pending';
  }
}

async function getEligible(db, limit) {
  const result = await db.prepare(`
    SELECT
      s.id, s.call_id, s.summary_it, c.created_at,
      c.direction, o.id AS outbound_request_id,
      o.destination_number, o.language, o.status AS outbound_status,
      o.duration_seconds, o.instructions
    FROM call_summaries s
    JOIN calls c ON c.id = s.call_id
    LEFT JOIN outbound_requests o ON o.conversation_id = c.id
    WHERE s.notification_status IN ('pending','sending')
      AND (
        s.notification_next_attempt_at IS NULL
        OR s.notification_next_attempt_at <= CURRENT_TIMESTAMP
      )
    ORDER BY c.created_at ASC
    LIMIT ?
  `).bind(limit).all();
  return result.results || [];
}

async function deliverPending(env, limit = MAX_PER_RUN) {
  const db = env['phone-assistant-db'];

  if (!db) throw new Error('MissingDB');

  const rows = await getEligible(db, limit);
  let sent = 0;

  for (const row of rows) {
    if (await sendOne(env, db, row) === 'sent') {
      sent++;
    }
  }

  console.log(
    'NOTIFICATION_QUEUE',
    JSON.stringify({
      examined: rows.length,
      sent
    })
  );
}



function notificationEvent(outcome) { if (outcome.summaryPresent) { return 'queued'; } }
