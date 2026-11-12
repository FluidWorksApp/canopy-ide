//! Compact scrollback: a line that has scrolled out of the visible grid is
//! moved out of the engine into this packed form and replayed on demand.
//!
//! The engine keeps every history cell at 24 bytes whatever it holds, and its
//! ring grows in steps of 1,000 whole rows. A packed row stores the scalars as
//! one UTF-8 string, the colours and attributes as run lengths, and the rare
//! multi-scalar clusters in a side list; trailing blank cells are not stored.
//! Ordinary prose costs about 2 bytes per cell instead of 24.
//!
//! Nothing is lost that the public `Row` can show. Three engine-only facts are
//! kept in spare attribute bits so that a resize can hand rows back to the
//! engine and let it reflow them exactly as it would have: the soft-wrap mark
//! on the last cell, and the two halves of the wide-character bookkeeping.

use crate::frame::{Attrs, Cell, Color};
use crate::screen::Row;
use alacritty_terminal::term::cell::{Cell as EngineCell, Flags};
use alacritty_terminal::vte::ansi::{Color as EngineColor, NamedColor, Rgb};

/// Spare bits above the public [`Attrs`] bits (which use bits 0 to 7).
const X_LEADING_SPACER: u16 = 1 << 8;
const X_WIDE: u16 = 1 << 9;
const X_WRAP: u16 = 1 << 10;
const PUBLIC: u16 = 0xff;

/// A run of cells with the same colours and flags.
#[derive(Clone, Copy)]
struct Run {
    len: u16,
    fg: Color,
    bg: Color,
    flags: u16,
}

/// One packed line. The cell count is the number of scalars in `text`.
pub struct PackedRow {
    text: Box<str>,
    runs: Box<[Run]>,
    /// (column, full cluster text) for cells holding more than one scalar, in
    /// column order.
    clusters: Box<[(u16, Box<str>)]>,
}

/// Engine-only facts about a cell, in the spare bits.
fn extra_bits(f: Flags) -> u16 {
    let mut bits = 0;
    if f.contains(Flags::LEADING_WIDE_CHAR_SPACER) {
        bits |= X_LEADING_SPACER;
    }
    if f.contains(Flags::WIDE_CHAR) {
        bits |= X_WIDE;
    }
    if f.contains(Flags::WRAPLINE) {
        bits |= X_WRAP;
    }
    bits
}

impl PackedRow {
    /// Pack `cells`, the converted public cells of one line paired with their
    /// engine-only bits. `clusters` is the table the cells index into.
    pub fn pack(cells: &[(Cell, u16)], clusters: &mut [String]) -> PackedRow {
        let blank = |c: &Cell, x: u16| {
            c.ch == ' '
                && c.cluster == 0
                && c.fg == Color::Default
                && c.bg == Color::Default
                && c.attrs.0 == 0
                && x == 0
        };
        let used = cells
            .iter()
            .rposition(|(c, x)| !blank(c, *x))
            .map_or(0, |i| i + 1);
        let mut text = String::with_capacity(used);
        let mut runs: Vec<Run> = Vec::new();
        let mut side: Vec<(u16, Box<str>)> = Vec::new();
        for (col, (c, x)) in cells[..used].iter().enumerate() {
            text.push(c.ch);
            if c.cluster != 0 {
                let t = std::mem::take(&mut clusters[c.cluster as usize]);
                side.push((col as u16, t.into_boxed_str()));
            }
            let flags = c.attrs.0 | x;
            match runs.last_mut() {
                Some(r) if r.fg == c.fg && r.bg == c.bg && r.flags == flags => r.len += 1,
                _ => runs.push(Run {
                    len: 1,
                    fg: c.fg,
                    bg: c.bg,
                    flags,
                }),
            }
        }
        PackedRow {
            text: text.into_boxed_str(),
            runs: runs.into_boxed_slice(),
            clusters: side.into_boxed_slice(),
        }
    }

    /// Visit the first `cols` cells (blank past the stored ones): column,
    /// scalar, cluster text if any, colours, flags.
    fn each(&self, cols: usize, mut f: impl FnMut(usize, char, Option<&str>, Color, Color, u16)) {
        let mut chars = self.text.chars();
        let mut next_cluster = 0;
        let mut col = 0;
        'runs: for run in self.runs.iter() {
            for _ in 0..run.len {
                if col >= cols {
                    break 'runs;
                }
                let ch = chars.next().unwrap_or(' ');
                let cluster = match self.clusters.get(next_cluster) {
                    Some((at, t)) if *at as usize == col => {
                        next_cluster += 1;
                        Some(&**t)
                    }
                    _ => None,
                };
                f(col, ch, cluster, run.fg, run.bg, run.flags);
                col += 1;
            }
        }
        while col < cols {
            f(col, ' ', None, Color::Default, Color::Default, 0);
            col += 1;
        }
    }

    /// The public row, `cols` cells wide.
    pub fn to_row(&self, cols: usize) -> Row {
        let mut cells = Vec::with_capacity(cols);
        let mut clusters = vec![String::new()];
        self.each(cols, |_, ch, cluster, fg, bg, flags| {
            let mut idx = 0;
            if let Some(t) = cluster {
                idx = clusters.len() as u32;
                clusters.push(t.to_string());
            }
            cells.push(Cell {
                ch,
                cluster: idx,
                fg,
                bg,
                attrs: Attrs(flags & PUBLIC),
            });
        });
        Row { cells, clusters }
    }

    /// Engine cells for the first `cols` columns, to hand back to the engine.
    pub fn to_engine(&self, cols: usize) -> Vec<EngineCell> {
        let mut out = Vec::with_capacity(cols);
        self.each(cols, |_, ch, cluster, fg, bg, flags| {
            let mut cell = EngineCell {
                c: ch,
                fg: engine_color(fg, true),
                bg: engine_color(bg, false),
                flags: engine_flags(flags),
                extra: None,
            };
            if flags & Attrs::WIDE_TAIL != 0 {
                cell.c = ' ';
            }
            if let Some(t) = cluster {
                let mut scalars = t.chars();
                if let Some(first) = scalars.next() {
                    cell.c = first;
                }
                for z in scalars {
                    cell.push_zerowidth(z);
                }
            }
            out.push(cell);
        });
        out
    }
}

fn engine_color(c: Color, fg: bool) -> EngineColor {
    match c {
        Color::Default if fg => EngineColor::Named(NamedColor::Foreground),
        Color::Default => EngineColor::Named(NamedColor::Background),
        Color::Indexed(i) => EngineColor::Indexed(i),
        Color::Rgb(r, g, b) => EngineColor::Spec(Rgb { r, g, b }),
    }
}

fn engine_flags(f: u16) -> Flags {
    let mut out = Flags::empty();
    let pairs = [
        (Attrs::BOLD, Flags::BOLD),
        (Attrs::ITALIC, Flags::ITALIC),
        (Attrs::UNDERLINE, Flags::UNDERLINE),
        (Attrs::INVERSE, Flags::INVERSE),
        (Attrs::STRIKE, Flags::STRIKEOUT),
        (Attrs::DIM, Flags::DIM),
        (Attrs::HIDDEN, Flags::HIDDEN),
        (Attrs::WIDE_TAIL, Flags::WIDE_CHAR_SPACER),
        (X_LEADING_SPACER, Flags::LEADING_WIDE_CHAR_SPACER),
        (X_WIDE, Flags::WIDE_CHAR),
        (X_WRAP, Flags::WRAPLINE),
    ];
    for (bit, flag) in pairs {
        if f & bit != 0 {
            out |= flag;
        }
    }
    out
}

/// The engine-only bits of a cell, for [`PackedRow::pack`].
pub fn engine_extra(cell: &EngineCell) -> u16 {
    extra_bits(cell.flags)
}
