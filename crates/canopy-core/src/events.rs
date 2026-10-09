//! Write-boundary invalidations. Subscribers refetch authoritative store data.
use std::time::Duration;

/// A store whose writes a surface is displaying. Adding a variant is half of
/// adding a store to the channel; the other half is a handler in
/// `src/stores.ts`, and `notesGuard.test.ts` fails until both exist.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Store {
    Mesh,
    Notes,
    Provenance,
    Sessions,
    Tasks,
    Workflows,
}

impl Store {
    pub fn as_str(self) -> &'static str {
        match self {
            Store::Mesh => "mesh",
            Store::Notes => "notes",
            Store::Provenance => "provenance",
            Store::Sessions => "sessions",
            Store::Tasks => "tasks",
            Store::Workflows => "workflows",
        }
    }

    /// How long the writes must stay quiet before the channel speaks.
    ///
    /// This has to be longer than the cadence of whatever drives the writes or
    /// the coalescing is a no-op and every write becomes an event. Notes are
    /// written by a human typing or an agent finishing a tool call, so 60ms is
    /// far below anything a person notices and far above the gap between the
    /// meta and body writes of a single edit.
    pub fn settle(self) -> Duration {
        match self {
            // A mesh write is one send or one severed edge — there is no burst
            // shape to coalesce, and the panel animates the delivery, so the
            // event should arrive while the send still feels current.
            Store::Mesh => Duration::from_millis(60),
            Store::Notes => Duration::from_millis(60),
            // Longer, because the writes come in a different shape. A backfill
            // sweep appends one edge per matching digest as fast as it can read
            // them, and at 60ms a several-hundred-row adoption would announce
            // itself several hundred times. Nothing is watching an edge closely
            // enough to notice a quarter second.
            Store::Provenance => Duration::from_millis(250),
            // Digests are written by the hook binary in another process; the
            // pulse comes from the bridge that tails its event file, which
            // already batches on a 500ms poll. The settle only has to fold one
            // batch's worth of pulses into one event.
            Store::Sessions => Duration::from_millis(250),
            // Attempt/transcript writes arrive in short structured-event
            // bursts; one quarter-second event is enough for every open view.
            Store::Tasks => Duration::from_millis(250),
            // A step may reserve an attempt and advance in one short burst.
            Store::Workflows => Duration::from_millis(250),
        }
    }

    /// The longest the channel will stay silent while writes keep arriving.
    /// Without this a continuous writer — an agent appending in a loop — resets
    /// the settle window forever and the panel never updates, which is the bug
    /// in a more embarrassing costume.
    pub fn max_wait(self) -> Duration {
        Duration::from_millis(1000)
    }
}

/// What moved. Deliberately a notification and not the data: readers ask for
/// what they need, so one payload shape serves stores whose contents look
/// nothing alike, and a store nobody is showing costs one ignored event.
#[derive(Clone, serde::Serialize)]
pub struct StoreChange {
    pub store: &'static str,
    /// Which slice moved — the project id, for notes. A reader showing another
    /// project ignores it rather than refetching.
    pub scope: String,
    /// The item that moved, so a detail view can tell whether it was the one it
    /// is displaying. Empty when the change is not about a single item.
    pub id: String,
}

/// The embedding process chooses how invalidations reach its subscribers.
/// Implementations must enqueue promptly and must not call back into a store.
pub trait EventSink: Send + Sync {
    fn publish(&self, change: StoreChange);
}

/// Explicitly discard notifications in tests or read-only/offline consumers.
pub struct NoopEventSink;
impl EventSink for NoopEventSink {
    fn publish(&self, _change: StoreChange) {}
}
