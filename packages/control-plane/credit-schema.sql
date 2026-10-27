-- Credit management: reminder notices, credit requests and grant audit.
-- Additive and idempotent; apply after the dollars migration (credit_account
-- .balance_usd). Balances stay per user. See docs/credits.md.

-- One row per threshold crossing. The partial unique index keeps a single open
-- notice per user and level, so concurrent debits and the sweep cannot send the
-- same reminder twice. A recovery above the level closes it (cleared_at), which
-- re-arms the reminder for the next crossing.
CREATE TABLE IF NOT EXISTS credit_notice (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 level text NOT NULL CHECK(level IN ('low','zero','final','paused')),
 balance_usd numeric(18,6) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 cleared_at timestamptz,
 -- Email outbox: delivered after the debit transaction commits, retried by the
 -- sweep. 'skipped' marks a lighter level superseded by a heavier one crossed
 -- at the same time (one email, the most severe).
 delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','sent','skipped','failed')),
 delivery_attempts integer NOT NULL DEFAULT 0,
 claimed_at timestamptz,
 sent_at timestamptz,
 last_error text
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_notice_open_idx ON credit_notice(user_id,level) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS credit_notice_outbox_idx ON credit_notice(created_at) WHERE delivery='pending' AND cleared_at IS NULL;

-- "Request more credit" from the desktop: one per user per day reaches support.
CREATE TABLE IF NOT EXISTS credit_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 balance_usd numeric(18,6) NOT NULL,
 note text CHECK(note IS NULL OR length(note)<=1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_by text
);
CREATE INDEX IF NOT EXISTS credit_request_user_time_idx ON credit_request(user_id,created_at DESC);

-- Who granted an adjustment, for the ledger audit trail.
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS actor text;
-- Per-workspace usage history on the account page.
CREATE INDEX IF NOT EXISTS credit_ledger_user_usage_idx ON credit_ledger(user_id,occurred_at DESC) WHERE kind='usage';
