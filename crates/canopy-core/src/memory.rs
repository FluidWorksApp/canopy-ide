//! Team memory for agents: the pure half of `canopy_memory` and
//! `canopy_memory_propose`, shared by the desktop bridge (over its ledger) and
//! a cloud workspace's service (over the copy the desktop syncs to it).
//!
//! Memory lives in the desktop's ledger (`kind: "memory"`, see
//! src/memoryLedger.ts for the entry shape). An agent gets just-in-time
//! retrieval — the few approved entries relevant to what it is about to
//! decide — rather than a growing file preloaded into every session. What it
//! may be told is narrow on purpose: approved by a person, not expired, not
//! quarantined. Anything an agent proposes lands as "proposed" and is never
//! served until a person approves it in the Memory panel.
//!
//! No storage here: callers hand in entries through [`MemoryRecord`].

use std::collections::HashSet;

pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 30;
pub const TYPES: &[&str] = &["decision", "constraint", "convention", "fact"];
pub const SCOPES: &[&str] = &["personal", "project", "team"];

/// Words that say nothing about a topic. Mirrors `STOP` in memoryLedger.ts.
const STOP: &[&str] = &[
    "the", "and", "but", "for", "with", "from", "are", "was", "were", "been", "its", "this",
    "that", "these", "those", "our", "you", "your", "they", "their", "not", "use", "uses", "used",
    "using", "should", "must", "always", "never", "all", "any", "each", "when", "then", "than",
    "into", "over", "under", "via", "per", "can", "will", "would",
];

/// The fields of a ledger entry memory retrieval reads.
pub trait MemoryRecord {
    fn kind(&self) -> &str;
    fn status(&self) -> Option<&str>;
    fn expires_at(&self) -> Option<u64>;
    fn data(&self) -> &serde_json::Value;
    fn scope(&self) -> &str;
    fn author_name(&self) -> &str;
    fn ts(&self) -> u64;
}

/// A memory entry as the desktop's `ledger_query` serializes it (camelCase),
/// keeping only what retrieval reads. What a cloud service stores.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub ts: u64,
    #[serde(default)]
    pub author: SyncedAuthor,
    #[serde(default)]
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SyncedAuthor {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
}

impl MemoryRecord for SyncedEntry {
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

fn data_str<'a, E: MemoryRecord + ?Sized>(e: &'a E, key: &str) -> &'a str {
    e.data().get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// What an agent may be told: a memory a person approved, still in date.
/// Quarantined, proposed, rejected, expired and superseded entries all fail
/// the status test — quarantine is never a soft label here.
pub fn servable<E: MemoryRecord + ?Sized>(e: &E, now: u64) -> bool {
    e.kind() == "memory"
        && e.status() == Some("approved")
        && e.expires_at().is_none_or(|t| t > now)
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
pub fn score<E: MemoryRecord + ?Sized>(e: &E, terms: &HashSet<String>) -> f64 {
    let text = keywords(data_str(e, "text"));
    let why = keywords(data_str(e, "why"));
    let mut files = String::new();
    if let Some(list) = e
        .data()
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
        .data()
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

/// `YYYY-MM-DD` (UTC) for unix ms. Civil-from-days, so no date crate.
pub fn iso_day(ms: u64) -> String {
    let days = (ms / DAY_MS) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The agent-facing row: the memory, why, and where it came from.
fn row<E: MemoryRecord + ?Sized>(e: &E) -> serde_json::Value {
    let p = e.data().get("provenance");
    serde_json::json!({
        "id": data_str(e, "memoryId"),
        "type": data_str(e, "type"),
        "text": data_str(e, "text"),
        "why": data_str(e, "why"),
        "scope": e.scope(),
        "source": data_str(e, "source"),
        "author": e.author_name(),
        "session": p.and_then(|p| p.get("sessionId")).cloned().unwrap_or(serde_json::Value::Null),
        "files": p.and_then(|p| p.get("files")).cloned().unwrap_or(serde_json::json!([])),
        "recorded": iso_day(e.data().get("createdAt").and_then(|v| v.as_u64()).unwrap_or(e.ts())),
        "expires": e.expires_at().map(iso_day),
    })
}

pub const NONE_MATCH_NOTE: &str =
    "No approved team memory matches. Decide on the evidence in front of you; if the decision \
     is durable and non-obvious, propose it with canopy_memory_propose.";

/// Filter, rank and shape entries for `canopy_memory`. `entries` are ledger
/// chain heads, newest first; a forked chain (two heads for one memoryId) is
/// served once, newest wins.
pub fn select<E: MemoryRecord>(entries: &[E], q: &MemoryQuery, now: u64) -> serde_json::Value {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let terms = keywords(&q.query);
    let scope = q.scope.as_deref().filter(|s| !s.is_empty() && *s != "all");
    let kind = q.kind.as_deref().filter(|s| !s.is_empty());
    let mut seen = HashSet::new();
    let mut ranked: Vec<(f64, &E)> = entries
        .iter()
        .filter(|e| servable(*e, now))
        .filter(|e| seen.insert(data_str(*e, "memoryId").to_string()))
        .filter(|e| scope.is_none_or(|s| e.scope() == s))
        .filter(|e| kind.is_none_or(|k| data_str(*e, "type") == k))
        .filter_map(|e| {
            if terms.is_empty() {
                // No query: the most confident, newest first.
                let c = e
                    .data()
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
        NONE_MATCH_NOTE
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

/// A proposal that passed validation, normalized.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidProposal {
    pub kind: String,
    pub text: String,
    pub why: String,
    pub scope: String,
    pub files: Vec<String>,
    /// Who proposed it, "agent" when unnamed.
    pub by: String,
    /// The ledger subject: the text's first 120 characters.
    pub subject: String,
    /// Facts age out sooner than decisions.
    pub expires_at: u64,
}

/// Check an agent's proposal. The errors are what the agent is told.
pub fn validate_proposal(p: &Proposal, now: u64) -> Result<ValidProposal, String> {
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
    Ok(ValidProposal {
        kind: kind.into(),
        text: text.into(),
        why: p.why.trim().chars().take(600).collect(),
        scope: scope.into(),
        files: p.files.iter().take(50).cloned().collect(),
        by: p
            .by
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("agent")
            .to_string(),
        subject: text.chars().take(120).collect(),
        expires_at: now + days * DAY_MS,
    })
}

/// The `data` of a proposal's ledger entry.
pub fn proposal_data(p: &ValidProposal, memory_id: &str, now: u64) -> serde_json::Value {
    serde_json::json!({
        "memoryId": memory_id,
        "type": p.kind,
        "text": p.text,
        "why": p.why,
        "confidence": 0.5,
        "createdAt": now,
        "source": "agent",
        "provenance": { "files": p.files },
    })
}

/// What an agent is told after proposing.
pub const PROPOSED_NOTE: &str = "Recorded as a proposal. A person reviews it in Canopy's Memory \
     panel; it is not served to any agent until they approve it.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_day_matches_the_calendar() {
        assert_eq!(iso_day(0), "1970-01-01");
        assert_eq!(iso_day(951_782_400_000), "2000-02-29");
        assert_eq!(iso_day(1_800_000_000_000), "2027-01-15");
        assert_eq!(iso_day(1_709_164_800_000 + 3_600_000), "2024-02-29");
    }

    #[test]
    fn synced_entries_select_like_ledger_entries() {
        let now = 1_800_000_000_000;
        let raw = serde_json::json!([{
            "id": "e1", "kind": "memory", "ts": now - 5, "root": "/r",
            "author": { "kind": "human", "name": "Ash" }, "scope": "project",
            "data": { "memoryId": "mem-1", "type": "constraint", "text": "Never call billing from handlers",
                      "why": "slow", "confidence": 0.9, "createdAt": now - 5, "source": "human",
                      "provenance": { "files": ["src/billing.ts"] } },
            "expiresAt": now + DAY_MS, "status": "approved"
        }]);
        let entries: Vec<SyncedEntry> = serde_json::from_value(raw).unwrap();
        let out = select(
            &entries,
            &MemoryQuery {
                query: "billing".into(),
                ..Default::default()
            },
            now,
        );
        assert_eq!(out["matched"], 1);
        assert_eq!(out["memories"][0]["id"], "mem-1");
        assert_eq!(out["memories"][0]["author"], "Ash");
        assert_eq!(out["memories"][0]["files"][0], "src/billing.ts");
    }

    #[test]
    fn proposals_validate() {
        let now = 1_000;
        let ok = Proposal {
            kind: "fact".into(),
            text: "  Staging lives in eu-west  ".into(),
            ..Default::default()
        };
        let v = validate_proposal(&ok, now).unwrap();
        assert_eq!(v.text, "Staging lives in eu-west");
        assert_eq!(v.scope, "project");
        assert_eq!(v.by, "agent");
        assert_eq!(v.expires_at, now + 90 * DAY_MS);
        let data = proposal_data(&v, "mem-x", now);
        assert_eq!(data["source"], "agent");
        assert_eq!(data["confidence"], 0.5);
        assert!(validate_proposal(
            &Proposal {
                kind: "rumour".into(),
                ..ok.clone()
            },
            now
        )
        .unwrap_err()
        .starts_with("type must be one of"));
    }
}
