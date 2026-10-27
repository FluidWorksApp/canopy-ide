-- Additive: human-readable Canopy links (lib/readable-links.mjs).
-- A link names a target; it grants nothing. Access is re-evaluated on every
-- resolve from workspace grants, session sharing and team membership.
CREATE TABLE IF NOT EXISTS link_namespace (
 handle text PRIMARY KEY CHECK(handle ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
 team_id uuid UNIQUE REFERENCES team(id),
 user_id text UNIQUE REFERENCES "user"(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((team_id IS NULL)<>(user_id IS NULL))
);
CREATE TABLE IF NOT EXISTS readable_link (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 namespace text NOT NULL REFERENCES link_namespace(handle),
 path text NOT NULL CHECK(length(path) BETWEEN 1 AND 200 AND path ~ '^[a-z0-9][a-z0-9/-]*[a-z0-9]$|^[a-z0-9]$'),
 kind text NOT NULL CHECK(kind IN('workspace','session','message')),
 -- Identifiers only. Message bodies never enter this database.
 target jsonb NOT NULL,
 target_key text NOT NULL,
 workspace_id text REFERENCES workspace(id),
 team_id uuid REFERENCES team(id),
 created_by text NOT NULL REFERENCES "user"(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoked_by text REFERENCES "user"(id),
 -- Across revoked rows too: a revoked path is never reissued to something else.
 UNIQUE(namespace,path)
);
-- One live link per target per namespace, so "Copy link" is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS readable_link_target_idx ON readable_link(namespace,target_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS readable_link_target_lookup_idx ON readable_link(target_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS readable_link_workspace_idx ON readable_link(workspace_id) WHERE workspace_id IS NOT NULL;
