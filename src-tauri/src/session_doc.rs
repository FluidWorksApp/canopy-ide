// The backend half of session documents (src/sessionDoc): the end of one
// conversation's transcript, read from the agent CLI's own store.
//
// Everything else a session document shows already had a command — the turn
// timeline, the change journal, provenance, the ledger. The transcript did
// not: spot.rs indexes transcripts for search, but nothing could hand back
// one conversation's messages, in order, with who said each. The parsing is
// stores.rs's (the one place that knows each CLI's on-disk shape); this is
// only the command around it.

use serde::Serialize;

/// Default and ceiling for how much of a transcript's end is read.
const DEFAULT_TAIL: u64 = 512 * 1024;
const MAX_TAIL: u64 = 4 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct TranscriptLine {
    pub role: String,
    pub text: String,
}

#[tauri::command]
pub async fn session_transcript_tail(
    session_id: String,
    agent: String,
    roots: Option<Vec<String>>,
    profile: Option<String>,
    max_bytes: Option<u64>,
) -> Result<Vec<TranscriptLine>, String> {
    let roots = roots.unwrap_or_default();
    let max = max_bytes.unwrap_or(DEFAULT_TAIL).clamp(1024, MAX_TAIL);
    // The store walk stats every transcript on the machine; keep it off the
    // async runtime's worker threads.
    tokio::task::spawn_blocking(move || {
        crate::stores::transcript_tail(&agent, &session_id, &roots, profile.as_deref(), max)
            .into_iter()
            .map(|(role, text)| TranscriptLine { role, text })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}
