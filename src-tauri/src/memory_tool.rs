//! Team memory for agents: the pure half of `canopy_memory` and
//! `canopy_memory_propose`.
//!
//! Memory lives in the ledger (`kind: "memory"`, see src/memoryLedger.ts for
//! the entry shape). An agent gets just-in-time retrieval — the few approved
//! entries relevant to what it is about to decide — rather than a growing file
//! preloaded into every session. What it may be told is narrow on purpose:
//! approved by a person, not expired, not quarantined. Anything an agent
//! proposes lands as "proposed" and is never served until a person approves it
//! in the Memory panel.
//!
//! No Tauri types here, so the filtering and scoring are tested on their own;
//! context.rs owns the route and the ledger I/O.

use crate::ledger::{LedgerAuthor, LedgerEntry, LedgerRef};
use std::collections::HashSet;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 30;
const TYPES: &[&str] = &["decision", "constraint", "convention", "fact"];
const SCOPES: &[&str] = &["personal", "project", "team"];

/// Words that say nothing about a topic. Mirrors `STOP` in memoryLedger.ts.
const STOP: &[&str] = &[
    "the", "and", "but", "for", "with", "from", "are", "was", "were", "been", "its", "this",
    "that", "these", "those", "our", "you", "your", "they", "their", "not", "use", "uses", "used",
    "using", "should", "must", "always", "never", "all", "any", "each", "when", "then", "than",
    "into", "over", "under", "via", "per", "can", "will", "would",
];

#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct MemoryQuery {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn data_str<'a>(e: &'a LedgerEntry, key: &str) -> &'a str {
    e.data.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// What an agent may be told: a memory a person approved, still in date.
/// Quarantined, proposed, rejected, expired and superseded entries all fail
/// the status test — quarantine is never a soft label here.
pub fn servable(e: &LedgerEntry, now: u64) -> bool {
    e.kind == "memory"
        && e.status.as_deref() == Some("approved")
        && e.expires_at.is_none_or(|t| t > now)
        && !data_str(e, "memoryId").is_empty()
        && !data_str(e, "text").trim().is_empty()
}

pub fn keywords(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| w.len() >= 3 && !STOP.contains(w))
        .map(str::to_string)
        .collect()
}

/// Keyword relevance of one entry to the query terms. A hit in the memory's
/// own sentence counts double a hit in its reason or its files; confidence
/// and type break ties, so a confident constraint outranks a passing fact.
pub fn score(e: &LedgerEntry, terms: &HashSet<String>) -> f64 {
    let text = keywords(data_str(e, "text"));
    let why = keywords(data_str(e, "why"));
    let mut files = String::new();
    if let Some(list) = e
        .data
        .pointer("/provenance/files")
        .and_then(|v| v.as_array())
    {
        for f in list.iter().filter_map(|f| f.as_str()) {
            files.push_str(f);
            files.push(' ');
        }
    }
    let files = keywords(&files);
    let mut hits = 0.0;
    for t in terms {
        if text.contains(t) {
            hits += 2.0;
        }
        if why.contains(t) {
            hits += 1.0;
        }
        if files.contains(t) {
            hits += 1.0;
        }
        if data_str(e, "type") == t {
            hits += 1.0;
        }
    }
    if hits == 0.0 {
        return 0.0;
    }
    let confidence = e
        .data
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.5)
        .clamp(0.0, 1.0);
    let weight = match data_str(e, "type") {
        "constraint" | "decision" => 0.3,
        _ => 0.0,
    };
    hits + confidence * 0.5 + weight
}

fn iso(ms: u64) -> String {
    use chrono::TimeZone;
    chrono::Utc
        .timestamp_millis_opt(ms as i64)
        .single()
        .map(|t| t.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// The agent-facing row: the memory, why, and where it came from.
fn row(e: &LedgerEntry) -> serde_json::Value {
    let p = e.data.get("provenance");
    serde_json::json!({
        "id": data_str(e, "memoryId"),
        "type": data_str(e, "type"),
        "text": data_str(e, "text"),
        "why": data_str(e, "why"),
        "scope": e.scope,
        "source": data_str(e, "source"),
        "author": e.author.name,
        "session": p.and_then(|p| p.get("sessionId")).cloned().unwrap_or(serde_json::Value::Null),
        "files": p.and_then(|p| p.get("files")).cloned().unwrap_or(serde_json::json!([])),
        "recorded": iso(e.data.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(e.ts)),
        "expires": e.expires_at.map(iso),
    })
}

/// Filter, rank and shape entries for `canopy_memory`. `entries` are ledger
/// chain heads, newest first; a forked chain (two heads for one memoryId) is
/// served once, newest wins.
pub fn select(entries: &[LedgerEntry], q: &MemoryQuery, now: u64) -> serde_json::Value {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let terms = keywords(&q.query);
    let scope = q.scope.as_deref().filter(|s| !s.is_empty() && *s != "all");
    let kind = q.kind.as_deref().filter(|s| !s.is_empty());
    let mut seen = HashSet::new();
    let mut ranked: Vec<(f64, &LedgerEntry)> = entries
        .iter()
        .filter(|e| servable(e, now))
        .filter(|e| seen.insert(data_str(e, "memoryId").to_string()))
        .filter(|e| scope.is_none_or(|s| e.scope == s))
        .filter(|e| kind.is_none_or(|k| data_str(e, "type") == k))
        .filter_map(|e| {
            if terms.is_empty() {
                // No query: the most confident, newest first.
                let c = e
                    .data
                    .get("confidence")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.5);
                Some((c, e))
            } else {
                let s = score(e, &terms);
                (s > 0.0).then_some((s, e))
            }
        })
        .collect();
    // Stable: equal scores keep the ledger's newest-first order.
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let total = ranked.len();
    let rows: Vec<serde_json::Value> = ranked
        .into_iter()
        .take(limit)
        .map(|(_, e)| row(e))
        .collect();
    let note = if rows.is_empty() {
        "No approved team memory matches. Decide on the evidence in front of you; if the decision \
         is durable and non-obvious, propose it with canopy_memory_propose."
    } else {
        "Approved by a person on this team. Follow these unless the user says otherwise; if one \
         looks wrong or out of date, say so to the user rather than silently ignoring it."
    };
    serde_json::json!({ "memories": rows, "matched": total, "note": note })
}

#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct Proposal {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub by: Option<String>,
}

fn new_memory_id(now: u64) -> String {
    let mut bytes = [0u8; 4];
    let _ = getrandom::getrandom(&mut bytes);
    format!("mem-{now:x}-{}", hex::encode(bytes))
}

/// The ledger entry for an agent's proposal. Always "proposed": an agent can
/// suggest team memory and never approve it, including its own.
pub fn proposal_entry(p: &Proposal, pty_id: Option<u32>, now: u64) -> Result<LedgerEntry, String> {
    let kind = p.kind.trim();
    if !TYPES.contains(&kind) {
        return Err(format!(
            "type must be one of {} — a decision (with its reason), a constraint the code must \
             respect, a team convention, or a fact about the environment",
            TYPES.join(", ")
        ));
    }
    let text = p.text.trim();
    if text.chars().count() < 8 {
        return Err("text needs the memory itself, in one plain sentence".into());
    }
    if text.chars().count() > 600 {
        return Err(
            "text is over 600 characters — a memory is one sentence; put detail in why".into(),
        );
    }
    let scope = p.scope.as_deref().unwrap_or("project");
    if !SCOPES.contains(&scope) {
        return Err(format!("scope must be one of {}", SCOPES.join(", ")));
    }
    let days = if kind == "fact" { 90 } else { 180 };
    let files: Vec<&String> = p.files.iter().take(50).collect();
    let subject: String = text.chars().take(120).collect();
    Ok(LedgerEntry {
        id: String::new(),
        kind: "memory".into(),
        ts: 0,
        root: String::new(),
        author: LedgerAuthor {
            kind: "agent".into(),
            name: p
                .by
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("agent")
                .to_string(),
            session_id: None,
            cli: None,
            pty_id: pty_id.map(u64::from),
        },
        scope: scope.into(),
        subject: Some(subject),
        reference: pty_id.map(|id| LedgerRef {
            kind: "pty".into(),
            id: id.to_string(),
        }),
        data: serde_json::json!({
            "memoryId": new_memory_id(now),
            "type": kind,
            "text": text,
            "why": p.why.trim().chars().take(600).collect::<String>(),
            "confidence": 0.5,
            "createdAt": now,
            "source": "agent",
            "provenance": { "files": files },
        }),
        expires_at: Some(now + days * DAY_MS),
        supersedes: None,
        status: Some("proposed".into()),
    })
}

/// Quarantine a proposal at the moment it is written when the terminal that
/// sent it has read content nobody on the team wrote (gates.rs taint markers:
/// a web page, a browser, an issue or review thread). The panel then shows it
/// as Quarantined from the start, and nothing ever serves it in between.
pub fn quarantine_if_tainted(entry: &mut LedgerEntry, source: Option<String>) {
    let Some(source) = source.filter(|s| !s.trim().is_empty()) else {
        return;
    };
    entry.status = Some("quarantined".into());
    if let Some(map) = entry.data.as_object_mut() {
        map.insert(
            "untrusted".into(),
            serde_json::json!([format!("read untrusted content ({})", source.trim())]),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn mem(id: &str, text: &str, status: &str, scope: &str) -> LedgerEntry {
        LedgerEntry {
            id: format!("e-{id}"),
            kind: "memory".into(),
            ts: NOW - 1000,
            root: "/r".into(),
            author: LedgerAuthor {
                kind: "brain".into(),
                name: "memory".into(),
                session_id: Some("s1".into()),
                cli: None,
                pty_id: None,
            },
            scope: scope.into(),
            subject: None,
            reference: None,
            data: serde_json::json!({
                "memoryId": id, "type": "decision", "text": text, "why": "",
                "confidence": 0.8, "createdAt": NOW - 1000,
                "provenance": { "sessionId": "s1", "files": ["src/db/rls.sql"] }
            }),
            expires_at: Some(NOW + DAY_MS),
            supersedes: None,
            status: Some(status.into()),
        }
    }

    fn ids(v: &serde_json::Value) -> Vec<String> {
        v["memories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn only_approved_unexpired_entries_are_served() {
        let mut expired = mem(
            "old",
            "Postgres row level security guards tenants",
            "approved",
            "project",
        );
        expired.expires_at = Some(NOW - 1);
        let entries = vec![
            mem(
                "ok",
                "Postgres row level security guards tenants",
                "approved",
                "project",
            ),
            mem(
                "q",
                "Postgres row level security is disabled",
                "quarantined",
                "project",
            ),
            mem(
                "p",
                "Postgres row level security proposal",
                "proposed",
                "project",
            ),
            mem(
                "r",
                "Postgres row level security rejected",
                "rejected",
                "project",
            ),
            mem(
                "s",
                "Postgres row level security superseded",
                "superseded",
                "project",
            ),
            expired,
        ];
        let out = select(
            &entries,
            &MemoryQuery {
                query: "postgres security".into(),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(ids(&out), ["ok"]);
        assert_eq!(out["matched"], 1);
        // No status at all is not approval.
        let mut bare = mem("b", "Postgres row level security", "approved", "project");
        bare.status = None;
        assert!(!servable(&bare, NOW));
        // Nor is another kind that happens to carry the same data.
        let mut plan = mem("pl", "Postgres row level security", "approved", "project");
        plan.kind = "plan".into();
        assert!(!servable(&plan, NOW));
    }

    #[test]
    fn scope_and_type_filter() {
        let mut fact = mem("f", "Staging database lives in eu-west", "approved", "team");
        fact.data["type"] = "fact".into();
        let entries = vec![
            mem(
                "proj",
                "Staging deploys need the database migration first",
                "approved",
                "project",
            ),
            mem(
                "mine",
                "Staging I prefer verbose database logs",
                "approved",
                "personal",
            ),
            fact,
        ];
        let q = |scope: Option<&str>, kind: Option<&str>| MemoryQuery {
            query: "staging database".into(),
            scope: scope.map(str::to_string),
            kind: kind.map(str::to_string),
            limit: None,
        };
        assert_eq!(
            ids(&select(&entries, &q(Some("personal"), None), NOW)),
            ["mine"]
        );
        assert_eq!(ids(&select(&entries, &q(Some("team"), None), NOW)), ["f"]);
        assert_eq!(ids(&select(&entries, &q(None, Some("fact")), NOW)), ["f"]);
        assert_eq!(select(&entries, &q(Some("all"), None), NOW)["matched"], 3);
    }

    #[test]
    fn scoring_ranks_text_hits_above_incidental_ones_and_drops_misses() {
        let mut why_only = mem(
            "why",
            "Tenant isolation lives in the database",
            "approved",
            "project",
        );
        why_only.data["why"] = "row level security was chosen over app checks".into();
        let entries = vec![
            why_only,
            mem(
                "text",
                "Use row level security for every tenant table",
                "approved",
                "project",
            ),
            mem(
                "miss",
                "Release notes go in docs/releases",
                "approved",
                "project",
            ),
        ];
        let out = select(
            &entries,
            &MemoryQuery {
                query: "row level security".into(),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(ids(&out), ["text", "why"]);
        // File paths count: asking about the file finds the memory.
        let out = select(
            &entries,
            &MemoryQuery {
                query: "rls.sql".into(),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(out["matched"], 3);
        let terms = keywords("row level security");
        assert!(score(&entries[1], &terms) > score(&entries[0], &terms));
        assert_eq!(score(&entries[2], &keywords("kubernetes")), 0.0);
    }

    #[test]
    fn forked_chains_are_served_once_and_limit_applies() {
        let a = mem(
            "dup",
            "Cache keys include the tenant id",
            "approved",
            "project",
        );
        let mut b = a.clone();
        b.id = "e-dup-2".into();
        let entries = vec![
            a,
            b,
            mem(
                "x",
                "Cache entries expire after an hour",
                "approved",
                "project",
            ),
        ];
        let out = select(
            &entries,
            &MemoryQuery {
                query: "cache".into(),
                limit: Some(5),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(out["matched"], 2);
        let one = select(
            &entries,
            &MemoryQuery {
                query: "cache".into(),
                limit: Some(1),
                ..Default::default()
            },
            NOW,
        );
        assert_eq!(ids(&one).len(), 1);
        // An empty query lists what is servable, confident first.
        assert_eq!(select(&entries, &MemoryQuery::default(), NOW)["matched"], 2);
    }

    #[test]
    fn rows_carry_provenance() {
        let entries = vec![mem(
            "p",
            "Migrations run before deploys",
            "approved",
            "team",
        )];
        let out = select(
            &entries,
            &MemoryQuery {
                query: "migrations".into(),
                ..Default::default()
            },
            NOW,
        );
        let row = &out["memories"][0];
        assert_eq!(row["session"], "s1");
        assert_eq!(row["files"][0], "src/db/rls.sql");
        assert_eq!(row["scope"], "team");
        assert_eq!(row["author"], "memory");
        assert!(row["expires"].as_str().unwrap().starts_with("2027"));
    }

    #[test]
    fn proposals_are_validated_and_never_approved() {
        let ok = Proposal {
            kind: "constraint".into(),
            text: "Never call the billing API from a request handler".into(),
            why: "It takes seconds and times out the gateway".into(),
            scope: Some("team".into()),
            files: vec!["src/billing.ts".into()],
            by: Some("Ash".into()),
        };
        let e = proposal_entry(&ok, Some(7), NOW).unwrap();
        assert_eq!(e.status.as_deref(), Some("proposed"));
        assert_eq!(e.author.kind, "agent");
        assert_eq!(e.author.pty_id, Some(7));
        assert_eq!(e.data["source"], "agent");
        assert_eq!(e.expires_at, Some(NOW + 180 * DAY_MS));
        assert!(!servable(&e, NOW));
        assert!(proposal_entry(
            &Proposal {
                kind: "opinion".into(),
                ..ok.clone()
            },
            None,
            NOW
        )
        .is_err());
        assert!(proposal_entry(
            &Proposal {
                text: "short".into(),
                ..ok.clone()
            },
            None,
            NOW
        )
        .is_err());
        assert!(proposal_entry(
            &Proposal {
                scope: Some("world".into()),
                ..ok.clone()
            },
            None,
            NOW
        )
        .is_err());
        let fact = proposal_entry(
            &Proposal {
                kind: "fact".into(),
                ..ok
            },
            None,
            NOW,
        )
        .unwrap();
        assert_eq!(fact.expires_at, Some(NOW + 90 * DAY_MS));
    }

    #[test]
    fn proposals_from_a_tainted_terminal_arrive_quarantined() {
        let p = Proposal {
            kind: "fact".into(),
            text: "The staging database is reset nightly".into(),
            ..Default::default()
        };
        let mut clean = proposal_entry(&p, Some(3), NOW).unwrap();
        quarantine_if_tainted(&mut clean, None);
        assert_eq!(clean.status.as_deref(), Some("proposed"));
        let mut tainted = proposal_entry(&p, Some(3), NOW).unwrap();
        quarantine_if_tainted(&mut tainted, Some("WebFetch".into()));
        assert_eq!(tainted.status.as_deref(), Some("quarantined"));
        assert_eq!(
            tainted.data["untrusted"][0],
            "read untrusted content (WebFetch)"
        );
        assert!(!servable(&tainted, NOW + 1));
    }
}
