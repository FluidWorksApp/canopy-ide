-- Additive: organization-wide access remains a live membership grant.
CREATE TABLE IF NOT EXISTS workspace_organization_access (
 workspace_id text NOT NULL REFERENCES workspace(id),
 organization_id uuid NOT NULL REFERENCES organization(id),
 role text NOT NULL CHECK(role IN ('admin','member','viewer')),
 permissions jsonb NOT NULL DEFAULT '{"projects":"selected","projectIds":[],"git":"personal","agents":"personal","sessions":"private"}',
 access_version integer NOT NULL DEFAULT 1 CHECK(access_version > 0),
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,organization_id)
);
CREATE INDEX IF NOT EXISTS workspace_organization_access_organization_idx
 ON workspace_organization_access(organization_id) WHERE revoked_at IS NULL;
CREATE OR REPLACE FUNCTION canopy_check_workspace_organization_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE workspace_org uuid;
BEGIN
 SELECT organization_id INTO workspace_org FROM workspace WHERE id=NEW.workspace_id;
 IF workspace_org IS NULL OR workspace_org <> NEW.organization_id THEN
  RAISE EXCEPTION 'Workspace and access grant must belong to the same organization';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_organization_access_guard ON workspace_organization_access;
CREATE TRIGGER workspace_organization_access_guard BEFORE INSERT OR UPDATE ON workspace_organization_access
 FOR EACH ROW EXECUTE FUNCTION canopy_check_workspace_organization_access();
CREATE OR REPLACE FUNCTION canopy_guard_workspace_organization_access_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.organization_id IS DISTINCT FROM OLD.organization_id AND EXISTS(
  SELECT 1 FROM workspace_organization_access WHERE workspace_id=OLD.id AND revoked_at IS NULL
 ) THEN
  RAISE EXCEPTION 'Revoke organization access before moving workspace';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_organization_access_move_guard ON workspace;
CREATE TRIGGER workspace_organization_access_move_guard BEFORE UPDATE OF organization_id ON workspace
 FOR EACH ROW EXECUTE FUNCTION canopy_guard_workspace_organization_access_move();
