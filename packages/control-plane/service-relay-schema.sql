-- Canopy service relay v2, host devices, teammate delivery and access snapshots.
-- Additive and idempotent; apply after peer-schema.sql and the access schemas.
ALTER TABLE peer_device ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'user';
ALTER TABLE peer_device ADD COLUMN IF NOT EXISTS workspace_ids text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='peer_device_kind_check') THEN
  ALTER TABLE peer_device ADD CONSTRAINT peer_device_kind_check CHECK(kind IN('user','host') AND (kind='host' OR cardinality(workspace_ids)=0));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS peer_device_workspace_idx ON peer_device USING gin(workspace_ids) WHERE kind='host' AND revoked_at IS NULL;
ALTER TABLE peer_relay ADD COLUMN IF NOT EXISTS size_bytes integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS peer_relay_sender_idx ON peer_relay(sender_device,expires_at);

ALTER TABLE workspace ADD COLUMN IF NOT EXISTS team_delivery boolean NOT NULL DEFAULT false;
-- Aggregate access revision for signed snapshots. Row-level access_version
-- values cannot express membership removal, so every input bumps this.
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS access_revision bigint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION canopy_bump_access_revision(ids text[]) RETURNS void LANGUAGE sql AS $$
 UPDATE workspace SET access_revision=access_revision+1 WHERE id=ANY(ids);
$$;
CREATE OR REPLACE FUNCTION canopy_access_revision_by_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN PERFORM canopy_bump_access_revision(ARRAY[NEW.workspace_id]);
 ELSIF TG_OP='DELETE' THEN PERFORM canopy_bump_access_revision(ARRAY[OLD.workspace_id]);
 ELSE PERFORM canopy_bump_access_revision(ARRAY(SELECT DISTINCT unnest(ARRAY[OLD.workspace_id,NEW.workspace_id])));
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION canopy_access_revision_by_team() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE teams uuid[];
BEGIN
 IF TG_TABLE_NAME='team' THEN teams:=ARRAY[OLD.id];
 ELSIF TG_OP='INSERT' THEN teams:=ARRAY[NEW.team_id];
 ELSIF TG_OP='DELETE' THEN teams:=ARRAY[OLD.team_id];
 ELSE teams:=ARRAY[OLD.team_id,NEW.team_id];
 END IF;
 PERFORM canopy_bump_access_revision(ARRAY(SELECT DISTINCT workspace_id FROM workspace_team_access WHERE team_id=ANY(teams)));
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION canopy_access_revision_by_organization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE orgs uuid[];
BEGIN
 IF TG_OP='INSERT' THEN orgs:=ARRAY[NEW.organization_id];
 ELSIF TG_OP='DELETE' THEN orgs:=ARRAY[OLD.organization_id];
 ELSE orgs:=ARRAY[OLD.organization_id,NEW.organization_id];
 END IF;
 PERFORM canopy_bump_access_revision(ARRAY(SELECT id FROM workspace WHERE organization_id=ANY(orgs)));
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION canopy_access_revision_self() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
  OR NEW.team_delivery IS DISTINCT FROM OLD.team_delivery OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
  NEW.access_revision:=OLD.access_revision+1;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_member_access_revision ON workspace_member;
CREATE TRIGGER workspace_member_access_revision AFTER INSERT OR UPDATE OR DELETE ON workspace_member
 FOR EACH ROW EXECUTE FUNCTION canopy_access_revision_by_workspace();
DROP TRIGGER IF EXISTS workspace_team_access_revision ON workspace_team_access;
CREATE TRIGGER workspace_team_access_revision AFTER INSERT OR UPDATE OR DELETE ON workspace_team_access
 FOR EACH ROW EXECUTE FUNCTION canopy_access_revision_by_workspace();
DROP TRIGGER IF EXISTS workspace_organization_access_revision ON workspace_organization_access;
CREATE TRIGGER workspace_organization_access_revision AFTER INSERT OR UPDATE OR DELETE ON workspace_organization_access
 FOR EACH ROW EXECUTE FUNCTION canopy_access_revision_by_workspace();
DROP TRIGGER IF EXISTS team_member_access_revision ON team_member;
CREATE TRIGGER team_member_access_revision AFTER INSERT OR UPDATE OR DELETE ON team_member
 FOR EACH ROW EXECUTE FUNCTION canopy_access_revision_by_team();
DROP TRIGGER IF EXISTS team_organization_access_revision ON team;
CREATE TRIGGER team_organization_access_revision AFTER UPDATE OF organization_id ON team
 FOR EACH ROW EXECUTE FUNCTION canopy_access_revision_by_team();
DROP TRIGGER IF EXISTS organization_member_access_revision ON organization_member;
CREATE TRIGGER organization_member_access_revision AFTER INSERT OR UPDATE OR DELETE ON organization_member
 FOR EACH ROW EXECUTE FUNCTION canopy_access_revision_by_organization();
DROP TRIGGER IF EXISTS workspace_access_revision_self ON workspace;
CREATE TRIGGER workspace_access_revision_self BEFORE UPDATE ON workspace
 FOR EACH ROW EXECUTE FUNCTION canopy_access_revision_self();
