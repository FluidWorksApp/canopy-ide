//! canopy_device_* from a cloud agent: relayed to the IDE that has the
//! workspace open, answered in pieces, and refused plainly when no IDE is.
mod support;

use support::{Daemon, FakeRunner};

const WS: &str = "ws-1";

async fn admin(daemon: &Daemon, path: &str, body: serde_json::Value) -> (u16, serde_json::Value) {
    daemon
        .admin(
            "POST",
            &format!("/admin/workspaces/{WS}/{path}"),
            Some(body),
        )
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cloud_agent_drives_a_device_through_the_ide() {
    let daemon = Daemon::start().await;
    let runner = FakeRunner::start().await;
    daemon.register(WS, Some(&runner)).await;
    let (ada, ada_pty) = daemon
        .terminal(WS, &runner, "req-ada-01", "Ada", 11, 1011)
        .await;

    // No IDE has asked for ops: the agent is told where to go.
    let (status, refused) = daemon
        .agent(
            WS,
            &ada,
            "POST",
            "/ctx/device",
            Some(serde_json::json!({"op":"list"})),
        )
        .await;
    assert_eq!(status, 503, "{refused}");
    assert_eq!(refused["reason"], "no-ide");
    assert!(refused["message"]
        .as_str()
        .unwrap()
        .contains("computer the device is attached to"));

    // The IDE's poll says it is there.
    let (status, none) = admin(
        &daemon,
        "query",
        serde_json::json!({"store":"device","action":"pending","args":{"wait":10}}),
    )
    .await;
    assert_eq!(status, 200, "{none}");
    assert_eq!(none["items"], serde_json::json!([]));

    let agent = {
        let daemon_socket = daemon.agent_socket(WS);
        let token = ada.clone();
        tokio::spawn(async move {
            support::call(
                &daemon_socket,
                "POST",
                "/ctx/device",
                Some(&token),
                Some(serde_json::json!({"op":"tap","x":10,"y":20})),
            )
            .await
        })
    };
    let (_, ops) = admin(
        &daemon,
        "query",
        serde_json::json!({"store":"device","action":"pending","args":{"wait":5000}}),
    )
    .await;
    let op = &ops["items"][0];
    assert_eq!(op["op"]["op"], "tap");
    assert_eq!(op["op"]["x"], 10);
    assert_eq!(op["ptyId"], ada_pty);
    let id = op["id"].as_str().unwrap().to_string();
    let body = "{\"tapped\":[10,20]}";
    let (status, _) = admin(&daemon, "actions", serde_json::json!({"kind":"device_answer","actor":"owner","id":id,"status":200,"chunk":&body[..5],"offset":0,"done":false})).await;
    assert_eq!(status, 200);
    let (status, _) = admin(&daemon, "actions", serde_json::json!({"kind":"device_answer","actor":"owner","id":id,"status":200,"chunk":&body[5..],"offset":5,"done":true})).await;
    assert_eq!(status, 200);
    let (status, answer) = agent.await.unwrap();
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer, serde_json::json!({"tapped":[10,20]}));

    // An error from the desktop's device route reaches the agent as one.
    let agent = {
        let daemon_socket = daemon.agent_socket(WS);
        let token = ada.clone();
        tokio::spawn(async move {
            support::call(
                &daemon_socket,
                "POST",
                "/ctx/device",
                Some(&token),
                Some(serde_json::json!({"op":"key"})),
            )
            .await
        })
    };
    let (_, ops) = admin(
        &daemon,
        "query",
        serde_json::json!({"store":"device","action":"pending","args":{"wait":5000}}),
    )
    .await;
    let id = ops["items"][0]["id"].as_str().unwrap().to_string();
    admin(&daemon, "actions", serde_json::json!({"kind":"device_answer","actor":"owner","id":id,"status":400,"chunk":"key needs a keyevent name","offset":0,"done":true})).await;
    let (status, _) = agent.await.unwrap();
    assert_eq!(status, 400);
}
