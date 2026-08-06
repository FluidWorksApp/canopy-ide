// The agent mesh's message store: every message one agent sends another,
// first-class and durable.
//
// canopy_message_agent delivers by typing into the target's terminal — the one
// interface every CLI has — but the message itself used to live only in that
// keystroke stream: no id to reply to, no history an agent could read back,
// one flattened line of plain text or nothing. This store is the message's
// real home. Delivery is still a typed line; the record is the artifact, and
// it can be more than the line — a multi-line body, shared files, a reply
// pointer, a typed reference other systems can query by.
//
// Doctrine, inherited from claims (context.rs) and the mesh audit:
//   - identity comes from the terminal's credential, never the body: the
//     `from` fields are filled in by the bridge from `Caller`, and no argument
//     an agent passes can claim another sender;
//   - one write door: `record` is called from the bridge's action handler and
//     nowhere else;
//   - unlike claims, messages survive a restart. "What did I send, to whom,
//     and what came back" is a question about history, and its answer must not
//     depend on whether the app has been relaunched since — so the log lives
//     under ~/.canopy/mesh, outside every repo, exactly as notes and research
//     do and for the same reasons.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// How many messages the log keeps, in memory and on disk. The cap is the
/// whole retention policy: old traffic ages out of the front as new traffic
/// lands, and the file is rewritten to match.
const MAX_KEPT: usize = 500;

/// One shared item riding on a message: a file on this machine, by absolute
/// path. "Multimodal" here means the receiver opens it with its own tools —
/// the mesh carries the reference and what it is, not the bytes, so a
/// screenshot, a log or a diff costs the store one line either way.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MeshItem {
    /// "image" for formats a model can look at directly, else "file".
    pub kind: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A typed reference a message can carry — a task, an attempt, a PR — so
/// "every message about X" is one query rather than an archaeology dig. The
/// kinds are deliberately open: the mesh records them, it does not know them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MeshRef {
    pub kind: String,
    pub id: String,
}

/// One agent-to-agent message. Field names are the store's wire format twice
/// over — each is one JSONL line on disk, and `context_messages` hands the
/// same shape to the frontend — so additions here must default cleanly for
/// lines written before they existed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeshMessage {
    /// "m<n>", unique across app runs: the counter resumes past everything
    /// the log already holds.
    pub id: String,
    /// The terminal it came from, when the sender was an agent. `None` is the
    /// companion or another root-token caller.
    #[serde(default)]
    pub from_pty_id: Option<u32>,
    #[serde(default)]
    pub from_cwd: Option<String>,
    /// Which CLI the sender was, and what its run was titled at send time —
    /// the "who is this and what are they working on" that a bare pty id
    /// stops answering the moment the app restarts.
    #[serde(default)]
    pub from_agent: Option<String>,
    #[serde(default)]
    pub from_task: Option<String>,
    pub to_pty_id: u32,
    #[serde(default)]
    pub to_cwd: Option<String>,
    #[serde(default)]
    pub to_agent: Option<String>,
    #[serde(default)]
    pub to_task: Option<String>,
    /// The message itself, as the sender wrote it. For a plain
    /// canopy_message_agent send this is the sanitised delivered line; for a
    /// mesh send it is the full body, and `delivered` records the notice.
    pub text: String,
    /// The line actually typed into the target, when it differs from `text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<MeshItem>,
    /// The message this answers, by id — what turns a log into threads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<MeshRef>,
    /// The app run that delivered it. Pty ids restart at 1 every launch, so
    /// without this a message from a previous run appears to involve whatever
    /// terminal holds that small integer now.
    #[serde(default)]
    pub instance: Option<String>,
    pub at_ms: u64,
    /// False when the terminal died before the return that submits the typed
    /// line could be written — the notice is sitting unsent in a composer
    /// nobody will press enter on.
    pub submitted: bool,
}

/// Everything the bridge knows at send time. The store adds the id and the
/// submitted flag; everything else is evidence the caller of `record` already
/// established.
pub struct NewMessage {
    pub from_pty_id: Option<u32>,
    pub from_cwd: Option<String>,
    pub from_agent: Option<String>,
    pub from_task: Option<String>,
    pub to_pty_id: u32,
    pub to_cwd: Option<String>,
    pub to_agent: Option<String>,
    pub to_task: Option<String>,
    pub text: String,
    pub items: Vec<MeshItem>,
    pub reply_to: Option<String>,
    pub reference: Option<MeshRef>,
    pub instance: Option<String>,
    pub at_ms: u64,
}

struct Inner {
    messages: Vec<MeshMessage>,
    next_id: u64,
    /// None means "nowhere to persist" (no home directory): the mesh still
    /// works for this run, it just starts empty next time.
    path: Option<PathBuf>,
}

pub struct MeshStore {
    inner: Mutex<Inner>,
}

impl Default for MeshStore {
    fn default() -> Self {
        Self::load()
    }
}

fn store_path() -> Option<PathBuf> {
    // CANOPY_MESH_HOME points straight at the store directory (tests); HOME
    // gets the usual ~/.canopy/mesh. Same convention as notes and research.
    if let Ok(dir) = std::env::var("CANOPY_MESH_HOME") {
        return Some(PathBuf::from(dir).join("messages.jsonl"));
    }
    let home = std::env::var("HOME").ok()?;
    Some(
        PathBuf::from(home)
            .join(".canopy")
            .join("mesh")
            .join("messages.jsonl"),
    )
}

impl MeshStore {
    pub fn load() -> Self {
        Self::at(store_path())
    }

    /// Open the store at an explicit location — the test seam, and what
    /// `load` resolves to.
    pub fn at(path: Option<PathBuf>) -> Self {
        let mut messages: Vec<MeshMessage> = Vec::new();
        if let Some(p) = &path {
            if let Ok(raw) = std::fs::read_to_string(p) {
                // A line that doesn't parse is skipped, not fatal: one
                // corrupted write must not take the whole history with it.
                messages.extend(
                    raw.lines()
                        .filter_map(|l| serde_json::from_str::<MeshMessage>(l).ok()),
                );
            }
        }
        if messages.len() > MAX_KEPT {
            let excess = messages.len() - MAX_KEPT;
            messages.drain(0..excess);
        }
        // Resume past everything ever written, including messages the cap has
        // already dropped from the front — an id, once handed out, is never
        // reused for a different message.
        let next_id = messages
            .iter()
            .filter_map(|m| m.id.strip_prefix('m')?.parse::<u64>().ok())
            .max()
            .unwrap_or(0)
            + 1;
        MeshStore {
            inner: Mutex::new(Inner {
                messages,
                next_id,
                path,
            }),
        }
    }

    /// The one write door. Mints the id, appends, caps, persists, and returns
    /// the record as stored.
    pub fn record(&self, new: NewMessage) -> MeshMessage {
        let mut inner = self.inner.lock().unwrap();
        let id = format!("m{}", inner.next_id);
        inner.next_id += 1;
        let msg = MeshMessage {
            id,
            from_pty_id: new.from_pty_id,
            from_cwd: new.from_cwd,
            from_agent: new.from_agent,
            from_task: new.from_task,
            to_pty_id: new.to_pty_id,
            to_cwd: new.to_cwd,
            to_agent: new.to_agent,
            to_task: new.to_task,
            text: new.text,
            delivered: None,
            items: new.items,
            reply_to: new.reply_to,
            reference: new.reference,
            instance: new.instance,
            at_ms: new.at_ms,
            submitted: false,
        };
        inner.messages.push(msg.clone());
        if inner.messages.len() > MAX_KEPT {
            let excess = inner.messages.len() - MAX_KEPT;
            inner.messages.drain(0..excess);
        }
        inner.persist();
        msg
    }

    /// Record what was actually typed into the target, when it differs from
    /// the body (a mesh send's notice line).
    pub fn note_delivery(&self, id: &str, line: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(m) = inner.messages.iter_mut().find(|m| m.id == id) {
            m.delivered = Some(line.to_string());
            inner.persist();
        }
    }

    /// The return that submits the typed line landed.
    pub fn mark_submitted(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(m) = inner.messages.iter_mut().find(|m| m.id == id) {
            m.submitted = true;
            inner.persist();
        }
    }

    pub fn get(&self, id: &str) -> Option<MeshMessage> {
        self.inner
            .lock()
            .unwrap()
            .messages
            .iter()
            .find(|m| m.id == id)
            .cloned()
    }

    /// Every kept message, oldest first.
    pub fn all(&self) -> Vec<MeshMessage> {
        self.inner.lock().unwrap().messages.clone()
    }
}

impl Inner {
    /// Rewrite the whole file, via a sibling and a rename so a crash
    /// mid-write leaves the old log rather than half of a new one. The log is
    /// small by construction (MAX_KEPT), so rewriting beats an append format
    /// that could never amend `submitted` in place.
    fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        if let Some(dir) = path.parent() {
            if std::fs::create_dir_all(dir).is_err() {
                return;
            }
        }
        let mut out = String::new();
        for m in &self.messages {
            if let Ok(line) = serde_json::to_string(m) {
                out.push_str(&line);
                out.push('\n');
            }
        }
        let tmp = path.with_extension("jsonl.tmp");
        if std::fs::write(&tmp, out).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_msg(text: &str, to: u32) -> NewMessage {
        NewMessage {
            from_pty_id: Some(1),
            from_cwd: Some("/w".into()),
            from_agent: Some("claude".into()),
            from_task: Some("mesh work".into()),
            to_pty_id: to,
            to_cwd: Some("/w".into()),
            to_agent: None,
            to_task: None,
            text: text.into(),
            items: Vec::new(),
            reply_to: None,
            reference: None,
            instance: Some("test".into()),
            at_ms: 42,
        }
    }

    fn tmp_store(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canopy-mesh-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("messages.jsonl")
    }

    #[test]
    fn a_message_survives_a_restart_and_ids_never_repeat() {
        let path = tmp_store("restart");
        let store = MeshStore::at(Some(path.clone()));
        let first = store.record(new_msg("take src/auth.ts", 7));
        assert_eq!(first.id, "m1");
        store.mark_submitted(&first.id);

        // A new store on the same file is "the app restarted".
        let reopened = MeshStore::at(Some(path.clone()));
        let kept = reopened.all();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "m1");
        assert_eq!(kept[0].text, "take src/auth.ts");
        assert_eq!(kept[0].from_task.as_deref(), Some("mesh work"));
        assert!(kept[0].submitted);
        // The counter resumes past history: the old id still names the old
        // message, and the next send cannot collide with it.
        let second = reopened.record(new_msg("done, released", 1));
        assert_eq!(second.id, "m2");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn rich_fields_round_trip_through_disk() {
        let path = tmp_store("rich");
        let store = MeshStore::at(Some(path.clone()));
        let mut msg = new_msg("full handoff\nwith a second line", 7);
        msg.items = vec![MeshItem {
            kind: "image".into(),
            path: "/w/shot.png".into(),
            note: Some("the broken layout".into()),
        }];
        msg.reply_to = Some("m9".into());
        msg.reference = Some(MeshRef {
            kind: "task".into(),
            id: "T-12".into(),
        });
        let stored = store.record(msg);
        store.note_delivery(&stored.id, "notice line");

        let back = MeshStore::at(Some(path.clone())).get(&stored.id).unwrap();
        assert_eq!(back.text, "full handoff\nwith a second line");
        assert_eq!(back.delivered.as_deref(), Some("notice line"));
        assert_eq!(back.items, stored.items);
        assert_eq!(back.reply_to.as_deref(), Some("m9"));
        assert_eq!(
            back.reference,
            Some(MeshRef {
                kind: "task".into(),
                id: "T-12".into()
            })
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_cap_drops_the_oldest_and_only_the_oldest() {
        let path = tmp_store("cap");
        let store = MeshStore::at(Some(path.clone()));
        for n in 0..MAX_KEPT + 3 {
            store.record(new_msg(&format!("msg {n}"), 7));
        }
        let kept = store.all();
        assert_eq!(kept.len(), MAX_KEPT);
        assert_eq!(kept[0].text, "msg 3");
        assert_eq!(kept.last().unwrap().text, format!("msg {}", MAX_KEPT + 2));
        // And the file agrees: reload sees the same window, and the counter
        // still moves forward from the highest id ever written.
        let reopened = MeshStore::at(Some(path.clone()));
        assert_eq!(reopened.all().len(), MAX_KEPT);
        let next = reopened.record(new_msg("one more", 7));
        assert_eq!(next.id, format!("m{}", MAX_KEPT + 4));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_corrupt_line_costs_that_line_and_nothing_else() {
        let path = tmp_store("corrupt");
        let store = MeshStore::at(Some(path.clone()));
        store.record(new_msg("good", 7));
        // Something truncated mid-write, ahead of a valid line.
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw = format!("{{\"half\": tru\n{raw}");
        std::fs::write(&path, raw).unwrap();
        let reopened = MeshStore::at(Some(path.clone()));
        assert_eq!(reopened.all().len(), 1);
        assert_eq!(reopened.all()[0].text, "good");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn no_home_means_a_working_in_memory_store() {
        let store = MeshStore::at(None);
        let msg = store.record(new_msg("still works", 7));
        assert_eq!(store.get(&msg.id).unwrap().text, "still works");
    }
}
