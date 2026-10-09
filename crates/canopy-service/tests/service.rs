mod support;

use std::time::Duration;
use support::{Daemon, FakeRunner, Sse};

const WS: &str = "ws-1";

#[tokio::test(flavor = "multi_thread")]
async fn health_device_and_socket_modes() {
    use std::os::unix::fs::PermissionsExt;
    let daemon = Daemon::start().await;
    let (status, health) = daemon.admin("GET", "/admin/health", None).await;
    assert_eq!(status, 200);
    assert_eq!(health["ready"], true);
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&daemon.admin_socket()), 0o660);
    assert_eq!(mode(&daemon.dir.path().join("state")), 0o700);
    assert_eq!(mode(&daemon.dir.path().join("state/device.json")), 0o600);

    let (_, device) = daemon.admin("GET", "/admin/device", None).await;
    assert!(device["keys"]["agreement"]["d"].is_null());
    assert_eq!(device["keys"]["signing"]["crv"], "P-256");

    // Registered before the container exists: socket now, runner later.
    daemon.register(WS, None).await;
    let socket = daemon.agent_socket(WS);
    assert_eq!(mode(&socket), 0o666);
    assert_eq!(mode(socket.parent().unwrap()), 0o755);
    // DELETE closes the socket but keeps the directory containers bind.
    let (status, _) = daemon
        .admin("DELETE", &format!("/admin/workspaces/{WS}"), None)
        .await;
    assert_eq!(status, 200);
    assert!(!socket.exists());
    assert!(socket.parent().unwrap().is_dir());
    daemon.register(WS, None).await;
    assert!(socket.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_credential_is_the_caller_and_everything_else_is_503() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (ada, ada_pty) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;
    let (_bob, bob_pty) = daemon
        .terminal(WS, &runner, "req-bob-01", "Bob", 12, 1012)
        .await;
    assert_ne!(ada_pty, bob_pty);

    let (status, _) = daemon.agent(WS, "nope", "GET", "/ctx/identity", None).await;
    assert_eq!(status, 401);
    let (status, me) = daemon.agent(WS, &ada, "GET", "/ctx/identity", None).await;
    assert_eq!(status, 200);
    assert_eq!(me["ptyId"], ada_pty);
    assert_eq!(me["instance"], format!("remote-{WS}"));
    assert_eq!(me["cwd"], "/workspace");

    let (_, tools) = daemon.agent(WS, &ada, "GET", "/ctx/tools", None).await;
    let supported = tools["supportedTools"].as_array().unwrap();
    assert!(supported.iter().any(|t| t == "canopy_mesh_send"));
    assert!(tools["disabled"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t == "canopy_vault_read"));

    // A body cannot name another caller: close_session ignores its ptyId.
    let (status, _) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/action",
            Some(serde_json::json!({"kind":"close_session","ptyId": bob_pty})),
        )
        .await;
    assert_eq!(status, 200);
    let (_, terminals) = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/query"),
            Some(serde_json::json!({"store":"terminals","action":"list"})),
        )
        .await;
    let rows = terminals["items"].as_array().unwrap();
    let closed: Vec<_> = rows
        .iter()
        .filter(|t| !t["closeRequestedMs"].is_null())
        .collect();
    assert_eq!(closed.len(), 1);
    assert_eq!(closed[0]["ptyId"], ada_pty);
    assert!(rows.iter().all(|t| t.get("tokenSha256").is_none()));

    for (path, body, reason) in [
        ("/ctx/editor", None, "no-ide"),
        (
            "/ctx/device",
            Some(serde_json::json!({"op":"list"})),
            "laptop-only",
        ),
        ("/ctx/snapshot", None, "not-implemented"),
        (
            "/ctx/notes",
            Some(serde_json::json!({"action":"list"})),
            "not-implemented",
        ),
        (
            "/ctx/ui",
            Some(serde_json::json!({"op":"workspace"})),
            "not-implemented",
        ),
        (
            "/ctx/action",
            Some(serde_json::json!({"kind":"open_file","path":"/workspace/a"})),
            "no-ide",
        ),
        (
            "/ctx/action",
            Some(serde_json::json!({"kind":"spawn_agent"})),
            "not-implemented",
        ),
    ] {
        let method = if body.is_some() { "POST" } else { "GET" };
        let (status, reply) = daemon.agent(WS, &ada, method, path, body).await;
        assert_eq!(status, 503, "{path}: {reply}");
        assert_eq!(reply["error"], "unavailable");
        assert_eq!(reply["reason"], reason, "{path}");
        assert!(reply["message"].is_string());
    }
    let (status, _) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/action",
            Some(serde_json::json!({"kind":"notify","text":"hi","project":"elsewhere"})),
        )
        .await;
    assert_eq!(status, 400);

    // Browser ops forward to the runner.
    let (status, reply) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/browser",
            Some(serde_json::json!({"op":"navigate","url":"http://localhost:3000"})),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["echo"]["op"], "navigate");
    assert_eq!(reply["echo"]["args"]["url"], "http://localhost:3000");

    // Revocation ends the identity.
    daemon
        .admin(
            "DELETE",
            &format!("/admin/workspaces/{WS}/terminals/req-ada-01"),
            None,
        )
        .await;
    let (status, _) = daemon.agent(WS, &ada, "GET", "/ctx/identity", None).await;
    assert_eq!(status, 401);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mesh_message_is_body_then_return_250ms_later_serialized_per_target() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (ada, _) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;
    let (bob, bob_pty) = daemon
        .terminal(WS, &runner, "req-bob-01", "Bob", 12, 1012)
        .await;

    let send = |token: String, text: &'static str| {
        let socket = daemon.agent_socket(WS);
        async move {
            support::call(
                &socket,
                "POST",
                "/ctx/action",
                Some(&token),
                Some(serde_json::json!({"kind":"mesh_send","ptyId": bob_pty, "text": text})),
            )
            .await
        }
    };
    let (first, second) = tokio::join!(send(ada.clone(), "first"), send(ada.clone(), "second"));
    assert_eq!(first.0, 200, "{}", first.1);
    assert_eq!(second.0, 200, "{}", second.1);
    support::wait_until("both returns", Duration::from_secs(5), || {
        runner.writes_to(12).len() == 4
    })
    .await;
    let writes = runner.writes_to(12);
    // body, CR, body, CR — never interleaved.
    assert_ne!(writes[0].data, "\r");
    assert_eq!(writes[1].data, "\r");
    assert_ne!(writes[2].data, "\r");
    assert_eq!(writes[3].data, "\r");
    assert!(writes[0].data.contains("[canopy: message from Ada"));
    assert!(writes.iter().all(|w| w.expect_pid == Some(1012)));
    assert!(writes[1].at.duration_since(writes[0].at) >= Duration::from_millis(250));
    assert!(writes[3].at.duration_since(writes[2].at) >= Duration::from_millis(250));

    let (status, history) = daemon
        .agent(
            WS,
            &bob,
            "POST",
            "/ctx/mesh",
            Some(serde_json::json!({"action":"history"})),
        )
        .await;
    assert_eq!(status, 200);
    let messages = history["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    support::wait_until("submitted flags", Duration::from_secs(2), || {
        daemon
            .service()
            .workspace(WS)
            .unwrap()
            .mesh
            .all()
            .iter()
            .all(|m| m.submitted)
    })
    .await;

    // message_agent by name, and your own terminal is refused.
    let (status, reply) = daemon
        .agent(
            WS,
            &bob,
            "POST",
            "/ctx/action",
            Some(
                serde_json::json!({"kind":"message_agent","name":"ada","text":"hi\u{1b}[2J back"}),
            ),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    support::wait_until("reply delivered", Duration::from_secs(5), || {
        runner.writes_to(11).len() == 2
    })
    .await;
    assert!(runner.writes_to(11)[0].data.ends_with("hi [2J back"));
    let (status, _) = daemon
        .agent(
            WS,
            &bob,
            "POST",
            "/ctx/action",
            Some(serde_json::json!({"kind":"mesh_send","ptyId": bob_pty,"text":"me"})),
        )
        .await;
    assert_eq!(status, 400);

    // A replaced child (new pid behind the same session) never gets the write.
    runner
        .state
        .sessions
        .lock()
        .unwrap()
        .iter_mut()
        .for_each(|s| {
            if s.0 == 12 {
                s.1 = 2012;
            }
        });
    let (status, reply) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/action",
            Some(serde_json::json!({"kind":"mesh_send","ptyId": bob_pty,"text":"late"})),
        )
        .await;
    assert_eq!(status, 400, "{reply}");
    assert_eq!(runner.writes_to(12).len(), 4);
    let (_, deliveries) = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/query"),
            Some(serde_json::json!({"store":"deliveries","action":"list"})),
        )
        .await;
    let states: Vec<&str> = deliveries["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["state"].as_str().unwrap())
        .collect();
    assert_eq!(states.iter().filter(|s| **s == "submitted").count(), 3);
    assert_eq!(states.iter().filter(|s| **s == "failed").count(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn delivery_before_the_runner_is_registered_is_not_ready() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, None).await;
    let minted = |id: &'static str| {
        let daemon = &daemon;
        async move {
            daemon
                .admin(
                    "POST",
                    &format!("/admin/workspaces/{WS}/terminals"),
                    Some(serde_json::json!({"requestId": id})),
                )
                .await
                .1["token"]
                .as_str()
                .unwrap()
                .to_string()
        }
    };
    let ada = minted("req-ada-01").await;
    let _bob = minted("req-bob-01").await;
    let (status, reply) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/action",
            Some(serde_json::json!({"kind":"message_agent","ptyId":2,"text":"x"})),
        )
        .await;
    assert_eq!(status, 503);
    assert_eq!(reply["reason"], "not-ready");
    let (status, reply) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/browser",
            Some(serde_json::json!({"op":"snapshot"})),
        )
        .await;
    assert_eq!(status, 503);
    assert_eq!(reply["reason"], "not-ready");
    // The later PUT supplies the runner; the same credentials keep working.
    daemon.register(WS, Some(&runner)).await;
    let (status, _) = daemon.agent(WS, &ada, "GET", "/ctx/identity", None).await;
    assert_eq!(status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn claims_collide_by_credential_not_by_name() {
    let mut daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (ada, _) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;
    let (bob, _) = daemon
        .terminal(WS, &runner, "req-bob-01", "Bob", 12, 1012)
        .await;
    let claims_socket = daemon.agent_socket(WS);
    let claim = |token: &str, action: &str, paths: serde_json::Value| {
        let socket = claims_socket.clone();
        let token = token.to_string();
        let body = serde_json::json!({"action": action, "paths": paths, "owner": "same name", "note": "work"});
        async move { support::call(&socket, "POST", "/ctx/claims", Some(&token), Some(body)).await }
    };
    assert_eq!(
        claim(&ada, "claim", serde_json::json!(["src/auth"]))
            .await
            .0,
        200
    );
    let (status, reply) = claim(
        &bob,
        "claim",
        serde_json::json!(["/workspace/src/auth/login.ts"]),
    )
    .await;
    assert_eq!(status, 409, "{reply}");
    // Bob cannot release Ada's claim by sharing her display name.
    claim(&bob, "release", serde_json::json!([])).await;
    let (_, held) = daemon.agent(WS, &bob, "GET", "/ctx/claims", None).await;
    assert_eq!(held["claims"].as_array().unwrap().len(), 1);
    assert_eq!(held["claims"][0]["paths"][0], "/workspace/src/auth");
    assert_eq!(held["claims"][0]["refusals"].as_array().unwrap().len(), 1);
    // The claim survives a restart and ends when Ada's terminal exits.
    daemon.restart().await;
    let (_, held) = daemon.agent(WS, &bob, "GET", "/ctx/claims", None).await;
    assert_eq!(held["claims"].as_array().unwrap().len(), 1);
    daemon
        .admin(
            "DELETE",
            &format!("/admin/workspaces/{WS}/terminals/req-ada-01"),
            None,
        )
        .await;
    let (_, held) = daemon.agent(WS, &bob, "GET", "/ctx/claims", None).await;
    assert!(held["claims"].as_array().unwrap().is_empty());
    assert_eq!(
        claim(&bob, "claim", serde_json::json!(["src/auth"]))
            .await
            .0,
        200
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ask_expires_at_its_deadline_and_survives_a_restart() {
    let mut daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (ada, _) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;

    let started = std::time::Instant::now();
    let (status, reply) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/ask",
            Some(serde_json::json!({"op":"confirm","action":"delete it","timeoutMs":300})),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(reply["expired"], true);
    assert_eq!(reply["accepted"], false);
    assert_eq!(reply["message"], "no user present");
    assert!(started.elapsed() >= Duration::from_millis(300));

    // An answered question returns the answer; the first answer wins.
    let socket = daemon.agent_socket(WS);
    let token = ada.clone();
    let waiting = tokio::spawn(async move {
        support::call(&socket, "POST", "/ctx/ui", Some(&token), Some(serde_json::json!({"op":"ask","question":"Which?","options":["a","b"],"requestId":"ask-0000-01"}))).await
    });
    let id = "qask-0000-01";
    support::wait_until("question persisted", Duration::from_secs(2), || {
        daemon
            .service()
            .workspace(WS)
            .unwrap()
            .attention
            .get(id)
            .is_some()
    })
    .await;

    // Restart under the open question: the connection drops, the question
    // and its deadline persist, and the agent's retry rejoins it.
    daemon.restart().await;
    let _ = waiting.await;
    let item = daemon
        .service()
        .workspace(WS)
        .unwrap()
        .attention
        .get(id)
        .unwrap();
    assert!(item.resolution.is_none());
    let socket = daemon.agent_socket(WS);
    let token = ada.clone();
    let retry = tokio::spawn(async move {
        support::call(&socket, "POST", "/ctx/ui", Some(&token), Some(serde_json::json!({"op":"ask","question":"Which?","options":["a","b"],"requestId":"ask-0000-01"}))).await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, _) = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/actions"),
            Some(serde_json::json!({"kind":"answer","id":id,"answer":"b"})),
        )
        .await;
    assert_eq!(status, 400, "actor is required");
    let (status, _) = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/actions"),
            Some(serde_json::json!({"kind":"answer","id":id,"answer":"b","actor":"owner"})),
        )
        .await;
    assert_eq!(status, 200);
    let (status, _) = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/actions"),
            Some(serde_json::json!({"kind":"answer","id":id,"answer":"a","actor":"member:2"})),
        )
        .await;
    assert_eq!(status, 409);
    let (status, reply) = retry.await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(reply["answer"], "b");

    // A deadline that passes while the service is down resolves as expired.
    let socket = daemon.agent_socket(WS);
    let token = ada.clone();
    let short = tokio::spawn(async move {
        support::call(
            &socket,
            "POST",
            "/ctx/ask",
            Some(&token),
            Some(
                serde_json::json!({"question":"quick?","timeoutMs":400,"requestId":"ask-0000-02"}),
            ),
        )
        .await
    });
    support::wait_until("second question", Duration::from_secs(2), || {
        daemon
            .service()
            .workspace(WS)
            .unwrap()
            .attention
            .get("qask-0000-02")
            .is_some()
    })
    .await;
    if let Some(running) = daemon.running.take() {
        running.shutdown().await;
    }
    let _ = short.await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    daemon.boot().await;
    let item = daemon
        .service()
        .workspace(WS)
        .unwrap()
        .attention
        .get("qask-0000-02")
        .unwrap();
    assert_eq!(item.resolution, Some(serde_json::json!({"expired": true})));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_stream_snapshots_replays_and_changes_epoch() {
    let mut daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (ada, _) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;
    let path = format!("/admin/workspaces/{WS}/stream");

    let mut sse = Sse::open(&daemon.admin_socket(), &path).await;
    let (event, snapshot) = sse.next().await;
    assert_eq!(event, "snapshot");
    let cursor = snapshot["cursor"].as_str().unwrap().to_string();
    for store in ["mesh", "notes", "research", "attention"] {
        assert!(snapshot["stores"][store].is_array(), "{store}");
    }

    let notify = |text: &'static str| {
        let socket = daemon.agent_socket(WS);
        let token = ada.clone();
        async move {
            support::call(
                &socket,
                "POST",
                "/ctx/action",
                Some(&token),
                Some(serde_json::json!({"kind":"notify","text":text})),
            )
            .await
        }
    };
    notify("one").await;
    let (event, change) = sse.next().await;
    assert_eq!(event, "change");
    assert_eq!(change["store"], "attention");
    let after_one = change["cursor"].as_str().unwrap().to_string();
    drop(sse);
    notify("two").await;
    notify("three").await;

    // Resume from inside the window: no snapshot, exactly the missed events.
    let mut resumed = Sse::open(
        &daemon.admin_socket(),
        &format!("{path}?cursor={after_one}"),
    )
    .await;
    let (event, first) = resumed.next().await;
    assert_eq!(event, "change");
    let (_, second) = resumed.next().await;
    let seq = |c: &serde_json::Value| {
        c["cursor"]
            .as_str()
            .unwrap()
            .rsplit_once(':')
            .unwrap()
            .1
            .parse::<u64>()
            .unwrap()
    };
    assert_eq!(seq(&second), seq(&first) + 1);
    let query = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/query"),
            Some(serde_json::json!({"store":"attention","action":"list","args":{"scope":"fyi"}})),
        )
        .await;
    assert_eq!(query.1["items"].as_array().unwrap().len(), 3);
    drop(resumed);

    // A restart changes the epoch: the old cursor gets a fresh snapshot.
    let old_epoch = cursor.split(':').next().unwrap().to_string();
    daemon.restart().await;
    let mut fresh = Sse::open(
        &daemon.admin_socket(),
        &format!("{path}?cursor={after_one}"),
    )
    .await;
    let (event, snapshot) = fresh.next().await;
    assert_eq!(event, "snapshot");
    let new_epoch = snapshot["cursor"]
        .as_str()
        .unwrap()
        .split(':')
        .next()
        .unwrap()
        .to_string();
    assert_ne!(old_epoch, new_epoch);
    assert_eq!(snapshot["stores"]["attention"].as_array().unwrap().len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_delivery_cut_by_a_restart_is_reported_uncertain_never_replayed() {
    let mut daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (_ada, ada_pty) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;
    if let Some(running) = daemon.running.take() {
        running.shutdown().await;
    }
    let ledger = canopy_service::ledger::Ledger::open(
        &daemon
            .dir
            .path()
            .join(format!("state/ws/{WS}/inbox/service.sqlite")),
    )
    .unwrap();
    for (id, state) in [("d-written", "written"), ("d-queued", "queued")] {
        let row = canopy_service::ledger::DeliveryRow {
            id: id.into(),
            message_id: format!("m-{id}"),
            pty_id: ada_pty,
            line: format!("line {id}"),
            state: "queued".into(),
            job_key: None,
        };
        ledger
            .transaction(|tx| canopy_service::ledger::Ledger::insert_delivery(tx, &row, None))
            .unwrap();
        ledger.set_delivery(id, state, None).unwrap();
    }
    drop(ledger);
    daemon.boot().await;
    // The queued one never touched the terminal, so it runs now.
    support::wait_until("queued delivery", Duration::from_secs(5), || {
        runner.writes_to(11).len() == 2
    })
    .await;
    assert_eq!(runner.writes_to(11)[0].data, "line d-queued");
    let (_, deliveries) = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/query"),
            Some(serde_json::json!({"store":"deliveries","action":"list"})),
        )
        .await;
    let state = |id: &str| {
        deliveries["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == id)
            .unwrap()["state"]
            .clone()
    };
    assert_eq!(state("d-written"), "uncertain");
    let attention = daemon.service().workspace(WS).unwrap().attention.list();
    assert!(attention.iter().any(|a| a.title.contains("uncertain")));
}
