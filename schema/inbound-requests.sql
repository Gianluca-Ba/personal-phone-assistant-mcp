-- Additive only: existing calls, summaries and outbound tables are untouched.
CREATE TABLE IF NOT EXISTS inbound_requests (
  id TEXT PRIMARY KEY,
  call_control_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('note','appointment','callback','other')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_owner' CHECK(state IN ('pending_owner','approved','declined','needs_information')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  owner_decision_json TEXT,
  notification_state TEXT NOT NULL DEFAULT 'pending' CHECK(notification_state IN ('pending','sending','sent','review')),
  notification_attempts INTEGER NOT NULL DEFAULT 0,
  notification_next_at INTEGER NOT NULL DEFAULT 0,
  notification_lease_until INTEGER NOT NULL DEFAULT 0,
  notification_error TEXT,
  UNIQUE(call_control_id, request_key),
  UNIQUE(call_control_id, payload_digest)
);
CREATE INDEX IF NOT EXISTS inbound_requests_state ON inbound_requests(state, created_at);
CREATE INDEX IF NOT EXISTS inbound_requests_delivery ON inbound_requests(notification_state, notification_next_at);
