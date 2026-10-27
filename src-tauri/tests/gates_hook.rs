//! End to end through the real `canopy-hook` binary: a PreToolUse event in on
//! stdin, the deny (or nothing) out on stdout, the block in the ledger, the
//! approve-once token spent — and the time it all takes, because this runs in
//! front of every shell command and edit an agent makes.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// The built helper. Cargo builds a package's binaries before its integration
/// tests and puts them one level above this test executable's `deps/` dir.
fn hook_bin() -> PathBuf {
    if let Some(p) = option_env!("CARGO_BIN_EXE_canopy-hook") {
        return PathBuf::from(p);
    }
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap();
    dir.join(if cfg!(windows) {
        "canopy-hook.exe"
    } else {
        "canopy-hook"
    })
}

fn root_hash(canonical: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(&Sha256::digest(canonical.as_bytes())[..16])
}

struct Sandbox {
    dir: PathBuf,
    home: PathBuf,
    repo: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("canopy-gates-e2e-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let home = dir.join("home");
        let repo = dir.join("repo");
        std::fs::create_dir_all(home.join(".canopy")).unwrap();
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("migrations")).unwrap();
        Sandbox { dir, home, repo }
    }

    fn canonical(&self) -> String {
        self.repo
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string()
    }

    fn write_policy(&self, policy: serde_json::Value) {
        let dir = self.home.join(".canopy/policy");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{}.json", root_hash(&self.canonical()))),
            policy.to_string(),
        )
        .unwrap();
    }

    fn ledger(&self) -> Vec<serde_json::Value> {
        let file = self
            .home
            .join(".canopy/ledger")
            .join(format!("{}.jsonl", root_hash(&self.canonical())));
        std::fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// Run the hook on one event; returns stdout.
    fn hook(&self, args: &[&str], event: serde_json::Value) -> String {
        let mut cmd = Command::new(hook_bin());
        cmd.args(args)
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("CANOPY", "1")
            .current_dir(&self.repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(event.to_string().as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn pre(&self, tool: &str, input: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "hook_event_name": "PreToolUse",
            "session_id": "s1",
            "cwd": self.repo.to_string_lossy(),
            "tool_name": tool,
            "tool_input": input,
        })
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn decision(stdout: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    let h = &v["hookSpecificOutput"];
    Some((
        h["permissionDecision"].as_str()?.to_string(),
        h["permissionDecisionReason"].as_str()?.to_string(),
    ))
}

#[test]
fn a_team_rule_blocks_an_edit_and_is_counted() {
    let s = Sandbox::new("rule");
    s.write_policy(serde_json::json!({
        "version": 1,
        "gates": [{ "id": "r1", "rule": "Never touch migrations/", "scope": "team",
                    "gate": { "type": "deny-path-write", "globs": ["migrations/"] } }],
    }));
    let target = s.repo.join("migrations/0001.sql");
    let out = s.hook(
        &[],
        s.pre("Edit", serde_json::json!({ "file_path": target })),
    );
    let (verdict, reason) = decision(&out).expect(&out);
    assert_eq!(verdict, "deny");
    assert!(
        reason.starts_with("Blocked by team rule 'Never touch migrations/'"),
        "{reason}"
    );

    let ledger = s.ledger();
    assert_eq!(ledger.len(), 1, "{ledger:?}");
    let e = &ledger[0];
    assert_eq!(e["kind"], "rule");
    assert_eq!(e["scope"], "team");
    assert_eq!(e["status"], "blocked");
    assert_eq!(e["data"]["type"], "block");
    assert_eq!(e["data"]["ruleId"], "r1");
    assert_eq!(e["ref"]["kind"], "gate-event");

    // The bus event carries the same verdict for the app.
    let bus = std::fs::read_to_string(s.home.join(".canopy/agent-events.jsonl")).unwrap();
    let last: serde_json::Value = serde_json::from_str(bus.lines().last().unwrap()).unwrap();
    assert_eq!(last["canopy_gate"]["status"], "blocked");
    assert_eq!(last["canopy_gate"]["id"], e["ref"]["id"]);

    // Outside the rule: nothing printed, the CLI's own flow proceeds.
    let ok = s.hook(
        &[],
        s.pre(
            "Edit",
            serde_json::json!({ "file_path": s.repo.join("src/a.ts") }),
        ),
    );
    assert!(ok.trim().is_empty(), "{ok}");
}

#[test]
fn an_irreversible_command_waits_for_approve_once() {
    let s = Sandbox::new("irreversible");
    let cmd = "terraform destroy -auto-approve";
    let out = s.hook(&[], s.pre("Bash", serde_json::json!({ "command": cmd })));
    let (verdict, reason) = decision(&out).expect(&out);
    assert_eq!(verdict, "deny");
    assert!(
        reason.contains("can't be undone") && reason.contains("exactly the same command"),
        "{reason}"
    );

    // The person clicks "Approve once": the app writes the token the hook stamped.
    let bus = std::fs::read_to_string(s.home.join(".canopy/agent-events.jsonl")).unwrap();
    let last: serde_json::Value = serde_json::from_str(bus.lines().last().unwrap()).unwrap();
    assert_eq!(last["canopy_gate"]["status"], "needs-approval");
    let key = last["canopy_gate"]["key"].as_str().unwrap().to_string();
    let approvals = s.home.join(".canopy/policy/approvals");
    std::fs::create_dir_all(&approvals).unwrap();
    let far = 4_000_000_000_000u64;
    std::fs::write(
        approvals.join(format!("{key}.json")),
        format!("{{\"expiresAt\":{far}}}"),
    )
    .unwrap();

    // The exact command runs once…
    let again = s.hook(&[], s.pre("Bash", serde_json::json!({ "command": cmd })));
    assert!(
        again.trim().is_empty(),
        "approved once should pass: {again}"
    );
    // …and only once.
    let third = s.hook(&[], s.pre("Bash", serde_json::json!({ "command": cmd })));
    assert_eq!(decision(&third).map(|d| d.0).as_deref(), Some("deny"));
    let statuses: Vec<String> = s
        .ledger()
        .iter()
        .map(|e| e["status"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        statuses,
        ["needs-approval", "allowed-once", "needs-approval"]
    );
}

#[test]
fn the_cloud_workspace_claude_dialect_is_enforced_too() {
    // In the Linux workspace Claude's hooks run `canopy-hook --agent claude`.
    let s = Sandbox::new("vm");
    let out = s.hook(
        &["--agent", "claude"],
        s.pre("Bash", serde_json::json!({ "command": "dropdb prod" })),
    );
    assert_eq!(
        decision(&out).map(|d| d.0).as_deref(),
        Some("deny"),
        "{out}"
    );
    // A CLI whose deny contract is unverified is never sent one.
    let codex = s.hook(
        &["--agent", "codex"],
        s.pre("Bash", serde_json::json!({ "command": "dropdb prod" })),
    );
    assert!(decision(&codex).is_none(), "{codex}");
}

#[test]
fn untrusted_content_then_secrets_is_blocked_when_the_project_says_so() {
    let s = Sandbox::new("trifecta");
    s.write_policy(serde_json::json!({ "version": 1, "trifecta": "block", "gates": [] }));
    let env = s.repo.join(".env");
    // Before any web content, .env is just a file.
    assert!(s
        .hook(&[], s.pre("Read", serde_json::json!({ "file_path": env })))
        .trim()
        .is_empty());
    let mut post = s.pre(
        "WebFetch",
        serde_json::json!({ "url": "https://example.com" }),
    );
    post["hook_event_name"] = serde_json::json!("PostToolUse");
    s.hook(&[], post);
    let out = s.hook(&[], s.pre("Read", serde_json::json!({ "file_path": env })));
    let (verdict, reason) = decision(&out).expect(&out);
    assert_eq!(verdict, "deny");
    assert!(reason.contains("untrusted-content"), "{reason}");
    let push = s.hook(
        &[],
        s.pre(
            "Bash",
            serde_json::json!({ "command": "git push origin main" }),
        ),
    );
    assert_eq!(decision(&push).map(|d| d.0).as_deref(), Some("deny"));
}

#[test]
fn the_hook_stays_fast() {
    let s = Sandbox::new("latency");
    s.write_policy(serde_json::json!({
        "version": 1,
        "gates": [
            { "id": "a", "rule": "No migrations", "gate": { "type": "deny-path-write", "globs": ["migrations/", "*.sql"] } },
            { "id": "b", "rule": "No publish", "gate": { "type": "deny-command", "patterns": ["^npm\\s+publish\\b"] } },
            { "id": "c", "rule": "No moment", "gate": { "type": "package-denylist", "names": ["moment"] } },
        ],
    }));
    let event = s.pre(
        "Bash",
        serde_json::json!({ "command": "ls -la && cargo test" }),
    );
    s.hook(&[], event.clone()); // warm the page cache
    let runs = 15;
    let start = Instant::now();
    for _ in 0..runs {
        assert!(s.hook(&[], event.clone()).trim().is_empty());
    }
    let per = start.elapsed() / runs;
    eprintln!("canopy-hook PreToolUse with a 3-gate policy: {per:?} per call (debug build, process start included)");
    // Generous for an unoptimized build on a busy CI box; release is a few ms.
    assert!(per < Duration::from_millis(250), "{per:?}");
}
