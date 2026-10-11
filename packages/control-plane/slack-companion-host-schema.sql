-- Slack companion on the workspace VM: the owner's remote workspace may answer
-- their Slack inbox while no desktop is polling. Additive and idempotent; apply
-- after slack-hub.sql and service-relay.sql.

-- Owner opt-in, default off. At most one answering workspace per owner.
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS slack_companion boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_slack_companion_owner_idx ON workspace(owner_id) WHERE slack_companion AND deleted_at IS NULL;

-- Last desktop poll per user. Only the desktop API writes it; a workspace host
-- leases new Slack items only while it is older than DESKTOP_QUIET_SECONDS.
CREATE TABLE IF NOT EXISTS slack_desktop_presence(
 user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
 device_id text NOT NULL,
 last_poll_at timestamptz NOT NULL DEFAULT now());

-- NULL = posted by a desktop (its answer is queued as a kind:'answer' item);
-- 'workspace:<id>' = posted by that workspace host, which reads the result
-- through approval-status instead.
ALTER TABLE slack_approval ADD COLUMN IF NOT EXISTS requested_by text;
