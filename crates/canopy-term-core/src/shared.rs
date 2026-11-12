//! Plain data and limits shared by both emulator back ends (`screen`, on
//! `alacritty_terminal`, and `ghostty`, on libghostty-vt), so a consumer sees the
//! same constants and the same [`Row`] whichever engine is behind `Screen`.

use crate::frame::{Attrs, Cell};

pub(crate) const MIN_COLS: u16 = 2;
pub(crate) const MIN_ROWS: u16 = 1;
/// Largest grid accepted; larger requests are clamped.
pub const MAX_COLS: u16 = 2000;
pub const MAX_ROWS: u16 = 1000;
/// Most scrollback lines accepted.
pub const MAX_SCROLLBACK: usize = 100_000;

/// Most scalars kept in one cell's cluster (base plus combining marks).
pub const MAX_CLUSTER_SCALARS: usize = 16;

/// Default scrollback, in lines.
pub const DEFAULT_SCROLLBACK: usize = 10_000;

/// Most replies held for the owner; the oldest are dropped past this, so a
/// screen nobody drains (a mirror replaying output) cannot grow without end.
pub const MAX_PENDING_REPLIES: usize = 1024;

/// Longest OSC body looked at, in bytes. Longer bodies are cut (titles) or
/// ignored (clipboard).
pub const MAX_OSC_BYTES: usize = 64 * 1024;
/// Longest title (OSC 0, 2 payload), in bytes.
pub const MAX_TITLE_BYTES: usize = 4096;

pub(crate) fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (
        cols.clamp(MIN_COLS, MAX_COLS),
        rows.clamp(MIN_ROWS, MAX_ROWS),
    )
}

/// One line of scrollback. `Cell::cluster` indexes `clusters` (index 0 unused).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Row {
    pub cells: Vec<Cell>,
    pub clusters: Vec<String>,
}

impl Row {
    /// The line as text, trailing blanks trimmed.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for cell in &self.cells {
            if cell.attrs.has(Attrs::WIDE_TAIL) {
                continue;
            }
            match self.clusters.get(cell.cluster as usize) {
                Some(t) if cell.cluster != 0 => out.push_str(t),
                _ => out.push(cell.ch),
            }
        }
        out.trim_end().to_string()
    }
}
