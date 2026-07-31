//! What an agent is doing — the Rust half, over the manifest TypeScript reads.
//!
//! The mirror of `shared/agentLife/`. Both sides compile in the same
//! `fidelity.json` and `policy.json` (the technique `shortcuts.rs` already uses
//! for chords), and `shared/agentLife/fixtures.json` is replayed by the tests
//! at the bottom of this file *and* by vitest, asserting the two ladders agree
//! verdict for verdict.
//!
//! That parity test is the load-bearing part. The thing it prevents already
//! happened once: `state_for` decided a Notification meant "finished" by
//! matching `"waiting for"` in the message, and `shared/notifications.ts`
//! decided the same bytes meant "blocked" by matching `/waiting for (your )?
//! input/i` — two non-equivalent predicates over one string, in two languages,
//! with a comment in the Rust file *stating* it mirrored the frontend and
//! nothing enforcing it. "Waiting for approval" was `idle` on one side and a
//! pending card on the other.
//!
//! The other thing worth stating: the producer this replaces took no `agent`
//! argument. Every CLI was asked the same questions and every answer believed
//! equally, so a CLI that structurally cannot report being blocked had that
//! state invented for it, and one that can report nothing else had "finished"
//! invented for it. Here the manifest is consulted before the digest is
//! believed, never after.

// Compiled into two binaries — the app and the hook helper — which use
// different halves of it. Every symbol here is live in at least one of them,
// and the parity tests exercise all of it, so per-symbol allows would be noise
// that hides a genuinely dead one later.
#![allow(dead_code)]

use serde::Deserialize;
use std::sync::OnceLock;

const FIDELITY: &str = include_str!("../../shared/agentLife/fidelity.json");
const POLICY_JSON: &str = include_str!("../../shared/agentLife/policy.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifeState {
    Starting,
    Working,
    Waiting,
    Idle,
    Ended,
    Unknown,
}

impl LifeState {
    pub fn as_str(self) -> &'static str {
        match self {
            LifeState::Starting => "starting",
            LifeState::Working => "working",
            LifeState::Waiting => "waiting",
            LifeState::Idle => "idle",
            LifeState::Ended => "ended",
            LifeState::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    Proven,
    Reported,
    Inferred,
}

impl Confidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Confidence::Proven => "proven",
            Confidence::Reported => "reported",
            Confidence::Inferred => "inferred",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Life {
    pub state: LifeState,
    pub confidence: Confidence,
    pub via: &'static str,
    pub reason: Option<&'static str>,
    pub since: u64,
    pub agent: Option<String>,
}

/// What the terminal says. `live: false` is the authoritative "this session's
/// terminal is gone", and may only be constructed by a caller that owns the
/// binding — a session running outside Canopy has no terminal of ours and must
/// simply not have `PtyEvidence` at all.
#[derive(Debug, Clone, Copy, Default)]
pub struct PtyEvidence {
    pub live: bool,
    /// An agent-shaped process holds the foreground. False means the shell we
    /// spawned does, which is the definitive "nothing is running here".
    pub has_agent: bool,
    pub cpu: f32,
    pub quiet_ms: Option<u64>,
    pub since_input_ms: Option<u64>,
    /// Unix seconds this terminal was first seen, for the startup grace.
    pub first_seen: Option<u64>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct CliFidelity {
    pub id: String,
    #[serde(default)]
    pub ends_session: Vec<String>,
    #[serde(default)]
    pub ends_turn: Vec<String>,
    #[serde(default)]
    pub starts_turn: Vec<String>,
    #[serde(default)]
    pub tool_activity: Vec<String>,
    #[serde(default)]
    pub structured_block: Vec<String>,
    #[serde(default)]
    pub notification: String,
    #[serde(default)]
    pub prompt_ready_text: Option<String>,
    #[serde(default)]
    pub needs_trust: bool,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    clis: Vec<RawFidelity>,
}

/// The JSON is camelCase because TypeScript reads it first; this is the seam.
#[derive(Debug, Deserialize)]
struct RawFidelity {
    id: String,
    #[serde(default)]
    #[serde(rename = "endsSession")]
    ends_session: Vec<String>,
    #[serde(default)]
    #[serde(rename = "endsTurn")]
    ends_turn: Vec<String>,
    #[serde(default)]
    #[serde(rename = "startsTurn")]
    starts_turn: Vec<String>,
    #[serde(default)]
    #[serde(rename = "toolActivity")]
    tool_activity: Vec<String>,
    #[serde(default)]
    #[serde(rename = "structuredBlock")]
    structured_block: Vec<String>,
    #[serde(default)]
    notification: String,
    #[serde(default)]
    #[serde(rename = "promptReadyText")]
    prompt_ready_text: Option<String>,
    #[serde(default)]
    #[serde(rename = "needsTrust")]
    needs_trust: bool,
}

#[derive(Debug, Deserialize, Clone, Copy)]
pub struct Policy {
    #[serde(rename = "quietCpuPercent")]
    pub quiet_cpu_percent: f32,
    #[serde(rename = "quietOutputMs")]
    pub quiet_output_ms: u64,
    #[serde(rename = "answerWindowMs")]
    pub answer_window_ms: u64,
    #[serde(rename = "hookTrustSecs")]
    pub hook_trust_secs: u64,
    #[serde(rename = "startupGraceSecs")]
    pub startup_grace_secs: u64,
    #[serde(rename = "peerMaxAgeSecs")]
    pub peer_max_age_secs: u64,
    #[serde(rename = "creditedGapSecs")]
    pub credited_gap_secs: u64,
    #[serde(rename = "learnWindowSecs")]
    pub learn_window_secs: u64,
}

/// A malformed manifest declares nothing and changes no state. It must never
/// abort: this crate's discipline is that the passthrough always runs, and a
/// hook that panics on a bad config file is a CLI that stops working. The
/// `include_str!` makes a deleted or renamed file a build failure instead.
fn manifest() -> &'static Vec<CliFidelity> {
    static M: OnceLock<Vec<CliFidelity>> = OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str::<Manifest>(FIDELITY)
            .map(|m| {
                m.clis
                    .into_iter()
                    .map(|r| CliFidelity {
                        id: r.id,
                        ends_session: r.ends_session,
                        ends_turn: r.ends_turn,
                        starts_turn: r.starts_turn,
                        tool_activity: r.tool_activity,
                        structured_block: r.structured_block,
                        notification: r.notification,
                        prompt_ready_text: r.prompt_ready_text,
                        needs_trust: r.needs_trust,
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

pub fn policy() -> &'static Policy {
    static P: OnceLock<Policy> = OnceLock::new();
    P.get_or_init(|| {
        serde_json::from_str::<Policy>(POLICY_JSON).unwrap_or(Policy {
            quiet_cpu_percent: 2.0,
            quiet_output_ms: 3000,
            answer_window_ms: 5000,
            hook_trust_secs: 300,
            startup_grace_secs: 20,
            peer_max_age_secs: 1800,
            credited_gap_secs: 900,
            learn_window_secs: 600,
        })
    })
}

pub fn fidelity_for(agent: &str) -> CliFidelity {
    manifest()
        .iter()
        .find(|c| c.id == agent)
        .cloned()
        .unwrap_or_default()
}

pub fn all_fidelity() -> &'static Vec<CliFidelity> {
    manifest()
}

fn can_declare_block(f: &CliFidelity) -> bool {
    matches!(f.notification.as_str(), "block" | "mixed" | "attention-only")
}

fn reachable(f: &CliFidelity, via: &str) -> bool {
    match via {
        "session-end" => !f.ends_session.is_empty(),
        "structured-block" => !f.structured_block.is_empty(),
        "declared-block" => can_declare_block(f),
        "turn-boundary" => !f.ends_turn.is_empty(),
        "turn-start" => !f.starts_turn.is_empty(),
        "tool-activity" => !f.tool_activity.is_empty(),
        _ => true,
    }
}

/// The rung a digest's state came from. New digests say so; old ones are mapped
/// from their four legacy states, with a deliberate demotion — a legacy
/// `waiting` becomes `declared-block`, never `structured-block`, because the
/// producer that wrote it decided from message text and we cannot tell after
/// the fact which kind it was.
fn rung_of(d: &serde_json::Value) -> Option<&'static str> {
    if let Some(v) = d["state_via"].as_str() {
        return Some(match v {
            "session-end" => "session-end",
            "structured-block" => "structured-block",
            "declared-block" => "declared-block",
            "turn-boundary" => "turn-boundary",
            "turn-start" => "turn-start",
            "tool-activity" => "tool-activity",
            _ => return None,
        });
    }
    match d["state"].as_str()? {
        "ended" => Some("session-end"),
        "waiting" => Some("declared-block"),
        "idle" => Some("turn-boundary"),
        "working" => Some("tool-activity"),
        _ => None,
    }
}

fn painting(p: &PtyEvidence, pol: &Policy) -> bool {
    let Some(quiet) = p.quiet_ms else {
        return false;
    };
    if quiet > pol.quiet_output_ms {
        return false;
    }
    // Output within a moment of the human typing is the CLI echoing them.
    if let Some(since_input) = p.since_input_ms {
        if since_input <= pol.answer_window_ms {
            return quiet < since_input;
        }
    }
    true
}

/// The lifecycle verdict. Rungs are evaluated strictly in order and the first
/// match returns; no later rung may overturn an earlier one.
pub fn agent_life(digest: &serde_json::Value, pty: Option<&PtyEvidence>, now: u64) -> Life {
    let agent = digest["agent"].as_str().map(str::to_string);
    let f = fidelity_for(agent.as_deref().unwrap_or(""));
    let updated = digest["updated"].as_u64().unwrap_or(0);
    let pol = policy();
    let is_null = digest.is_null() || digest.as_object().map(|o| o.is_empty()).unwrap_or(true);

    let say = |state, confidence, via, since, reason| Life {
        state,
        confidence,
        via,
        reason,
        since,
        agent: agent.clone(),
    };

    // Rung 0 — the process is gone. Beats every digest claim, including a
    // `waiting` that outlived the session that wrote it.
    if let Some(p) = pty {
        if !p.live || !p.has_agent {
            return say(LifeState::Ended, Confidence::Proven, "process-gone", now, None);
        }
    }

    let via = if is_null { None } else { rung_of(digest) };
    let store = digest["store"].as_bool().unwrap_or(false);
    let foreign = digest["foreign"].as_bool().unwrap_or(false);
    let usable = !is_null && !store && !foreign && via.map(|v| reachable(&f, v)).unwrap_or(false);

    if usable {
        let hook_conf = if f.needs_trust {
            Confidence::Reported
        } else {
            Confidence::Proven
        };
        match via.unwrap_or("") {
            "session-end" => {
                return say(LifeState::Ended, Confidence::Proven, "session-end", updated, None)
            }
            "structured-block" => {
                return say(
                    LifeState::Waiting,
                    Confidence::Proven,
                    "structured-block",
                    updated,
                    None,
                )
            }
            "declared-block" => {
                let c = if f.notification == "attention-only" {
                    Confidence::Reported
                } else {
                    Confidence::Proven
                };
                return say(LifeState::Waiting, c, "declared-block", updated, None);
            }
            "turn-boundary" => {
                return say(LifeState::Idle, hook_conf, "turn-boundary", updated, None)
            }
            v @ ("turn-start" | "tool-activity") => {
                // A digest with no timestamp cannot be aged, so it is
                // believed — mirrors ladder.ts, and the fixtures check it.
                if updated == 0 || now.saturating_sub(updated) < pol.hook_trust_secs {
                    let via: &'static str = if v == "turn-start" {
                        "turn-start"
                    } else {
                        "tool-activity"
                    };
                    return say(LifeState::Working, hook_conf, via, updated, None);
                }
            }
            _ => {}
        }
    }

    if let Some(p) = pty {
        // Rung 7 — the terminal is painting. The decisive channel, and the only
        // positive evidence at all for a CLI whose hooks cannot say "working".
        if painting(p, pol) {
            return say(LifeState::Working, Confidence::Inferred, "output", now, None);
        }
        // Rung 8 — the process tree is burning CPU. Weakest positive rung.
        if p.cpu >= pol.quiet_cpu_percent {
            return say(LifeState::Working, Confidence::Inferred, "cpu", now, None);
        }
        // Rung 9 — a process is here and nothing has spoken for it yet.
        if is_null {
            if let Some(seen) = p.first_seen {
                if now.saturating_sub(seen) < pol.startup_grace_secs {
                    return say(
                        LifeState::Starting,
                        Confidence::Inferred,
                        "startup",
                        now,
                        None,
                    );
                }
            }
        }
    }

    // Rung 10 — nothing we will stand behind, and which kind of not-knowing.
    let reason = if foreign {
        "foreign-instance"
    } else if store || (!is_null && via.is_none()) {
        "store-only"
    } else if !is_null && via.map(|v| !reachable(&f, v)).unwrap_or(false) {
        "cli-cannot-report"
    } else if !is_null {
        "went-quiet"
    } else {
        "never-reported"
    };
    say(
        LifeState::Unknown,
        Confidence::Inferred,
        "none",
        now,
        Some(reason),
    )
}

/// The only predicate a destructive action may key on.
pub fn reclaimable(l: &Life, blocked: bool) -> bool {
    matches!(l.state, LifeState::Idle | LifeState::Ended)
        && l.confidence == Confidence::Proven
        && !blocked
}

/// Something is running here. `Unknown` is excluded on purpose: we can promise
/// neither way, and a roster that counts a session it cannot see is worse than
/// one that admits the gap.
pub fn is_running(l: &Life) -> bool {
    matches!(
        l.state,
        LifeState::Working | LifeState::Waiting | LifeState::Starting
    )
}

/// What one agent is told about another. The peer roster used to derive this
/// from a boolean that folded `waiting` into "not idle", so an agent stopped at
/// an unanswered permission prompt was described to every other agent in the
/// project as "active" — while the real state sat unread in the same file.
pub fn peer_label(l: &Life) -> &'static str {
    match l.state {
        LifeState::Working => "working",
        LifeState::Waiting => "blocked on the user",
        LifeState::Idle => "idle",
        LifeState::Ended => "ended",
        LifeState::Starting => "starting",
        LifeState::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: u64 = 1_800_000_000;

    fn live(cpu: f32, quiet_ms: Option<u64>) -> PtyEvidence {
        PtyEvidence {
            live: true,
            has_agent: true,
            cpu,
            quiet_ms,
            since_input_ms: None,
            first_seen: None,
        }
    }

    // The manifest-covers-SUPPORTED_AGENTS assertion lives in `agents.rs`,
    // beside the list it checks — this module is also compiled into the hook
    // binary, which has no `agents` module.
    #[test]
    fn manifest_parses() {
        assert!(
            !all_fidelity().is_empty(),
            "a manifest that fails to parse declares nothing, which is safe but silent"
        );
    }

    #[test]
    fn policy_parses() {
        assert_eq!(policy().quiet_cpu_percent, 2.0);
        assert_eq!(policy().hook_trust_secs, 300);
    }

    #[test]
    fn a_gone_process_beats_a_waiting_digest() {
        let d = json!({"state":"waiting","state_via":"structured-block","agent":"claude","updated":NOW-60});
        let p = PtyEvidence {
            live: false,
            ..Default::default()
        };
        let l = agent_life(&d, Some(&p), NOW);
        assert_eq!(l.state, LifeState::Ended);
        assert_eq!(l.via, "process-gone");
    }

    #[test]
    fn no_cli_that_cannot_report_a_block_is_given_one() {
        for f in all_fidelity() {
            if !f.structured_block.is_empty() || can_declare_block(f) {
                continue;
            }
            let d = json!({"state":"waiting","state_via":"declared-block","agent":f.id,"updated":NOW-1});
            let l = agent_life(&d, Some(&live(0.0, Some(999_999))), NOW);
            assert_ne!(l.state, LifeState::Waiting, "{} cannot prove waiting", f.id);
        }
    }

    #[test]
    fn silence_never_decays_a_block() {
        let d = json!({"state":"waiting","state_via":"structured-block","agent":"claude","updated":NOW-864_000});
        let l = agent_life(&d, Some(&live(0.0, Some(999_999))), NOW);
        assert_eq!(l.state, LifeState::Waiting);
    }

    #[test]
    fn a_quiet_working_claim_becomes_unknown_not_idle() {
        let d = json!({"state":"working","state_via":"tool-activity","agent":"codex","updated":NOW-840});
        let l = agent_life(&d, Some(&live(0.0, Some(600_000))), NOW);
        assert_eq!(l.state, LifeState::Unknown);
        assert_eq!(l.reason, Some("went-quiet"));
        assert!(!reclaimable(&l, false), "unknown is not finished");
    }

    #[test]
    fn a_painting_terminal_is_working_even_with_no_hooks() {
        let d = json!({"agent":"aider"});
        let l = agent_life(&d, Some(&live(0.0, Some(200))), NOW);
        assert_eq!(l.state, LifeState::Working);
        assert_eq!(l.via, "output");
    }

    #[test]
    fn a_store_row_is_unknown_not_idle() {
        let d = json!({"agent":"claude","store":true,"updated":NOW-10});
        let l = agent_life(&d, None, NOW);
        assert_eq!(l.state, LifeState::Unknown);
        assert_eq!(l.reason, Some("store-only"));
    }

    #[test]
    fn ended_is_never_inferred_from_quiet() {
        for cpu in [0.0f32, 1.0, 50.0] {
            for quiet in [Some(0u64), Some(10_000_000), None] {
                let d = json!({"state":"working","state_via":"tool-activity","agent":"claude","updated":NOW-86_400});
                let l = agent_life(&d, Some(&live(cpu, quiet)), NOW);
                assert_ne!(l.state, LifeState::Ended);
            }
        }
    }

    #[test]
    fn a_blocked_peer_is_not_described_as_active() {
        let d = json!({"state":"waiting","state_via":"structured-block","agent":"claude","updated":NOW-5});
        let l = agent_life(&d, Some(&live(0.0, Some(999_999))), NOW);
        assert_eq!(peer_label(&l), "blocked on the user");
    }

    /// The parity fixtures, replayed against the same file vitest replays.
    #[test]
    fn matches_the_typescript_ladder_on_every_fixture() {
        #[derive(Deserialize)]
        struct Fixture {
            name: String,
            digest: serde_json::Value,
            pty: Option<FixturePty>,
            now: u64,
            expect: Expect,
        }
        #[derive(Deserialize)]
        struct FixturePty {
            kind: String,
            #[serde(default)]
            hint: bool,
            #[serde(default)]
            cpu: f32,
            #[serde(default)]
            #[serde(rename = "quietForMs")]
            quiet_for_ms: Option<u64>,
            #[serde(default)]
            #[serde(rename = "sinceInputMs")]
            since_input_ms: Option<u64>,
            #[serde(default)]
            #[serde(rename = "firstSeen")]
            first_seen: Option<u64>,
        }
        #[derive(Deserialize)]
        struct Expect {
            state: String,
            via: String,
            confidence: String,
        }
        const FIXTURES: &str = include_str!("../../shared/agentLife/fixtures.json");
        let cases: Vec<Fixture> = serde_json::from_str(FIXTURES).expect("fixtures parse");
        assert!(cases.len() >= 20, "the parity net must be worth having");
        for c in cases {
            let pty = c.pty.map(|p| PtyEvidence {
                live: p.kind == "live",
                has_agent: p.hint,
                cpu: p.cpu,
                quiet_ms: p.quiet_for_ms,
                since_input_ms: p.since_input_ms,
                first_seen: p.first_seen,
            });
            let l = agent_life(&c.digest, pty.as_ref(), c.now);
            assert_eq!(l.state.as_str(), c.expect.state, "state for {}", c.name);
            assert_eq!(l.via, c.expect.via, "via for {}", c.name);
            assert_eq!(
                l.confidence.as_str(),
                c.expect.confidence,
                "confidence for {}",
                c.name
            );
        }
    }
}
