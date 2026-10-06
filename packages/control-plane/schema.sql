-- Dedicated Canopy control database. No Coraa production data.
CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY,name text NOT NULL,email text UNIQUE NOT NULL,"emailVerified" boolean NOT NULL DEFAULT false,image text,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS "session" (id text PRIMARY KEY,"expiresAt" timestamptz NOT NULL,token text UNIQUE NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now(),"ipAddress" text,"userAgent" text,"userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS account (id text PRIMARY KEY,"accountId" text NOT NULL,"providerId" text NOT NULL,"userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,"accessToken" text,"refreshToken" text,"idToken" text,"accessTokenExpiresAt" timestamptz,"refreshTokenExpiresAt" timestamptz,scope text,password text,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS verification (id text PRIMARY KEY,identifier text NOT NULL,value text NOT NULL,"expiresAt" timestamptz NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
CREATE TABLE IF NOT EXISTS device_token (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text UNIQUE NOT NULL,user_id text NOT NULL REFERENCES "user"(id),device_id text NOT NULL,device_name text NOT NULL,expires_at timestamptz NOT NULL,last_used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,device_id));
CREATE TABLE IF NOT EXISTS workspace (id text PRIMARY KEY,owner_id text NOT NULL REFERENCES "user"(id),name text NOT NULL,host_id text,state text NOT NULL DEFAULT 'created' CHECK(state IN('created','starting','ready','stopping','stopped','error')),cpu_min numeric NOT NULL DEFAULT 1,cpu_max numeric NOT NULL DEFAULT 4,memory_min_mib integer NOT NULL DEFAULT 3072,memory_max_mib integer NOT NULL DEFAULT 16384,created_at timestamptz NOT NULL DEFAULT now(),last_connected_at timestamptz,UNIQUE(owner_id,name));
CREATE TABLE IF NOT EXISTS host (id text PRIMARY KEY,instance_id text NOT NULL,region text NOT NULL,token_hash text UNIQUE NOT NULL,desired_state text NOT NULL DEFAULT 'running',observed_state text NOT NULL DEFAULT 'unknown',boot_id text,last_heartbeat_at timestamptz,last_active_at timestamptz,auto_sleep_enabled boolean NOT NULL DEFAULT false,idle_timeout_seconds integer NOT NULL DEFAULT 1800);
CREATE TABLE IF NOT EXISTS connection_lease (id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES "user"(id),workspace_id text NOT NULL REFERENCES workspace(id),expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS connection_lease_expiry_idx ON connection_lease(workspace_id,expires_at);
CREATE TABLE IF NOT EXISTS usage_event (id uuid PRIMARY KEY,host_id text NOT NULL REFERENCES host(id),workspace_id text REFERENCES workspace(id),kind text NOT NULL,occurred_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),payload jsonb NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS usage_event_time_idx ON usage_event(workspace_id,occurred_at);
CREATE TABLE IF NOT EXISTS agent_usage (workspace_id text NOT NULL REFERENCES workspace(id),agent text NOT NULL,session_id text NOT NULL,model text,input_tokens bigint NOT NULL DEFAULT 0,output_tokens bigint NOT NULL DEFAULT 0,cache_read_tokens bigint NOT NULL DEFAULT 0,cache_creation_tokens bigint NOT NULL DEFAULT 0,active_seconds bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,agent,session_id));
CREATE TABLE IF NOT EXISTS resource_interval (id uuid PRIMARY KEY,host_id text NOT NULL REFERENCES host(id),workspace_id text REFERENCES workspace(id),kind text NOT NULL CHECK(kind IN('vm-running','workspace-connected','agent-active','job-active','allocation')),started_at timestamptz NOT NULL,ended_at timestamptz,cpu_allocation numeric,memory_mib integer,UNIQUE(host_id,workspace_id,kind,started_at),CHECK(ended_at IS NULL OR ended_at>=started_at));
CREATE TABLE IF NOT EXISTS "rateLimit" (id text PRIMARY KEY,key text UNIQUE NOT NULL,count integer NOT NULL,"lastRequest" bigint NOT NULL);
CREATE TABLE IF NOT EXISTS compute_plan (id text PRIMARY KEY,name text NOT NULL,cpu_cores integer NOT NULL CHECK(cpu_cores BETWEEN 1 AND 16),memory_mib integer NOT NULL CHECK(memory_mib BETWEEN 1024 AND 65536),included_credits numeric(18,6) NOT NULL CHECK(included_credits>=0),credits_per_hour numeric(18,6),active boolean NOT NULL DEFAULT true,version integer NOT NULL DEFAULT 1,CHECK(credits_per_hour IS NULL OR credits_per_hour>0));
INSERT INTO compute_plan(id,name,cpu_cores,memory_mib,included_credits) VALUES ('starter','Starter',1,4096,100),('standard','Standard',2,8192,200),('power','Power',4,16384,400) ON CONFLICT(id) DO NOTHING;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS plan_id text REFERENCES compute_plan(id);
CREATE TABLE IF NOT EXISTS credit_account (user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,balance numeric(18,6) NOT NULL DEFAULT 0,highest_poc_grant numeric(18,6) NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS credit_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,workspace_id text REFERENCES workspace(id),event_key text UNIQUE NOT NULL,kind text NOT NULL CHECK(kind IN('grant','usage','adjustment')),amount numeric(18,6) NOT NULL,plan_id text REFERENCES compute_plan(id),plan_version integer,quantity numeric(18,6),occurred_at timestamptz NOT NULL DEFAULT now(),description text NOT NULL,CHECK((kind='grant' AND amount>0) OR (kind='usage' AND amount<=0) OR kind='adjustment'));
CREATE INDEX IF NOT EXISTS credit_ledger_user_time_idx ON credit_ledger(user_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS device_pairing (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), challenge text NOT NULL,
 device_name text NOT NULL, user_id text REFERENCES "user"(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_pairing_expiry_idx ON device_pairing(expires_at);
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS desired_state text NOT NULL DEFAULT 'stopped';
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS region_id text;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS storage_gib integer NOT NULL DEFAULT 50;
ALTER TABLE workspace ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE TABLE IF NOT EXISTS workspace_operation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id text NOT NULL REFERENCES workspace(id),
 owner_id text NOT NULL REFERENCES "user"(id), request_key uuid NOT NULL,
 action text NOT NULL CHECK(action IN('resume','hibernate','resize','delete')),
 generation bigint NOT NULL, phase text NOT NULL DEFAULT 'queued',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','succeeded','failed')),
 target_plan_id text REFERENCES compute_plan(id), context jsonb NOT NULL DEFAULT '{}',
 attempts integer NOT NULL DEFAULT 0, last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_key), UNIQUE(workspace_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_operation_active_idx ON workspace_operation(workspace_id) WHERE status IN('pending','running');
ALTER TABLE workspace DROP CONSTRAINT IF EXISTS workspace_state_check;
ALTER TABLE workspace ADD CONSTRAINT workspace_state_check CHECK(state IN('created','starting','ready','stopping','stopped','error','unknown','deleting','deleted'));

-- Trusted-host renewal replay protection. No provider credentials or billing.
CREATE TABLE IF NOT EXISTS member_runtime_renewal_nonce (
 workspace_id text NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
 nonce text NOT NULL CHECK(nonce ~ '^[a-f0-9]{32}$'),
 member_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 generation bigint NOT NULL CHECK(generation>=0),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,nonce)
);
CREATE INDEX IF NOT EXISTS member_runtime_renewal_nonce_expiry_idx ON member_runtime_renewal_nonce(workspace_id,expires_at);
