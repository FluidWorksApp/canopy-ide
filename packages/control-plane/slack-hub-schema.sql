-- Canopy Slack hub: one Slack app, installs, verified identity links, and a
-- per-user inbox the desktop drains. Additive and idempotent; apply after
-- schema.sql. Bot tokens are stored only as AES-256-GCM ciphertext.
CREATE TABLE IF NOT EXISTS slack_installation(
 team_id text PRIMARY KEY CHECK(team_id ~ '^[A-Z0-9]{2,32}$'),
 team_name text NOT NULL,
 bot_user_id text NOT NULL CHECK(bot_user_id ~ '^[UW][A-Z0-9]{2,32}$'),
 bot_token_ciphertext text NOT NULL,
 bot_token_iv text NOT NULL,
 bot_token_tag text NOT NULL,
 installed_by text REFERENCES "user"(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS slack_installation_installer_idx ON slack_installation(installed_by);

-- A link exists only because Slack returned (team, user) to an OAuth flow the
-- Canopy user started. One Slack identity per Canopy user per Slack team.
CREATE TABLE IF NOT EXISTS slack_identity(
 team_id text NOT NULL,
 slack_user_id text NOT NULL CHECK(slack_user_id ~ '^[UW][A-Z0-9]{2,32}$'),
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,slack_user_id),
 UNIQUE(user_id,team_id));

CREATE TABLE IF NOT EXISTS slack_oauth_state(
 nonce text PRIMARY KEY CHECK(nonce ~ '^[A-Za-z0-9_-]{22,64}$'),
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('install','link')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS slack_oauth_state_expiry_idx ON slack_oauth_state(expires_at);

CREATE TABLE IF NOT EXISTS slack_event_seen(
 event_id text PRIMARY KEY,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours');
CREATE INDEX IF NOT EXISTS slack_event_seen_expiry_idx ON slack_event_seen(expires_at);

-- payload is exactly what the desktop sees; team/channel/thread/sender are
-- server-only routing and never leave the control plane.
CREATE TABLE IF NOT EXISTS slack_inbox(
 id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{8,64}$'),
 target_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('message','answer')),
 payload jsonb NOT NULL,
 team_id text,
 channel_id text,
 channel_type text CHECK(channel_type IS NULL OR channel_type IN('im','channel')),
 thread_ts text,
 sender_slack_user_id text,
 lease_owner text,
 lease_expires_at timestamptz,
 acked_at timestamptz,
 replied_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 CHECK(kind='answer' OR (team_id IS NOT NULL AND channel_id IS NOT NULL AND channel_type IS NOT NULL)));
CREATE INDEX IF NOT EXISTS slack_inbox_target_idx ON slack_inbox(target_user_id,created_at) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS slack_inbox_expiry_idx ON slack_inbox(expires_at);

CREATE TABLE IF NOT EXISTS slack_approval(
 id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{22,64}$'),
 proposal_id text NOT NULL CHECK(proposal_id ~ '^[A-Za-z0-9_-]{8,64}$'),
 inbox_id text NOT NULL,
 target_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 team_id text NOT NULL,
 channel_id text NOT NULL,
 message_ts text NOT NULL,
 summary text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 resolution text CHECK(resolution IS NULL OR resolution IN('approved','denied','expired')),
 resolved_by text,
 resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(target_user_id,proposal_id));
CREATE INDEX IF NOT EXISTS slack_approval_expiry_idx ON slack_approval(expires_at);

CREATE TABLE IF NOT EXISTS slack_unlinked_notice(
 team_id text NOT NULL,
 slack_user_id text NOT NULL,
 last_sent_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,slack_user_id));
