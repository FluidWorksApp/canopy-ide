mod support;

use base64::Engine;
use canopy_service::relay::crypto::{self, Address, Envelope, PublicIdentity, SealInput};
use canopy_service::relay::transport::{DirectoryDevice, PollRow, SenderInfo};
use ed25519_dalek::Signer;
use p256::SecretKey;
use std::time::Duration;
use support::{Daemon, FakeRunner};

const WS: &str = "ws-22222222-2222-4222-8222-222222222222";
const TEAM: &str = "11111111-1111-4111-8111-111111111111";
const DAY: u64 = 24 * 60 * 60 * 1000;

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn now() -> u64 {
    canopy_service::util::now_ms()
}

fn secret_from_jwk(jwk: &serde_json::Value) -> SecretKey {
    let d = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(jwk["d"].as_str().unwrap())
        .unwrap();
    SecretKey::from_slice(&d).unwrap()
}

/// The TypeScript side's shared vector: byte-compatible headers, KDF, AEAD
/// and signatures (src/teamMessaging/fixtures/relay-v2-vector.json).
#[test]
fn opens_the_shared_typescript_v2_vector() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/relay-v2-vector.json")).unwrap();
    let recipient = secret_from_jwk(&fixture["recipient"]["agreementPrivateJwk"]);
    let sender: PublicIdentity =
        serde_json::from_value(fixture["sender"]["publicKeys"].clone()).unwrap();
    let created = fixture["created"].as_u64().unwrap();
    for vector in fixture["vectors"].as_array().unwrap() {
        let envelope: Envelope = serde_json::from_value(vector["envelope"].clone()).unwrap();
        let opened = crypto::open(&recipient, &sender, &envelope, created + 1).unwrap();
        assert_eq!(
            opened.text,
            vector["plaintext"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
        // Any change to a bound field breaks authentication.
        let mut other = envelope.clone();
        other.to.workspace = Some("ws-other".into());
        assert!(crypto::open(&recipient, &sender, &other, created + 1).is_err());
    }
}

/// Version 1 from the live crypto.ts, run under node, opens here too.
#[test]
fn opens_a_v1_envelope_sealed_by_crypto_ts() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        eprintln!("node is not installed; skipping the live crypto.ts check");
        return;
    }
    let host = crypto::random_secret();
    let host_public = PublicIdentity {
        agreement: crypto::jwk_of(&host.public_key()),
        signing: crypto::jwk_of(&crypto::random_secret().public_key()),
    };
    let module = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/teamMessaging/crypto.ts")
        .canonicalize()
        .unwrap();
    let script = format!(
        r#"const c = await import({module:?});
const id = await c.createIdentity();
const from = {{team:"t1",user:"alice",device:"d1"}}, to = {{team:"t1",user:"bob",device:"d2"}};
const envelope = await c.seal(id, {recipient}, from, to, "hello from node");
console.log(JSON.stringify({{envelope, sender: await c.publicIdentity(id)}}));"#,
        module = module.display().to_string(),
        recipient = serde_json::to_string(&host_public).unwrap(),
    );
    let output = std::process::Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .output()
        .unwrap();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Unknown file extension")
            || stderr.contains("ERR_UNKNOWN_FILE_EXTENSION")
        {
            eprintln!("this node cannot import TypeScript; skipping");
            return;
        }
        panic!("node failed: {stderr}");
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let envelope: Envelope = serde_json::from_value(value["envelope"].clone()).unwrap();
    let sender: PublicIdentity = serde_json::from_value(value["sender"].clone()).unwrap();
    let opened = crypto::open(&host, &sender, &envelope, now()).unwrap();
    assert_eq!(opened.text, "hello from node");
}

struct Peer {
    user: String,
    device: String,
    agreement: SecretKey,
    signing: p256::ecdsa::SigningKey,
}

impl Peer {
    fn new(user: &str) -> Self {
        Self {
            user: user.into(),
            device: canopy_service::util::uuid_v4(),
            agreement: crypto::random_secret(),
            signing: p256::ecdsa::SigningKey::from(crypto::random_secret()),
        }
    }
    fn public(&self) -> PublicIdentity {
        PublicIdentity {
            agreement: crypto::jwk_of(&self.agreement.public_key()),
            signing: crypto::jwk_of(&p256::PublicKey::from(self.signing.verifying_key())),
        }
    }
    fn address(&self) -> Address {
        Address {
            team: TEAM.into(),
            user: self.user.clone(),
            device: self.device.clone(),
            workspace: None,
        }
    }
    fn seal(
        &self,
        host: &(String, PublicIdentity),
        kind: &str,
        payload: serde_json::Value,
    ) -> Envelope {
        crypto::seal(SealInput {
            signing: &self.signing,
            recipient: &host.1,
            from: self.address(),
            to: Address {
                team: TEAM.into(),
                user: "owner".into(),
                device: host.0.clone(),
                workspace: Some(WS.into()),
            },
            kind: Some(kind),
            text: &payload.to_string(),
            now: now(),
            lifetime_ms: DAY,
        })
        .unwrap()
    }
    fn sender(&self) -> SenderInfo {
        SenderInfo {
            id: self.device.clone(),
            user_id: self.user.clone(),
            kind: Some("user".into()),
            workspace_ids: None,
            public_keys: self.public(),
        }
    }
}

fn mesh(text: &str) -> serde_json::Value {
    serde_json::json!({"kind":"mesh","message":{"id": canopy_service::util::uuid_v4(),"text":text,"target":{"name":"reviewer"},"created":now()}})
}

struct Relay<'a> {
    daemon: &'a Daemon,
    host: (String, PublicIdentity),
}

impl Relay<'_> {
    fn enqueue(&self, peer: &Peer, envelope: &Envelope) -> String {
        let id = canopy_service::util::uuid_v4();
        self.daemon.relay.0.queue.lock().unwrap().push(PollRow {
            id: id.clone(),
            envelope: serde_json::to_value(envelope).unwrap(),
            sender: Some(peer.sender()),
        });
        id
    }

    async fn tick(&self) {
        self.daemon.service().relay_once().await;
    }

    /// Every status payload relayed to this peer so far, decrypted.
    fn replies(&self, peer: &Peer) -> Vec<serde_json::Value> {
        self.daemon
            .relay
            .0
            .relayed
            .lock()
            .unwrap()
            .iter()
            .filter(|(device, _)| *device == peer.device)
            .map(|(_, envelope)| {
                assert_eq!(envelope.version, 2);
                assert_eq!(envelope.to.workspace.as_deref(), Some(WS));
                let opened = crypto::open(&peer.agreement, &self.host.1, envelope, now()).unwrap();
                serde_json::from_str(&opened.text).unwrap()
            })
            .collect()
    }
}

fn snapshot(
    device: &str,
    revision: u64,
    expires_at: u64,
    team_delivery: bool,
) -> serde_json::Value {
    serde_json::json!({
        "v": 1, "kid": "k1", "workspaceId": WS, "serviceDevice": device,
        "revision": revision, "issuedAt": now(), "expiresAt": expires_at,
        "teamDelivery": team_delivery, "ownerUserId": "owner",
        "principals": [
            {"userId": "granted", "sessionsInteract": true, "projects": "all"},
            {"userId": "viewer", "sessionsInteract": false, "projects": "all"}
        ]
    })
}

fn signed(key: &ed25519_dalek::SigningKey, snapshot: &serde_json::Value) -> serde_json::Value {
    let payload = serde_json::to_vec(snapshot).unwrap();
    serde_json::json!({
        "payload": b64().encode(&payload),
        "signature": b64().encode(key.sign(&payload).to_bytes()),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn relay_authority_matrix_dedupe_and_jobs() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (reviewer, _) = daemon
        .terminal(WS, &runner, "req-rev-001", "reviewer", 7, 7007)
        .await;
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
    std::fs::write(
        daemon.dir.path().join("state/access-keys.json"),
        serde_json::json!({ "k1": b64().encode(signing_key.verifying_key().to_bytes()) })
            .to_string(),
    )
    .unwrap();
    let (_, device) = daemon.admin("GET", "/admin/device", None).await;
    let host_id = device["deviceId"].as_str().unwrap().to_string();
    let host = (
        host_id.clone(),
        serde_json::from_value::<PublicIdentity>(device["keys"].clone()).unwrap(),
    );
    let relay = Relay {
        daemon: &daemon,
        host,
    };
    let owner = Peer::new("owner");
    let granted = Peer::new("granted");
    let stranger = Peer::new("stranger");
    for peer in [&owner, &granted, &stranger] {
        daemon
            .relay
            .0
            .directory
            .lock()
            .unwrap()
            .push(DirectoryDevice {
                id: peer.device.clone(),
                user_id: peer.user.clone(),
                public_keys: peer.public(),
                kind: Some("user".into()),
            });
    }
    let writes = || runner.writes_to(7).len();
    let delivered = |n: usize| async move {
        support::wait_until(&format!("{n} writes"), Duration::from_secs(5), || {
            writes() == n
        })
        .await;
    };
    let access_path = format!("/admin/workspaces/{WS}/access");
    let access = |body: serde_json::Value| daemon.admin("PUT", &access_path, Some(body));

    // Owner: delivered, acknowledged, typed with the sender visible.
    let envelope = owner.seal(&relay.host, "mesh", mesh("hello from the owner"));
    let row = relay.enqueue(&owner, &envelope);
    relay.tick().await;
    assert!(daemon.relay.0.acked.lock().unwrap().contains(&row));
    delivered(2).await;
    let typed = &runner.writes_to(7)[0].data;
    assert!(
        typed.starts_with("[canopy: a message from owner over the team mesh]"),
        "{typed}"
    );
    assert!(typed.contains("hello from the owner"));

    // The same envelope again (redelivered by the relay): acknowledged, not rerun.
    let again = relay.enqueue(&owner, &envelope);
    relay.tick().await;
    assert!(daemon.relay.0.acked.lock().unwrap().contains(&again));
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(writes(), 2);

    // Granted, but there is no snapshot yet: refused, sender told why.
    relay.enqueue(&granted, &granted.seal(&relay.host, "mesh", mesh("hi")));
    relay.tick().await;
    let replies = relay.replies(&granted);
    assert_eq!(replies.last().unwrap()["kind"], "mesh-status");
    assert_eq!(replies.last().unwrap()["status"]["state"], "refused");

    // Snapshot: bad signature and rollback rejected; teamDelivery off refuses.
    let wrong = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]);
    assert_eq!(
        access(signed(&wrong, &snapshot(&host_id, 2, now() + DAY, true)))
            .await
            .0,
        400
    );
    let (status, reply) = access(signed(
        &signing_key,
        &snapshot(&host_id, 2, now() + DAY, false),
    ))
    .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["revision"], 2);
    assert_eq!(
        access(signed(
            &signing_key,
            &snapshot(&host_id, 1, now() + DAY, true)
        ))
        .await
        .0,
        409
    );
    assert_eq!(
        access(signed(
            &signing_key,
            &snapshot("another-device", 3, now() + DAY, true)
        ))
        .await
        .0,
        400
    );
    relay.enqueue(
        &granted,
        &granted.seal(&relay.host, "mesh", mesh("hi again")),
    );
    relay.tick().await;
    let last = relay.replies(&granted).pop().unwrap();
    assert_eq!(last["status"]["state"], "refused");
    assert!(last["status"]["detail"]
        .as_str()
        .unwrap()
        .contains("teammate delivery"));
    assert_eq!(writes(), 2);

    // teamDelivery on: the granted teammate is delivered; a stranger is not.
    assert_eq!(
        access(signed(
            &signing_key,
            &snapshot(&host_id, 3, now() + DAY, true)
        ))
        .await
        .0,
        200
    );
    relay.enqueue(
        &granted,
        &granted.seal(&relay.host, "mesh", mesh("granted hello")),
    );
    relay.enqueue(
        &stranger,
        &stranger.seal(&relay.host, "mesh", mesh("let me in")),
    );
    relay.tick().await;
    delivered(4).await;
    assert!(runner.writes_to(7)[2].data.contains("granted hello"));
    assert_eq!(
        relay.replies(&stranger).pop().unwrap()["status"]["state"],
        "refused"
    );

    // An expired snapshot authorizes only the owner.
    assert_eq!(
        access(signed(
            &signing_key,
            &snapshot(&host_id, 4, now() - 1, true)
        ))
        .await
        .0,
        200
    );
    relay.enqueue(
        &granted,
        &granted.seal(&relay.host, "mesh", mesh("after expiry")),
    );
    relay.tick().await;
    assert!(relay.replies(&granted).pop().unwrap()["status"]["detail"]
        .as_str()
        .unwrap()
        .contains("expired"));
    relay.enqueue(
        &owner,
        &owner.seal(&relay.host, "mesh", mesh("owner after expiry")),
    );
    relay.tick().await;
    delivered(6).await;

    // A forged envelope (signed by a key the relay does not hold for that
    // device) is dropped without a reply.
    let impostor = Peer::new("owner");
    let forged = impostor.seal(&relay.host, "mesh", mesh("forged"));
    daemon.relay.0.queue.lock().unwrap().push(PollRow {
        id: canopy_service::util::uuid_v4(),
        envelope: serde_json::to_value(&forged).unwrap(),
        sender: Some(SenderInfo {
            id: impostor.device.clone(),
            ..owner.sender()
        }),
    });
    relay.tick().await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(writes(), 6);

    // A job from the owner: accepted, started on submit, done on job_done.
    let job = serde_json::json!({"kind":"job","job":{"id":"job-0001-test","title":"Review","brief":"Review the diff and report.","workspace":WS,"created":now(),"target":{"name":"reviewer"}}});
    relay.enqueue(&owner, &owner.seal(&relay.host, "job", job));
    relay.tick().await;
    delivered(8).await;
    assert!(runner.writes_to(7)[6]
        .data
        .starts_with("[canopy: job job-0001-test from owner"));
    support::wait_until("job started", Duration::from_secs(3), || {
        daemon
            .service()
            .workspace(WS)
            .unwrap()
            .ledger
            .job_state("owner:job-0001-test")
            .ok()
            .flatten()
            .as_deref()
            == Some("started")
    })
    .await;
    let (status, _) = daemon
        .agent(WS, &reviewer, "POST", "/ctx/action", Some(serde_json::json!({"kind":"job_done","status":"done","summary":"Reviewed; two nits."})))
        .await;
    assert_eq!(status, 200);
    relay.tick().await;
    let states: Vec<String> = relay
        .replies(&owner)
        .iter()
        .filter(|r| r["kind"] == "job-status")
        .map(|r| r["status"]["state"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(states, ["accepted", "started", "done"]);
    let done = relay.replies(&owner).pop().unwrap();
    assert_eq!(done["status"]["detail"], "Reviewed; two nits.");

    // A job without a target is declined.
    let untargeted = serde_json::json!({"kind":"job","job":{"id":"job-0002-test","title":"x","brief":"y","workspace":WS,"created":now()}});
    relay.enqueue(&owner, &owner.seal(&relay.host, "job", untargeted));
    relay.tick().await;
    relay.tick().await;
    let last = relay.replies(&owner).pop().unwrap();
    assert_eq!(last["status"]["jobId"], "job-0002-test");
    assert_eq!(last["status"]["state"], "declined");

    // Everything polled was acknowledged once recorded.
    let queued = daemon.relay.0.queue.lock().unwrap().len();
    assert_eq!(daemon.relay.0.acked.lock().unwrap().len(), queued);
}
