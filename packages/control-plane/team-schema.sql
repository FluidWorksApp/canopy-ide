-- Additive migration; no existing owner or personal credentials are migrated.
CREATE TABLE IF NOT EXISTS workspace_member (
 workspace_id text NOT NULL REFERENCES workspace(id), user_id text NOT NULL REFERENCES "user"(id),
 role text NOT NULL CHECK(role IN('admin','member','viewer')),
 permissions jsonb NOT NULL DEFAULT '{"projects":"selected","projectIds":[],"git":"personal","agents":"personal","sessions":"private"}',
 access_version integer NOT NULL DEFAULT 1, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS workspace_invitation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspace(id),
 email text NOT NULL, role text NOT NULL CHECK(role IN('admin','member','viewer')), permissions jsonb NOT NULL,
 token_hash text UNIQUE NOT NULL, invited_by text NOT NULL REFERENCES "user"(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 accepted_by text REFERENCES "user"(id), accepted_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_access_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspace(id),
 actor_id text NOT NULL REFERENCES "user"(id), action text NOT NULL, subject_id text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_member_user_idx ON workspace_member(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_invitation_email_idx ON workspace_invitation(email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS team (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 owner_id text NOT NULL REFERENCES "user"(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS team_member (
 team_id uuid NOT NULL REFERENCES team(id), user_id text NOT NULL REFERENCES "user"(id),
 role text NOT NULL CHECK(role IN('owner','admin','member')), joined_at timestamptz NOT NULL DEFAULT now(),
 removed_at timestamptz, PRIMARY KEY(team_id,user_id)
);
CREATE TABLE IF NOT EXISTS team_invitation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES team(id),
 email text NOT NULL, invited_by text NOT NULL REFERENCES "user"(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
 accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_invitation_pending_idx ON team_invitation(team_id,email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS team_message (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, team_id uuid NOT NULL REFERENCES team(id),
 sender_id text NOT NULL REFERENCES "user"(id), recipient_id text REFERENCES "user"(id),
 client_id uuid NOT NULL, body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(sender_id,client_id)
);
CREATE INDEX IF NOT EXISTS team_message_timeline_idx ON team_message(team_id,id);
CREATE TABLE IF NOT EXISTS team_read_cursor (
 team_id uuid NOT NULL REFERENCES team(id), user_id text NOT NULL REFERENCES "user"(id),
 conversation text NOT NULL, message_id bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(team_id,user_id,conversation)
);
