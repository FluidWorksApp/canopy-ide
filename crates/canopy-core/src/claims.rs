/// One agent's advisory claim over a set of paths, and everything that has
/// happened to it since.
///
/// A release used to delete the row, so the two questions the user asks of a
/// claim after the fact — when did that agent let go, and what did it hold up
/// while it had it — had no answer anywhere. Ending a claim now writes its
/// ending down instead.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Claim {
    /// Identity for the detail tab. The owner cannot be it: an agent that
    /// claims, releases and claims again is two claims with one owner, and a
    /// tab opened on the first must not silently start showing the second.
    pub id: String,
    pub paths: Vec<String>,
    /// Who holds it, for a human to read — the agent's cwd plus whatever name
    /// it gave itself. Display only: it is supplied by the caller, and every
    /// agent in a shared checkout writes the same one.
    pub owner: String,
    /// Who holds it, for the rules to compare. Derived from the caller's
    /// credential (see `AgentIdentity::key`), never from the body.
    ///
    /// Splitting this from `owner` is the whole fix for the defect that made
    /// claims useless where they mattered most: the conflict test was
    /// `owner != owner`, and two agents sharing a checkout had the same owner
    /// string — so they never collided with each other, and the second one's
    /// claim silently superseded the first's.
    pub owner_key: String,
    /// The terminal behind the claim, so a claim can be swept when its agent
    /// dies and resolved to a live session without parsing a display string.
    pub pty_id: Option<u32>,
    pub instance: Option<String>,
    #[serde(default)]
    pub process_id: Option<u32>,
    #[serde(default)]
    pub process_started_at: Option<u64>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub attempt_id: Option<String>,
    pub note: Option<String>,
    pub at_ms: u64,
    /// None while it is held; this is the only thing that decides whether a
    /// claim still blocks anyone.
    pub released_at_ms: Option<u64>,
    /// How it ended: `agent` (it released), `canopy` (dropped from the UI, for
    /// an agent that died holding it) or `superseded` (the same owner claimed
    /// again). The wording is the frontend's business; this is the fact.
    pub released_by: Option<String>,
    /// Claims turned away because they overlapped this one, oldest first. The
    /// collision is the most useful thing a claim ever records — it is the
    /// moment two agents wanted the same file — and it used to exist only in a
    /// 409 body the user never saw.
    pub refusals: Vec<Refusal>,
}

/// A claim that was refused, recorded against the claim that refused it.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Refusal {
    pub owner: String,
    pub paths: Vec<String>,
    pub note: Option<String>,
    pub at_ms: u64,
    #[serde(default)]
    pub attempt_id: Option<String>,
}
