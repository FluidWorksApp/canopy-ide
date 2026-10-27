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

/// What a partial release did: how many held paths were let go, and the paths
/// still held afterwards.
#[derive(Debug, PartialEq, Eq)]
pub struct PartialRelease {
    pub dropped: usize,
    pub kept: Vec<String>,
}

/// Let go of some of an owner's paths and keep the rest — `canopy_claim
/// release` with `paths`, which used to end every claim the agent held. A
/// claim row is history, so its paths are never edited in place: the owner's
/// live claims end (`partial-release`) and one successor, `id`, carries what
/// is still held with the first claim's note and task identity. A held path
/// is let go when it is one of `release` or inside a released directory;
/// releasing a file inside a claimed directory keeps the directory, which
/// can't be split without naming every other file in it. Paths are compared
/// as given, so callers normalise both sides first. Nothing changes when none
/// of `release` is held.
pub fn release_paths(
    claims: &mut Vec<Claim>,
    owner_key: &str,
    release: &[String],
    now: u64,
    id: &str,
) -> PartialRelease {
    let held: Vec<&Claim> = claims
        .iter()
        .filter(|c| c.released_at_ms.is_none() && c.owner_key == owner_key)
        .collect();
    let freed = |p: &str| {
        let p = p.trim_end_matches('/');
        release.iter().any(|r| {
            let r = r.trim_end_matches('/');
            !r.is_empty() && (p == r || p.starts_with(&format!("{r}/")))
        })
    };
    let all: Vec<String> = held.iter().flat_map(|c| c.paths.clone()).collect();
    let kept: Vec<String> = all.iter().filter(|p| !freed(p)).cloned().collect();
    let dropped = all.len() - kept.len();
    let Some(first) = held.first() else {
        return PartialRelease { dropped, kept };
    };
    if dropped == 0 {
        return PartialRelease { dropped, kept };
    }
    let successor = Claim {
        id: id.to_string(),
        paths: kept.clone(),
        owner: first.owner.clone(),
        owner_key: owner_key.to_string(),
        pty_id: first.pty_id,
        instance: first.instance.clone(),
        process_id: first.process_id,
        process_started_at: first.process_started_at,
        run_id: first.run_id.clone(),
        attempt_id: first.attempt_id.clone(),
        note: first.note.clone(),
        at_ms: now,
        released_at_ms: None,
        released_by: None,
        refusals: Vec::new(),
    };
    for c in claims
        .iter_mut()
        .filter(|c| c.released_at_ms.is_none() && c.owner_key == owner_key)
    {
        c.released_at_ms = Some(now);
        c.released_by = Some("partial-release".into());
    }
    if !kept.is_empty() {
        claims.push(successor);
    }
    PartialRelease { dropped, kept }
}

/// The reply an agent reads after a partial release.
pub fn partial_release_message(r: &PartialRelease) -> String {
    if r.dropped == 0 {
        return format!(
            "Released 0 path(s): you don't hold a claim on those. Still holding {}.",
            r.kept.len()
        );
    }
    format!(
        "Released {} path(s); still holding {}.",
        r.dropped,
        r.kept.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(id: &str, key: &str, paths: &[&str]) -> Claim {
        Claim {
            id: id.into(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            owner: "agent".into(),
            owner_key: key.into(),
            pty_id: Some(3),
            instance: Some("i".into()),
            process_id: None,
            process_started_at: Some(1),
            run_id: Some("run".into()),
            attempt_id: None,
            note: Some("wiring".into()),
            at_ms: 1,
            released_at_ms: None,
            released_by: None,
            refusals: Vec::new(),
        }
    }

    fn live(claims: &[Claim]) -> Vec<&Claim> {
        claims
            .iter()
            .filter(|c| c.released_at_ms.is_none())
            .collect()
    }

    #[test]
    fn releasing_one_path_keeps_the_rest_held_under_a_successor() {
        let mut claims = vec![
            claim("c1", "k", &["/w/src/routes.ts", "/w/src/app.ts"]),
            claim("c9", "other", &["/w/lib"]),
        ];
        let r = release_paths(&mut claims, "k", &["/w/src/routes.ts".into()], 50, "c2");
        assert_eq!(r.dropped, 1);
        assert_eq!(r.kept, vec!["/w/src/app.ts".to_string()]);
        let held = live(&claims);
        assert_eq!(held.len(), 2);
        let mine = held.iter().find(|c| c.owner_key == "k").unwrap();
        assert_eq!(mine.id, "c2");
        assert_eq!(mine.paths, vec!["/w/src/app.ts".to_string()]);
        assert_eq!(mine.note.as_deref(), Some("wiring"));
        assert_eq!(mine.run_id.as_deref(), Some("run"));
        // The old row is history, not rewritten.
        let old = claims.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(old.paths.len(), 2);
        assert_eq!(old.released_by.as_deref(), Some("partial-release"));
        // Someone else's claim is untouched.
        assert!(claims
            .iter()
            .any(|c| c.id == "c9" && c.released_at_ms.is_none()));
    }

    #[test]
    fn releasing_a_directory_lets_go_of_what_is_inside_it() {
        let mut claims = vec![claim(
            "c1",
            "k",
            &["/w/src/a.ts", "/w/src/b/c.ts", "/w/docs/x.md"],
        )];
        let r = release_paths(&mut claims, "k", &["/w/src/".into()], 5, "c2");
        assert_eq!(r.dropped, 2);
        assert_eq!(r.kept, vec!["/w/docs/x.md".to_string()]);
    }

    #[test]
    fn releasing_everything_leaves_no_successor() {
        let mut claims = vec![claim("c1", "k", &["/w/a.ts"])];
        let r = release_paths(&mut claims, "k", &["/w/a.ts".into()], 5, "c2");
        assert_eq!(r.dropped, 1);
        assert!(live(&claims).is_empty());
    }

    #[test]
    fn releasing_a_path_not_held_changes_nothing() {
        let mut claims = vec![claim("c1", "k", &["/w/a.ts"])];
        let r = release_paths(&mut claims, "k", &["/w/b.ts".into()], 5, "c2");
        assert_eq!(r.dropped, 0);
        assert_eq!(live(&claims).len(), 1);
        assert_eq!(live(&claims)[0].id, "c1");
        assert!(partial_release_message(&r).starts_with("Released 0"));
    }
}
