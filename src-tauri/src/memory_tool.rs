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
//! The filtering, scoring and proposal rules live in canopy-core's `memory`
//! module, shared with a cloud workspace's service; this adapts them to the
//! desktop ledger. context.rs owns the route and the ledger I/O.

use crate::ledger::{LedgerAuthor, LedgerEntry, LedgerRef};
pub use canopy_core::memory::{keywords, servable, MemoryQuery, Proposal};
use canopy_core::memory::{proposal_data, validate_proposal, MemoryRecord};
#[cfg(test)]
use canopy_core::memory::{score, DAY_MS};

impl MemoryRecord for LedgerEntry {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }
    fn expires_at(&self) -> Option<u64> {
        self.expires_at
    }
    fn data(&self) -> &serde_json::Value {
        &self.data
    }
    fn scope(&self) -> &str {
        &self.scope
    }
    fn author_name(&self) -> &str {
        &self.author.name
    }
    fn ts(&self) -> u64 {
        self.ts
    }
}

/// Filter, rank and shape entries for `canopy_memory` (canopy-core has the
/// rules, shared with a cloud workspace's service).
pub fn select(entries: &[LedgerEntry], q: &MemoryQuery, now: u64) -> serde_json::Value {
    canopy_core::memory::select(entries, q, now)
}

fn new_memory_id(now: u64) -> String {
    let mut bytes = [0u8; 4];
    let _ = getrandom::getrandom(&mut bytes);
    format!("mem-{now:x}-{}", hex::encode(bytes))
}

/// The ledger entry for an agent's proposal. Always "proposed": an agent can
/// suggest team memory and never approve it, including its own.
pub fn proposal_entry(p: &Proposal, pty_id: Option<u32>, now: u64) -> Result<LedgerEntry, String> {
    let v = validate_proposal(p, now)?;
    Ok(LedgerEntry {
        id: String::new(),
        kind: "memory".into(),
        ts: 0,
        root: String::new(),
        author: LedgerAuthor {
            kind: "agent".into(),
            name: v.by.clone(),
            session_id: None,
            cli: None,
            pty_id: pty_id.map(u64::from),
        },
        scope: v.scope.clone(),
        subject: Some(v.subject.clone()),
        reference: pty_id.map(|id| LedgerRef {
            kind: "pty".into(),
            id: id.to_string(),
        }),
        data: proposal_data(&v, &new_memory_id(now), now),
        expires_at: Some(v.expires_at),
        supersedes: None,
        status: Some("proposed".into()),
    })
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
}
