//! What a cloud workspace needed to be on the desktop's footing: a person's
//! research write-up replace, imports larger than one harness action, agent
//! awareness (hotspot claims and notes), the roster's repository and files,
//! and structured-runner credentials kept while the runner lives.
mod support;

use support::{Daemon, FakeRunner};

const WS: &str = "ws-1";

async fn act(daemon: &Daemon, body: serde_json::Value) -> (u16, serde_json::Value) {
    daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/actions"),
            Some(body),
        )
        .await
}

async fn query(
    daemon: &Daemon,
    store: &str,
    action: &str,
    args: serde_json::Value,
) -> (u16, serde_json::Value) {
    daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/query"),
            Some(serde_json::json!({"store":store,"action":action,"args":args})),
        )
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_person_replaces_a_write_up_and_imports_a_large_file_in_pieces() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;

    let (status, entry) = act(
        &daemon,
        serde_json::json!({"kind":"research_write","actor":"owner","action":"start",
            "title":"Queue","text":"first draft"}),
    )
    .await;
    assert_eq!(status, 200, "{entry}");
    let id = entry["id"].as_str().unwrap().to_string();
    let (status, replaced) = act(
        &daemon,
        serde_json::json!({"kind":"research_write","actor":"owner","action":"replace",
            "id": id, "text":"all new"}),
    )
    .await;
    assert_eq!(status, 200, "{replaced}");
    let (_, detail) = query(&daemon, "research", "get", serde_json::json!({"id": id})).await;
    assert_eq!(detail["body"], "all new", "{detail}");

    // 300 KB arrives in three pieces; the store adopts it on the last.
    let text = format!("# Big spike\n\n{}", "x".repeat(300 * 1024));
    let pieces: Vec<String> = text
        .chars()
        .collect::<Vec<_>>()
        .chunks(128 * 1024)
        .map(|c| c.iter().collect())
        .collect();
    let mut offset = 0;
    let mut last = serde_json::Value::Null;
    for (i, piece) in pieces.iter().enumerate() {
        let (status, reply) = act(
            &daemon,
            serde_json::json!({"kind":"research_write","actor":"owner","action":"import_chunk",
                "upload":"upload-0001","path":"/workspace/docs/big.md","offset":offset,
                "text":piece,"done": i + 1 == pieces.len()}),
        )
        .await;
        assert_eq!(status, 200, "{reply}");
        offset += piece.chars().count();
        last = reply;
    }
    assert_eq!(last["title"], "Big spike", "{last}");
    // Out of order is refused rather than stitched wrongly.
    let (status, _) = act(
        &daemon,
        serde_json::json!({"kind":"research_write","actor":"owner","action":"import_chunk",
            "upload":"upload-0002","path":"/workspace/docs/other.md","offset":10,
            "text":"late","done":true}),
    )
    .await;
    assert_eq!(status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn awareness_claims_a_hotspot_and_types_its_note_into_the_agent() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (ada, ada_pty) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;
    let (_bob, bob_pty) = daemon
        .terminal(WS, &runner, "req-bob-01", "Bob", 12, 1012)
        .await;

    let (status, reply) = act(
        &daemon,
        serde_json::json!({"kind":"hotspot_claim","actor":"owner","ptyId": ada_pty,
            "paths":["/workspace/src/routes.ts"],"owner":"Ada (/workspace)","note":"hotspot"}),
    )
    .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["message"], "Claimed 1 path(s).");
    let (_, again) = act(
        &daemon,
        serde_json::json!({"kind":"hotspot_claim","actor":"owner","ptyId": ada_pty,
            "paths":["/workspace/src/routes.ts"],"owner":"Ada"}),
    )
    .await;
    assert_eq!(again["message"], "Already held.");
    // Bob's agent now meets Ada's claim, as any claim would refuse it.
    let (status, refused) = act(
        &daemon,
        serde_json::json!({"kind":"hotspot_claim","actor":"owner","ptyId": bob_pty,
            "paths":["/workspace/src/routes.ts"],"owner":"Bob"}),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    let (_, held) = daemon.agent(WS, &ada, "GET", "/ctx/claims", None).await;
    assert_eq!(held["claims"][0]["paths"][0], "/workspace/src/routes.ts");

    let (status, note) = act(
        &daemon,
        serde_json::json!({"kind":"mesh_job_update","actor":"owner","ptyId": bob_pty,
            "instance": format!("remote-{WS}"),"jobId":"aw-1234abcd-12",
            "text":"Heads-up from the Canopy workspace: Ada changed routes.ts.","refKind":"awareness"}),
    )
    .await;
    assert_eq!(status, 200, "{note}");
    support::wait_until(
        "the note is typed",
        std::time::Duration::from_secs(5),
        || {
            runner
                .writes_to(12)
                .iter()
                .any(|w| w.data.contains("[canopy: awareness]"))
        },
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_roster_says_which_repository_an_agent_works_in_and_what_it_wrote() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (_ada, _) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;
    let (status, body) = daemon
        .admin(
            "PATCH",
            &format!("/admin/workspaces/{WS}/terminals/req-ada-01"),
            Some(serde_json::json!({
                "repo":"git@github.com:acme/api.git","root":"/workspace/api",
                "files":[{"path":"src/a.ts","ts":5},{"path":"/etc/passwd","ts":6},{"path":"../x","ts":7}]
            })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["changed"], true);
    let ws = daemon.service().workspace(WS).unwrap();
    let roster = canopy_service::relay::roster_agents(&ws);
    assert_eq!(roster[0]["repo"], "git@github.com:acme/api.git");
    assert_eq!(roster[0]["root"], "/workspace/api");
    assert_eq!(
        roster[0]["files"],
        serde_json::json!([{"path":"src/a.ts","ts":5}]),
        "only paths inside the checkout"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_structured_runner_credential_survives_a_reconcile_while_its_host_lists_it() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (status, minted) = daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/terminals"),
            Some(serde_json::json!({ "requestId": "runner-att:1", "name": "Structured runner" })),
        )
        .await;
    assert_eq!(status, 200, "{minted}");
    runner.state.runners.lock().unwrap().push("att_1".into());
    let ws = daemon.service().workspace(WS).unwrap();
    daemon.service().reconcile(&ws).await.unwrap();
    assert!(ws
        .terminals
        .all()
        .iter()
        .any(|t| t.request_id == "runner-att:1" && t.live()));
}
