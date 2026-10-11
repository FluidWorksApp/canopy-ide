//! The companion's reply channel: request-scoped, one answer each.
//!
//! The companion reaches an agent by typing into its terminal, and it has no
//! terminal of its own, so before this the agent had nothing to answer *to*:
//! `canopy_message_agent` targets agent terminals only. A request that arrived
//! from Slack therefore could never get its answer back to the thread.
//!
//! Every companion dispatch to an agent mints a request here. The id is an
//! unguessable capability, but it is not the authority on its own: a reply is
//! accepted only from the exact terminal (pty id + app instance) the request
//! was typed into, before its deadline, and only once. The id travels in the
//! sender tag; the terminal binding never leaves this process.
//!
//! The contract, which a companion running elsewhere (a workspace VM) has to
//! honour in its own bridge: the dispatcher mints `cr_` + 128 random bits,
//! names it in the tag, accepts `canopy_companion_reply {requestId, text}` from
//! the dispatched terminal alone, closes the request on its first reply, and
//! tells the companion when the deadline passes unanswered.

use std::collections::HashMap;
use std::sync::Mutex;

/// How long an agent has to answer. Long enough for real work, short enough
/// that a Slack thread is not left waiting for an hour on a stalled session.
pub const REQUEST_TTL_MS: u64 = 10 * 60_000;

/// Open requests kept at once. One companion dispatching to more than this
/// within ten minutes is a loop; the oldest is expired (and reported) to make
/// room rather than the store growing.
pub const MAX_OPEN_REQUESTS: usize = 64;

/// Longest origin label the frontend may attach (e.g. `slack:<item id>`).
const MAX_ORIGIN_CHARS: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionRequest {
    pub id: String,
    pub pty_id: u32,
    #[serde(skip)]
    pub instance: String,
    /// The target's display name and cwd at dispatch, for attributing the
    /// reply without a second lookup that could race the terminal exiting.
    pub agent_name: Option<String>,
    pub cwd: String,
    /// Where the companion turn that dispatched it came from: `None` for the
    /// owner's own chat, otherwise an opaque label the frontend set (Slack
    /// uses `slack:<inbox item id>`). Opaque here on purpose — Slack's rules
    /// live in slackBridge.ts and nowhere else.
    pub origin: Option<String>,
    pub issued_ms: u64,
    pub deadline_ms: u64,
}

/// Why a reply was refused. Each gets its own wording so the agent knows
/// whether to stop (expired, answered, not yours) or fix a typo (unknown).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Unknown,
    WrongCaller { pty_id: u32 },
    Expired,
    Answered,
}

#[derive(Debug)]
enum Entry {
    Open(CompanionRequest),
    /// Kept until the original deadline so a second reply, or one after the
    /// deadline, is told what happened instead of "no such request".
    Answered {
        deadline_ms: u64,
    },
    Expired {
        until_ms: u64,
    },
}

#[derive(Default)]
pub struct CompanionRequests {
    entries: Mutex<HashMap<String, Entry>>,
    /// The origin of the companion turn in flight, set by the frontend just
    /// before it sends the turn. Read at mint.
    origin: Mutex<Option<String>>,
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the OS random source is unavailable");
    format!("cr_{}", hex::encode(bytes))
}

/// A well-formed request id — checked before any lookup so a refusal never
/// echoes arbitrary caller text back.
pub fn valid_id(id: &str) -> bool {
    id.len() == 35 && id.starts_with("cr_") && id[3..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl CompanionRequests {
    pub fn set_origin(&self, origin: Option<String>) -> Result<(), String> {
        let origin = origin
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty());
        if let Some(o) = &origin {
            if o.chars().count() > MAX_ORIGIN_CHARS
                || !o
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
            {
                return Err("companion origin must be a short [A-Za-z0-9:_.-] label".into());
            }
        }
        *self.origin.lock().unwrap() = origin;
        Ok(())
    }

    /// Mint a request for one dispatch. Returns it with any open request that
    /// had to be expired early to stay under the cap; the caller reports those
    /// exactly as it reports a deadline passing.
    pub fn mint(
        &self,
        pty_id: u32,
        instance: &str,
        agent_name: Option<String>,
        cwd: String,
        now_ms: u64,
    ) -> (CompanionRequest, Vec<CompanionRequest>) {
        let origin = self.origin.lock().unwrap().clone();
        let mut entries = self.entries.lock().unwrap();
        let mut evicted = Self::sweep(&mut entries, now_ms);
        let open = |e: &Entry| matches!(e, Entry::Open(_));
        while entries.values().filter(|e| open(e)).count() >= MAX_OPEN_REQUESTS {
            let oldest = entries
                .iter()
                .filter_map(|(k, e)| match e {
                    Entry::Open(r) => Some((r.issued_ms, k.clone())),
                    _ => None,
                })
                .min()
                .map(|(_, k)| k);
            let Some(key) = oldest else { break };
            if let Some(Entry::Open(r)) = entries.remove(&key) {
                entries.insert(
                    key,
                    Entry::Expired {
                        until_ms: now_ms + REQUEST_TTL_MS,
                    },
                );
                evicted.push(r);
            }
        }
        // Tombstones are bounded too: they never outnumber the open cap.
        if entries.len() >= MAX_OPEN_REQUESTS * 2 {
            entries.retain(|_, e| open(e));
        }
        let request = CompanionRequest {
            id: new_id(),
            pty_id,
            instance: instance.to_string(),
            agent_name,
            cwd,
            origin,
            issued_ms: now_ms,
            deadline_ms: now_ms + REQUEST_TTL_MS,
        };
        entries.insert(request.id.clone(), Entry::Open(request.clone()));
        (request, evicted)
    }

    /// Withdraw a request whose message never reached the terminal.
    pub fn cancel(&self, id: &str) {
        self.entries.lock().unwrap().remove(id);
    }

    /// Accept one reply. Closes the request on success.
    pub fn answer(
        &self,
        id: &str,
        caller_pty: u32,
        caller_instance: &str,
        now_ms: u64,
    ) -> Result<CompanionRequest, Refusal> {
        let mut entries = self.entries.lock().unwrap();
        match entries.get(id) {
            None => Err(Refusal::Unknown),
            Some(Entry::Answered { .. }) => Err(Refusal::Answered),
            Some(Entry::Expired { .. }) => Err(Refusal::Expired),
            Some(Entry::Open(r)) => {
                // Identity before time: a terminal the request was never sent
                // to learns nothing about its state.
                if r.pty_id != caller_pty || r.instance != caller_instance {
                    return Err(Refusal::WrongCaller { pty_id: caller_pty });
                }
                if now_ms >= r.deadline_ms {
                    // Left Open: `expire_due` owns the transition, so the
                    // companion's "went unanswered" notice is never skipped.
                    return Err(Refusal::Expired);
                }
                let r = r.clone();
                entries.insert(
                    id.to_string(),
                    Entry::Answered {
                        deadline_ms: r.deadline_ms,
                    },
                );
                Ok(r)
            }
        }
    }

    /// Requests whose deadline has passed unanswered, each returned once.
    pub fn expire_due(&self, now_ms: u64) -> Vec<CompanionRequest> {
        Self::sweep(&mut self.entries.lock().unwrap(), now_ms)
    }

    /// Ids still open for one origin — what the Slack side asks at the end of
    /// a turn to decide whether to hold its single reply.
    pub fn open_for(&self, origin: &str, now_ms: u64) -> Vec<String> {
        let entries = self.entries.lock().unwrap();
        let mut open: Vec<(u64, String)> = entries
            .values()
            .filter_map(|e| match e {
                Entry::Open(r) if r.origin.as_deref() == Some(origin) && now_ms < r.deadline_ms => {
                    Some((r.issued_ms, r.id.clone()))
                }
                _ => None,
            })
            .collect();
        open.sort();
        open.into_iter().map(|(_, id)| id).collect()
    }

    fn sweep(entries: &mut HashMap<String, Entry>, now_ms: u64) -> Vec<CompanionRequest> {
        let mut due = Vec::new();
        entries.retain(|_, e| match e {
            Entry::Answered { deadline_ms } => now_ms < *deadline_ms,
            Entry::Expired { until_ms } => now_ms < *until_ms,
            Entry::Open(_) => true,
        });
        for e in entries.values_mut() {
            if let Entry::Open(r) = e {
                if now_ms >= r.deadline_ms {
                    due.push(r.clone());
                    *e = Entry::Expired {
                        until_ms: r.deadline_ms + REQUEST_TTL_MS,
                    };
                }
            }
        }
        due.sort_by_key(|r| r.issued_ms);
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mint(store: &CompanionRequests, pty: u32, now: u64) -> CompanionRequest {
        store
            .mint(pty, "inst", Some("Fern".into()), "/repo".into(), now)
            .0
    }

    #[test]
    fn ids_are_unguessable_and_well_formed() {
        let store = CompanionRequests::default();
        let a = mint(&store, 7, 0);
        let b = mint(&store, 7, 0);
        assert_ne!(a.id, b.id);
        assert!(valid_id(&a.id), "{}", a.id);
        assert_eq!(a.id.len(), 3 + 32, "128 bits of hex");
        assert!(!valid_id("cr_123"));
        assert!(!valid_id(&format!("xx_{}", &a.id[3..])));
        assert_eq!(a.deadline_ms, REQUEST_TTL_MS);
    }

    #[test]
    fn the_dispatched_terminal_answers_once() {
        let store = CompanionRequests::default();
        let r = mint(&store, 7, 0);
        let got = store.answer(&r.id, 7, "inst", 1_000).unwrap();
        assert_eq!(got.pty_id, 7);
        assert_eq!(got.agent_name.as_deref(), Some("Fern"));
        assert_eq!(
            store.answer(&r.id, 7, "inst", 2_000),
            Err(Refusal::Answered)
        );
        // An answered request is not reported as unanswered later.
        assert!(store.expire_due(REQUEST_TTL_MS + 1).is_empty());
    }

    #[test]
    fn another_terminal_cannot_answer_and_does_not_spend_it() {
        let store = CompanionRequests::default();
        let r = mint(&store, 7, 0);
        assert_eq!(
            store.answer(&r.id, 8, "inst", 1),
            Err(Refusal::WrongCaller { pty_id: 8 })
        );
        // Same pty id from a previous app run is a different terminal.
        assert_eq!(
            store.answer(&r.id, 7, "old-inst", 1),
            Err(Refusal::WrongCaller { pty_id: 7 })
        );
        assert!(store.answer(&r.id, 7, "inst", 2).is_ok());
    }

    #[test]
    fn unknown_and_expired_are_refused_and_expiry_is_reported_once() {
        let store = CompanionRequests::default();
        assert_eq!(
            store.answer("cr_00000000000000000000000000000000", 7, "inst", 0),
            Err(Refusal::Unknown)
        );
        let r = mint(&store, 7, 0);
        assert_eq!(
            store.answer(&r.id, 7, "inst", REQUEST_TTL_MS),
            Err(Refusal::Expired)
        );
        let due = store.expire_due(REQUEST_TTL_MS);
        assert_eq!(
            due.iter().map(|d| d.id.clone()).collect::<Vec<_>>(),
            vec![r.id.clone()]
        );
        assert!(
            store.expire_due(REQUEST_TTL_MS + 5).is_empty(),
            "reported once"
        );
        assert_eq!(
            store.answer(&r.id, 7, "inst", REQUEST_TTL_MS + 5),
            Err(Refusal::Expired)
        );
    }

    #[test]
    fn the_origin_in_flight_is_recorded_and_queryable() {
        let store = CompanionRequests::default();
        store.set_origin(Some("slack:item-0001".into())).unwrap();
        let slack = mint(&store, 7, 0);
        store.set_origin(None).unwrap();
        let local = mint(&store, 8, 1);
        assert_eq!(slack.origin.as_deref(), Some("slack:item-0001"));
        assert_eq!(local.origin, None);
        assert_eq!(store.open_for("slack:item-0001", 2), vec![slack.id.clone()]);
        store.answer(&slack.id, 7, "inst", 3).unwrap();
        assert!(store.open_for("slack:item-0001", 4).is_empty());
        assert!(store.set_origin(Some("slack:<script>".into())).is_err());
    }

    #[test]
    fn the_store_is_bounded_and_reports_what_it_evicts() {
        let store = CompanionRequests::default();
        let first = mint(&store, 1, 0);
        for i in 1..MAX_OPEN_REQUESTS as u64 {
            mint(&store, 1, i);
        }
        let (_, evicted) = store.mint(1, "inst", None, "/r".into(), 1_000);
        assert_eq!(evicted.len(), 1);
        assert_eq!(evicted[0].id, first.id);
        assert_eq!(
            store.answer(&first.id, 1, "inst", 1_001),
            Err(Refusal::Expired)
        );
        assert!(store.entries.lock().unwrap().len() <= MAX_OPEN_REQUESTS * 2);
    }

    #[test]
    fn a_cancelled_request_is_gone() {
        let store = CompanionRequests::default();
        let r = mint(&store, 7, 0);
        store.cancel(&r.id);
        assert_eq!(store.answer(&r.id, 7, "inst", 1), Err(Refusal::Unknown));
    }
}
