//! Write-boundary invalidations. Subscribers refetch authoritative store data.

/// A store owned by this crate. The embedding process maps each variant onto
/// its own channel, so adding one is a compile error until every embedder
/// handles it. Coalescing and wire shape belong to the embedder.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Store {
    Mesh,
    Notes,
    Research,
}

impl Store {
    pub fn as_str(self) -> &'static str {
        match self {
            Store::Mesh => "mesh",
            Store::Notes => "notes",
            Store::Research => "research",
        }
    }
}

/// What moved. Deliberately a notification and not the data: readers ask for
/// what they need, so one payload shape serves stores whose contents look
/// nothing alike, and a store nobody is showing costs one ignored event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreChange {
    pub store: Store,
    /// Which slice moved. A reader showing another slice ignores it rather
    /// than refetching.
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
