-- Additive only: existing personal ownership and billing remain unchanged.
CREATE TABLE IF NOT EXISTS organization (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 created_by text NOT NULL REFERENCES "user"(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_member (
 organization_id uuid NOT NULL REFERENCES organization(id),
 user_id text NOT NULL REFERENCES "user"(id),
 role text NOT NULL CHECK(role IN ('owner','admin','member')),
 removed_at timestamptz, joined_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,user_id)
);
ALTER TABLE team ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organization(id);
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organization(id);
CREATE TABLE IF NOT EXISTS workspace_team_access (
 workspace_id text NOT NULL REFERENCES workspace(id),
 team_id uuid NOT NULL REFERENCES team(id),
 role text NOT NULL CHECK(role IN ('admin','member','viewer')),
 permissions jsonb NOT NULL DEFAULT '{"projects":"selected","projectIds":[],"git":"personal","agents":"personal","sessions":"private"}',
 access_version integer NOT NULL DEFAULT 1,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,team_id)
);
CREATE INDEX IF NOT EXISTS workspace_team_access_team_idx ON workspace_team_access(team_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS team_organization_idx ON team(organization_id);
-- Enforce boundaries on every grant, including direct SQL callers.
CREATE OR REPLACE FUNCTION canopy_check_team_workspace_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE team_org uuid; workspace_org uuid;
BEGIN
 SELECT organization_id INTO team_org FROM team WHERE id=NEW.team_id;
 SELECT organization_id INTO workspace_org FROM workspace WHERE id=NEW.workspace_id;
 IF team_org IS NULL OR workspace_org IS NULL OR team_org <> workspace_org THEN
  RAISE EXCEPTION 'Team and workspace must belong to the same organization';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_team_organization_guard ON workspace_team_access;
CREATE TRIGGER workspace_team_organization_guard BEFORE INSERT OR UPDATE ON workspace_team_access
 FOR EACH ROW EXECUTE FUNCTION canopy_check_team_workspace_organization();
CREATE TABLE IF NOT EXISTS organization_invitation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organization(id),
 email text NOT NULL, invited_by text NOT NULL REFERENCES "user"(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days', accepted_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_invitation_pending_idx ON organization_invitation(organization_id,email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
-- Shared membership predicate for directories, invitations and encrypted relay.
CREATE OR REPLACE VIEW active_team_member AS
 SELECT m.* FROM team_member m JOIN team t ON t.id=m.team_id
 WHERE m.removed_at IS NULL AND (t.organization_id IS NULL OR EXISTS (
  SELECT 1 FROM organization_member o WHERE o.organization_id=t.organization_id
   AND o.user_id=m.user_id AND o.removed_at IS NULL
 ));
CREATE OR REPLACE FUNCTION canopy_guard_organization_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
  IF TG_TABLE_NAME='workspace' THEN
   IF EXISTS(SELECT 1 FROM workspace_team_access WHERE workspace_id=OLD.id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Revoke team access before moving workspace';
   END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM workspace_team_access WHERE team_id=OLD.id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Revoke workspace access before moving team';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_organization_move_guard ON workspace;
CREATE TRIGGER workspace_organization_move_guard BEFORE UPDATE OF organization_id ON workspace FOR EACH ROW EXECUTE FUNCTION canopy_guard_organization_move();
DROP TRIGGER IF EXISTS team_organization_move_guard ON team;
CREATE TRIGGER team_organization_move_guard BEFORE UPDATE OF organization_id ON team FOR EACH ROW EXECUTE FUNCTION canopy_guard_organization_move();
