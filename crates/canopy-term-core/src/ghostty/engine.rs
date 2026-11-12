//! The libghostty-vt side of `Screen`. Everything in this file runs on the one
//! thread that created the [`Engine`]: libghostty-vt types are `!Send` and
//! `!Sync`, and nothing here is `Send` either (it holds `Rc`s the engine's
//! callbacks write to). `mod.rs` owns the thread and ships closures to it.

use super::scan::{base64_decode, split_osc, Osc, Scanner, Step};
use super::{Event, PromptKind, PromptMark, RowMark, MAX_CLIPBOARD_BYTES, MAX_PENDING_EVENTS};
use crate::frame::{
    Attrs, Cell, Color, Cursor, CursorShape, Damage, Frame, Modes, MouseEncoding, MouseMode,
    UnderlineStyle,
};
use crate::shared::{
    clamp_size, Row, MAX_CLUSTER_SCALARS, MAX_PENDING_REPLIES, MAX_SCROLLBACK, MAX_TITLE_BYTES,
};
use libghostty_vt::fmt::{Format, Formatter, FormatterOptions};
use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RenderState, RowIterator};
use libghostty_vt::screen::{
    Cell as GCell, CellContentTag, CellWide, RowSemanticPrompt, Screen as ActiveScreen,
};
use libghostty_vt::selection::Selection;
use libghostty_vt::style::{RgbColor, Style, StyleColor, Underline};
use libghostty_vt::terminal::{
    ConformanceLevel, DeviceAttributes, DeviceType, Mode, Point, PointCoordinate,
    PrimaryDeviceAttributes, SecondaryDeviceAttributes, TertiaryDeviceAttributes,
};
use libghostty_vt::{Terminal, TerminalOptions};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::fmt::Write as _;
use std::rc::Rc;
use std::sync::Arc;

/// Pixel size reported to the engine on resize. We have no pixels; this only
/// feeds image protocols and size reports, neither of which we answer.
const CELL_PX: (u32, u32) = (8, 16);

/// Read every row every time, never copying from the last frame on the engine's
/// say-so. Its dirty tracking misses grapheme attachments (see `refresh`), so
/// skipping clean rows is not exact. The test `a_combining_mark_in_a_later_write_is_kept`
/// and the split tests are the equivalence check that must pass before this is
/// ever turned off.
const ALWAYS_READ: bool = true;

/// Longest hyperlink URI kept, in bytes. Longer links are dropped.
const MAX_URI_BYTES: usize = 2048;

/// Most OSC 8 bytes a snapshot spends on hyperlinks.
const MAX_SNAPSHOT_LINK_BYTES: usize = 8 * 1024;

/// libghostty-vt's `max_scrollback` is a size in bytes, not lines (measured in
/// the spike: a cap of 10_000 held 976 lines at 80 columns). A page costs
/// about 11 bytes per cell at 80 columns, so this budgets generously for up to
/// 160 columns (wider grids hold fewer pages' worth) and `scrollback_len`
/// enforces the line count itself. The memory is not reserved up front.
fn scrollback_bytes(lines: usize, cols: u16) -> usize {
    let per_line = cols.max(160) as usize * 12 + 256;
    lines.saturating_mul(per_line)
}

type Replies = Rc<RefCell<VecDeque<Vec<u8>>>>;

struct Grid {
    cells: Vec<Cell>,
    clusters: Vec<String>,
    links: Vec<Option<Arc<str>>>,
    marks: Vec<RowMark>,
    wraps: Vec<bool>,
    /// Rows read from the engine this time (the rest are copies of the last
    /// frame, because the engine said they did not change).
    converted: Vec<bool>,
    blinking: bool,
    visual: Option<CursorVisualStyle>,
}

pub(crate) struct Engine {
    term: Terminal<'static, 'static>,
    render: RenderState<'static>,
    row_iter: RowIterator<'static>,
    cell_iter: CellIterator<'static>,
    scan: Scanner,
    steps: Vec<(usize, Step)>,
    replies: Replies,
    events: VecDeque<Event>,
    title: Option<String>,
    cols: u16,
    rows: u16,
    scrollback_lines: usize,
    frame: Frame,
    links: Vec<Option<Arc<str>>>,
    marks: Vec<RowMark>,
    /// Row `r` ends in a soft wrap into row `r + 1`.
    wraps: Vec<bool>,
    row_seq: Vec<u64>,
    full_seq: u64,
    pen: Cell,
    blinking: bool,
    /// Kitty keyboard flags last seen on the primary and alternate screens. The
    /// engine only reads back the active screen's flags, so the other one is
    /// remembered when its flags change (`Step::KittyChanged`).
    kitty: [u8; 2],
    /// The cursor's OSC 133 state on the primary and alternate screens, as the
    /// program last set it (the engine does not expose it).
    semantic: [Semantic; 2],
    /// The OSC 8 link the program has open on the primary and alternate
    /// screens: text printed next gets it. The engine keeps it on its cursor
    /// and has no getter, so the host follows the stream.
    open_link: [Option<Arc<str>>; 2],
    /// Mouse reporting as the engine's stream handler applies it: setting
    /// 9, 1000, 1002 or 1003 selects that mode (the last one wins), resetting
    /// any of them turns reporting off; the same for the encodings. The
    /// engine's mode bits cannot say which was set last, so we follow it.
    mouse: MouseMode,
    mouse_encoding: MouseEncoding,
    clipboard_read_events: bool,
    scratch: String,
    /// Bytes were fed since the frame was last built. The frame is built only
    /// when a reader asks (`fresh`), so a run of `advance`s costs one build.
    stale: bool,
}

fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{what}: {e}")
}

fn color_of(c: StyleColor) -> Color {
    match c {
        StyleColor::Palette(p) => Color::Indexed(p.0),
        StyleColor::Rgb(c) => Color::Rgb(c.r, c.g, c.b),
        _ => Color::Default,
    }
}

fn underline_of(s: &Style) -> UnderlineStyle {
    match s.underline {
        Underline::None => UnderlineStyle::None,
        Underline::Double => UnderlineStyle::Double,
        Underline::Curly => UnderlineStyle::Curly,
        Underline::Dotted => UnderlineStyle::Dotted,
        Underline::Dashed => UnderlineStyle::Dashed,
        // `Single`, and any style a later engine adds: a plain line.
        _ => UnderlineStyle::Single,
    }
}

fn attrs_of(s: &Style) -> u16 {
    let mut a = 0u16;
    if s.bold {
        a |= Attrs::BOLD;
    }
    if s.italic {
        a |= Attrs::ITALIC;
    }
    if s.underline != Underline::None {
        a |= Attrs::UNDERLINE;
    }
    if s.inverse {
        a |= Attrs::INVERSE;
    }
    if s.strikethrough {
        a |= Attrs::STRIKE;
    }
    if s.faint {
        a |= Attrs::DIM;
    }
    if s.invisible {
        a |= Attrs::HIDDEN;
    }
    a
}

/// One engine cell as a frame cell. `text` is the cell's grapheme (empty for a
/// blank). A cell that only carries a background colour has that colour in its
/// content, not in its style.
fn make_cell(style: &Style, raw: GCell, text: &str, clusters: &mut Vec<String>) -> Cell {
    let fg = color_of(style.fg_color);
    let mut bg = color_of(style.bg_color);
    match raw.content_tag() {
        Ok(CellContentTag::BgColorPalette) => {
            if let Ok(p) = raw.bg_color_palette() {
                bg = Color::Indexed(p.0);
            }
        }
        Ok(CellContentTag::BgColorRgb) => {
            if let Ok(c) = raw.bg_color_rgb() {
                bg = Color::Rgb(c.r, c.g, c.b);
            }
        }
        _ => {}
    }
    let attrs = attrs_of(style);
    let underline = underline_of(style);
    // Kept even without an underline: the engine keeps it on the pen, and a
    // later `SGR 4` shows it.
    let underline_color = color_of(style.underline_color);
    let wide = raw.wide();
    if matches!(wide, Ok(CellWide::SpacerTail)) {
        return Cell {
            ch: '\0',
            cluster: 0,
            fg,
            bg,
            attrs: Attrs(attrs | Attrs::WIDE_TAIL),
            underline,
            underline_color,
        };
    }
    // A spacer head is a blank at the end of a row where a wide character did
    // not fit.
    let text = if matches!(wide, Ok(CellWide::SpacerHead)) {
        ""
    } else {
        text
    };
    let mut chars = text.chars();
    let ch = match chars.next() {
        Some(c) if !c.is_control() => c,
        _ => ' ',
    };
    let mut cluster = 0u32;
    if text.chars().nth(1).is_some() && ch != ' ' {
        let s: String = text.chars().take(MAX_CLUSTER_SCALARS).collect();
        cluster = clusters.len() as u32;
        clusters.push(s);
    }
    Cell {
        ch,
        cluster,
        fg,
        bg,
        attrs: Attrs(attrs),
        underline,
        underline_color,
    }
}

fn cell_text<'a>(clusters: &'a [String], cell: &Cell, buf: &'a mut String) -> &'a str {
    match clusters.get(cell.cluster as usize) {
        Some(t) if cell.cluster != 0 => t,
        _ => {
            buf.clear();
            buf.push(cell.ch);
            buf
        }
    }
}

/// Rows are equal when every cell and link matches, comparing clusters by text
/// rather than by table index (indices shift when an earlier row changes).
fn rows_equal(
    old: &Frame,
    old_links: &[Option<Arc<str>>],
    cells: &[Cell],
    clusters: &[String],
    links: &[Option<Arc<str>>],
    row: usize,
) -> bool {
    let cols = old.cols as usize;
    let range = row * cols..(row + 1) * cols;
    if old_links.get(range.clone()) != links.get(range.clone()) {
        return false;
    }
    let (ac, bc) = (&old.cells[range.clone()], &cells[range]);
    for (x, y) in ac.iter().zip(bc) {
        if x.fg != y.fg
            || x.bg != y.bg
            || x.attrs != y.attrs
            || x.ch != y.ch
            || x.underline != y.underline
            || x.underline_color != y.underline_color
        {
            return false;
        }
        if (x.cluster == 0) != (y.cluster == 0) {
            return false;
        }
        if x.cluster != 0 {
            let (mut s1, mut s2) = (String::new(), String::new());
            if cell_text(&old.clusters, x, &mut s1) != cell_text(clusters, y, &mut s2) {
                return false;
            }
        }
    }
    true
}

/// What a cell is drawn with, apart from its text: the key that decides when a
/// snapshot must write a new SGR.
type PenKey = (Color, Color, Attrs, UnderlineStyle, Color);

fn pen_key(c: &Cell) -> PenKey {
    (
        c.fg,
        c.bg,
        Attrs(c.attrs.0 & !Attrs::WIDE_TAIL),
        c.underline,
        c.underline_color,
    )
}

/// One SGR that sets exactly this pen, from a reset. The underline shape is
/// `4:n` (colon sub-parameter) and its colour is `58`.
fn write_sgr(out: &mut String, key: PenKey) {
    let (fg, bg, attrs, underline, underline_color) = key;
    out.push_str("\x1b[0");
    for (flag, code) in [
        (Attrs::BOLD, 1),
        (Attrs::DIM, 2),
        (Attrs::ITALIC, 3),
        (Attrs::INVERSE, 7),
        (Attrs::HIDDEN, 8),
        (Attrs::STRIKE, 9),
    ] {
        if attrs.has(flag) {
            let _ = write!(out, ";{code}");
        }
    }
    match underline {
        UnderlineStyle::None => {
            if attrs.has(Attrs::UNDERLINE) {
                out.push_str(";4");
            }
        }
        UnderlineStyle::Single => out.push_str(";4"),
        UnderlineStyle::Double => out.push_str(";4:2"),
        UnderlineStyle::Curly => out.push_str(";4:3"),
        UnderlineStyle::Dotted => out.push_str(";4:4"),
        UnderlineStyle::Dashed => out.push_str(";4:5"),
    }
    for (base, color) in [(38, fg), (48, bg), (58, underline_color)] {
        match color {
            Color::Default => {}
            Color::Indexed(i) => {
                let _ = write!(out, ";{base};5;{i}");
            }
            Color::Rgb(r, g, b) => {
                let _ = write!(out, ";{base};2;{r};{g};{b}");
            }
        }
    }
    out.push('m');
}

/// What the engine's VT formatter says about state the terminal has no getter
/// for. Parsed out of its output; see [`parse_extras`].
#[derive(Debug, Default, PartialEq, Eq)]
struct Extras {
    /// Scroll region, zero-based `start..end`; `None` for the whole screen.
    region: Option<(u16, u16)>,
    /// Zero-based columns with a tab stop; `None` when the formatter said
    /// nothing (then the stops are left at their defaults).
    tabs: Option<Vec<u16>>,
    /// Character set designations and shifts, as the escape sequences that
    /// restore them (empty when every set is the default).
    charsets: Vec<u8>,
}

/// Reads what the formatter wrote for one cell with scrolling region, tab stops
/// and character sets switched on. The cell's own text and style come first and
/// are skipped over: the designations are two escape bytes and a letter, which
/// nothing a cell can hold looks like, and the tab stops follow the last
/// `CSI 3 g`.
fn parse_extras(bytes: &[u8]) -> Extras {
    let mut out = Extras {
        region: parse_decstbm(bytes),
        ..Extras::default()
    };

    const TBC: &[u8] = b"\x1b[3g";
    if let Some(at) = bytes.windows(TBC.len()).rposition(|w| w == TBC) {
        let mut tabs = Vec::new();
        let mut i = at + TBC.len();
        // `CSI n G` then `ESC H`, once per stop.
        while i + 1 < bytes.len() && bytes[i] == 0x1b && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            let mut n: u32 = 0;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                n = n
                    .saturating_mul(10)
                    .saturating_add((bytes[j] - b'0') as u32);
                j += 1;
            }
            if j + 2 < bytes.len()
                && bytes[j] == b'G'
                && bytes[j + 1] == 0x1b
                && bytes[j + 2] == b'H'
                && n >= 1
            {
                tabs.push((n - 1).min(u16::MAX as u32) as u16);
                i = j + 3;
            } else {
                break;
            }
        }
        out.tabs = Some(tabs);
    }

    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() {
            match bytes[i + 1] {
                b'(' | b')' | b'*' | b'+' if i + 2 < bytes.len() => {
                    if matches!(bytes[i + 2], b'B' | b'A' | b'0') {
                        out.charsets.extend_from_slice(&bytes[i..i + 3]);
                        i += 3;
                        continue;
                    }
                }
                b'n' | b'o' | b'~' | b'|' => {
                    out.charsets.extend_from_slice(&bytes[i..i + 2]);
                    i += 2;
                    continue;
                }
                _ => {}
            }
        } else if bytes[i] == 0x0e {
            out.charsets.push(0x0e);
        }
        i += 1;
    }
    out
}

/// Where the cursor's semantic state (OSC 133) stands, as the program last set
/// it. The engine keeps it on its cursor and has no getter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Semantic {
    /// Program output (the default), or a command that has finished.
    Output,
    /// Inside a prompt (`A`, `N`, `P`); `cont` for a continuation line.
    Prompt { cont: bool },
    /// Typing a command (`B`, or `I` which ends at the end of the line).
    Input { eol: bool },
}

/// The semantic state OSC 133's body (`A`, `B;...`, `P;k=s`) puts the cursor
/// in, or `None` when the body does not change it (`L`, anything invalid).
fn semantic_of(body: &[u8]) -> Option<Semantic> {
    let first = *body.first()?;
    if body.len() > 1 && body[1] != b';' {
        return None;
    }
    match first {
        b'A' | b'N' | b'P' => {
            let cont = body
                .split(|&b| b == b';')
                .skip(1)
                .find_map(|o| o.strip_prefix(b"k="))
                .is_some_and(|k| matches!(k, b"c" | b"s"));
            Some(Semantic::Prompt { cont })
        }
        b'B' => Some(Semantic::Input { eol: false }),
        b'I' => Some(Semantic::Input { eol: true }),
        b'C' | b'D' => Some(Semantic::Output),
        _ => None,
    }
}

/// The OSC 133 that marks the cursor's row as a prompt row without moving
/// anything and then returns the cursor to plain output, so text printed next
/// is not taken for a prompt.
fn write_row_mark(out: &mut String, mark: RowMark) {
    match mark {
        RowMark::None => {}
        RowMark::Prompt => out.push_str("\x1b]133;P;k=i\x1b\\\x1b]133;D\x1b\\"),
        RowMark::PromptContinuation => out.push_str("\x1b]133;P;k=s\x1b\\\x1b]133;D\x1b\\"),
    }
}

/// The first `CSI Pt ; Pb r` (DECSTBM) in `bytes`, as zero-based `start..end`.
fn parse_decstbm(bytes: &[u8]) -> Option<(u16, u16)> {
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == 0x1b && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b';') {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'r' && j > i + 2 {
                let params = std::str::from_utf8(&bytes[i + 2..j]).ok()?;
                let mut it = params.split(';');
                let top: u16 = it.next()?.parse().ok()?;
                let bottom: u16 = it.next()?.parse().ok()?;
                if top >= 1 && bottom > top {
                    return Some((top - 1, bottom));
                }
                return None;
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

fn clean_uri(raw: &[u8]) -> Option<Arc<str>> {
    if raw.is_empty() || raw.len() > MAX_URI_BYTES {
        return None;
    }
    let s = String::from_utf8_lossy(raw);
    if s.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(Arc::from(s.as_ref()))
}

fn link_at(term: &Terminal<'static, 'static>, x: u16, y: u32) -> Option<Arc<str>> {
    let gr = term
        .grid_ref(Point::Viewport(PointCoordinate { x, y }))
        .ok()?;
    let mut buf = [0u8; MAX_URI_BYTES];
    let n = gr.hyperlink_uri(&mut buf).ok()?;
    clean_uri(buf.get(..n)?)
}

/// What the engine says changed, turned into plain data. A free function so
/// the borrow checker sees the engine's fields as separate borrows.
#[allow(clippy::too_many_arguments)]
fn read_grid(
    render: &mut RenderState<'static>,
    term: &Terminal<'static, 'static>,
    row_iter: &mut RowIterator<'static>,
    cell_iter: &mut CellIterator<'static>,
    prev: Option<(&Frame, &[Option<Arc<str>>])>,
    cols: usize,
    rows: usize,
    force_full: bool,
    scratch: &mut String,
) -> Option<Grid> {
    let snap = render.update(term).ok()?;
    let dirty = snap.dirty().unwrap_or(Dirty::Full);
    // Only a wholly clean engine lets rows be copied from the last frame. A
    // partly dirty one is read in full: its per-row dirty bits are reset below
    // but not yet trusted to skip rows (a scroll moves rows whose bits are
    // clear), and damage is found by comparing rows either way.
    let full = ALWAYS_READ || force_full || prev.is_none() || dirty != Dirty::Clean;
    let mut g = Grid {
        cells: Vec::with_capacity(cols * rows),
        clusters: vec![String::new()],
        links: Vec::with_capacity(cols * rows),
        marks: Vec::with_capacity(rows),
        wraps: Vec::with_capacity(rows),
        converted: Vec::with_capacity(rows),
        blinking: snap.cursor_blinking().unwrap_or(false),
        visual: snap.cursor_visual_style().ok(),
    };
    {
        let mut rows_it = row_iter.update(&snap).ok()?;
        let mut r = 0usize;
        while let Some(row) = rows_it.next() {
            if r >= rows {
                break;
            }
            let raw_row = row.raw_row().ok();
            g.wraps
                .push(raw_row.and_then(|x| x.is_wrapped().ok()).unwrap_or(false));
            g.marks
                .push(match raw_row.and_then(|x| x.semantic_prompt().ok()) {
                    Some(RowSemanticPrompt::Prompt) => RowMark::Prompt,
                    Some(RowSemanticPrompt::Continuation) => RowMark::PromptContinuation,
                    _ => RowMark::None,
                });
            match prev {
                Some((frame, links)) if !full => {
                    for c in 0..cols {
                        let i = r * cols + c;
                        let mut cell = frame.cells.get(i).copied().unwrap_or_default();
                        if cell.cluster != 0 {
                            let text = frame
                                .clusters
                                .get(cell.cluster as usize)
                                .cloned()
                                .unwrap_or_default();
                            cell.cluster = g.clusters.len() as u32;
                            g.clusters.push(text);
                        }
                        g.cells.push(cell);
                        g.links.push(links.get(i).cloned().flatten());
                    }
                    g.converted.push(false);
                }
                _ => {
                    let mut c = 0usize;
                    if let Ok(mut cells) = cell_iter.update(&row) {
                        while let Some(cell) = cells.next() {
                            if c >= cols {
                                break;
                            }
                            let style = cell.style().unwrap_or_default();
                            scratch.clear();
                            let _ = cell.graphemes_utf8(scratch);
                            let (made, link) = match cell.raw_cell() {
                                Ok(raw) => {
                                    let link = if raw.has_hyperlink().unwrap_or(false) {
                                        link_at(term, c as u16, r as u32)
                                    } else {
                                        None
                                    };
                                    (make_cell(&style, raw, scratch, &mut g.clusters), link)
                                }
                                Err(_) => (Cell::default(), None),
                            };
                            g.cells.push(made);
                            g.links.push(link);
                            c += 1;
                        }
                    }
                    while c < cols {
                        g.cells.push(Cell::default());
                        g.links.push(None);
                        c += 1;
                    }
                    g.converted.push(true);
                }
            }
            let _ = row.set_dirty(false);
            r += 1;
        }
        while r < rows {
            for _ in 0..cols {
                g.cells.push(Cell::default());
                g.links.push(None);
            }
            g.marks.push(RowMark::None);
            g.wraps.push(false);
            g.converted.push(true);
            r += 1;
        }
    }
    let _ = snap.set_dirty(Dirty::Clean);
    Some(g)
}

impl Engine {
    pub(crate) fn new(cols: u16, rows: u16, scrollback: usize) -> Result<Engine, String> {
        let (cols, rows) = clamp_size(cols, rows);
        let lines = scrollback.min(MAX_SCROLLBACK);
        let mut term = Terminal::new(TerminalOptions {
            cols,
            rows,
            max_scrollback: scrollback_bytes(lines, cols),
        })
        .map_err(err("terminal"))?;
        let replies: Replies = Rc::new(RefCell::new(VecDeque::new()));
        {
            let q = replies.clone();
            term.on_pty_write(move |_term, data| {
                push_reply(&q, data.to_vec());
            })
            .map_err(err("pty write effect"))?
            .on_device_attributes(|_term| {
                Some(DeviceAttributes {
                    // `CSI ? 6 c`: a VT102, what the previous engine answered.
                    primary: PrimaryDeviceAttributes::new(ConformanceLevel(6), &[]),
                    secondary: SecondaryDeviceAttributes {
                        device_type: DeviceType(1),
                        firmware_version: 0,
                        rom_cartridge: 0,
                    },
                    tertiary: TertiaryDeviceAttributes { unit_id: 0 },
                })
            })
            .map_err(err("device attributes effect"))?;
        }
        let mut e = Engine {
            term,
            render: RenderState::new().map_err(err("render state"))?,
            row_iter: RowIterator::new().map_err(err("row iterator"))?,
            cell_iter: CellIterator::new().map_err(err("cell iterator"))?,
            scan: Scanner::new(),
            steps: Vec::new(),
            replies,
            events: VecDeque::new(),
            title: None,
            cols,
            rows,
            scrollback_lines: lines,
            frame: Frame::blank(cols, rows),
            links: vec![None; cols as usize * rows as usize],
            marks: vec![RowMark::None; rows as usize],
            wraps: vec![false; rows as usize],
            row_seq: vec![1; rows as usize],
            full_seq: 1,
            pen: Cell::default(),
            blinking: false,
            kitty: [0; 2],
            semantic: [Semantic::Output; 2],
            open_link: [None, None],
            mouse: MouseMode::Off,
            mouse_encoding: MouseEncoding::Default,
            clipboard_read_events: false,
            scratch: String::new(),
            stale: false,
        };
        e.frame.seq = 1;
        e.refresh(true);
        Ok(e)
    }

    pub(crate) fn set_clipboard_read_events(&mut self, on: bool) {
        self.clipboard_read_events = on;
    }

    fn on_alt(&self) -> bool {
        matches!(self.term.active_screen(), Ok(ActiveScreen::Alternate))
    }

    fn push_event(&mut self, e: Event) {
        if self.events.len() >= MAX_PENDING_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(e);
    }

    /// Feed bytes without rebuilding the frame.
    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.stale = true;
        let mut steps = std::mem::take(&mut self.steps);
        steps.clear();
        self.scan.feed(bytes, &mut steps);
        let mut start = 0;
        for (at, step) in steps.drain(..) {
            if at > start {
                self.term.vt_write(&bytes[start..at]);
                start = at;
            }
            self.step(step);
        }
        if start < bytes.len() {
            self.term.vt_write(&bytes[start..]);
        }
        self.steps = steps;
    }

    /// Rebuild the frame if bytes were fed since it was built. Every reader of
    /// frame-derived state calls this first, so it sees every earlier feed.
    fn fresh(&mut self) {
        if self.stale {
            self.stale = false;
            self.refresh(false);
        }
    }

    fn step(&mut self, step: Step) {
        match step {
            Step::Reset => {
                self.title = None;
                self.kitty = [0; 2];
                self.semantic = [Semantic::Output; 2];
                self.open_link = [None, None];
                self.mouse = MouseMode::Off;
                self.mouse_encoding = MouseEncoding::Default;
            }
            Step::PrivateMode { set, params } => {
                for p in params {
                    match (p, set) {
                        (9, true) => self.mouse = MouseMode::Press,
                        (1000, true) => self.mouse = MouseMode::Normal,
                        (1002, true) => self.mouse = MouseMode::Drag,
                        (1003, true) => self.mouse = MouseMode::Any,
                        (9 | 1000 | 1002 | 1003, false) => self.mouse = MouseMode::Off,
                        (1005, true) => self.mouse_encoding = MouseEncoding::Utf8,
                        (1006, true) => self.mouse_encoding = MouseEncoding::Sgr,
                        // URXVT and SGR-pixels have no variant of ours.
                        (1015 | 1016, true) => self.mouse_encoding = MouseEncoding::Default,
                        (1005 | 1006 | 1015 | 1016, false) => {
                            self.mouse_encoding = MouseEncoding::Default
                        }
                        _ => {}
                    }
                }
            }
            Step::Bell => self.push_event(Event::Bell),
            Step::KittyChanged => {
                let flags = self
                    .term
                    .kitty_keyboard_flags()
                    .map(|f| f.bits())
                    .unwrap_or(0);
                let screen = self.on_alt() as usize;
                self.kitty[screen] = flags;
            }
            Step::Osc(osc) => self.osc(osc),
        }
    }

    fn reply(&mut self, bytes: Vec<u8>) {
        push_reply(&self.replies, bytes);
    }

    fn osc(&mut self, osc: Osc) {
        let Some((num, rest)) = split_osc(&osc.body) else {
            return;
        };
        match num {
            0 | 2 => {
                let text = String::from_utf8_lossy(rest);
                let mut title = String::new();
                for c in text.chars().filter(|c| !c.is_control()) {
                    if title.len() + c.len_utf8() > MAX_TITLE_BYTES {
                        break;
                    }
                    title.push(c);
                }
                self.title = if title.is_empty() { None } else { Some(title) };
            }
            8 => {
                // `OSC 8 ; params ; uri`: an empty uri closes the link.
                let uri = rest.splitn(2, |&b| b == b';').nth(1).unwrap_or(&[]);
                let link = if osc.overflow { None } else { clean_uri(uri) };
                let screen = self.on_alt() as usize;
                self.open_link[screen] = link;
            }
            // OSC 4, 10, 11, 12 queries are answered by the engine itself (CI
            // showed a second reply when we answered too), mirroring the
            // terminator, from the colours the program set or the defaults
            // from `set_reply_colors`.
            52 => self.osc52(&osc, rest),
            133 => {
                if let Some(state) = semantic_of(rest) {
                    let screen = self.on_alt() as usize;
                    self.semantic[screen] = state;
                }
                let mut parts = rest.split(|&b| b == b';');
                let kind = match parts.next().and_then(|p| p.first()) {
                    Some(b'A') => PromptKind::PromptStart,
                    Some(b'B') => PromptKind::PromptEnd,
                    Some(b'C') => PromptKind::OutputStart,
                    Some(b'D') => PromptKind::CommandEnd,
                    _ => return,
                };
                let exit_code = if kind == PromptKind::CommandEnd {
                    parts
                        .next()
                        .and_then(|p| std::str::from_utf8(p).ok())
                        .and_then(|p| p.parse::<i32>().ok())
                } else {
                    None
                };
                let row = self.term.cursor_y().unwrap_or(0);
                self.push_event(Event::PromptMark(PromptMark {
                    kind,
                    exit_code,
                    row,
                }));
            }
            _ => {}
        }
    }

    /// OSC 52. The core never touches a clipboard: a write becomes an event
    /// the host may act on, a read request is dropped unless the host asked to
    /// see them, and even then it is only an event (the core never answers
    /// with clipboard contents).
    fn osc52(&mut self, osc: &Osc, rest: &[u8]) {
        let mut parts = rest.splitn(2, |&b| b == b';');
        let (Some(sel), Some(data)) = (parts.next(), parts.next()) else {
            return;
        };
        let mut selection: String = String::from_utf8_lossy(sel)
            .chars()
            .filter(|c| "cpqs01234567".contains(*c))
            .take(8)
            .collect();
        if selection.is_empty() {
            selection.push_str("s0");
        }
        if data == b"?" {
            if self.clipboard_read_events {
                self.push_event(Event::ClipboardReadRequest { selection });
            }
            return;
        }
        if osc.overflow {
            return;
        }
        let Some(bytes) = base64_decode(data) else {
            return;
        };
        if bytes.len() > MAX_CLIPBOARD_BYTES {
            return;
        }
        self.push_event(Event::ClipboardWrite {
            selection,
            data: bytes,
        });
    }

    pub(crate) fn take_replies(&mut self) -> Vec<u8> {
        let pending = std::mem::take(&mut *self.replies.borrow_mut());
        let mut out = Vec::new();
        for r in pending {
            out.extend_from_slice(&r);
        }
        out
    }

    pub(crate) fn take_events(&mut self) -> Vec<Event> {
        self.events.drain(..).collect()
    }

    /// Drop replies and events nobody asked for (used after a restore).
    pub(crate) fn discard_pending(&mut self) {
        self.replies.borrow_mut().clear();
        self.events.clear();
    }

    pub(crate) fn set_reply_colors(
        &mut self,
        fg: Option<(u8, u8, u8)>,
        bg: Option<(u8, u8, u8)>,
        cursor: Option<(u8, u8, u8)>,
    ) {
        let c = |v: Option<(u8, u8, u8)>| v.map(|(r, g, b)| RgbColor { r, g, b });
        let _ = self.term.set_default_fg_color(c(fg));
        let _ = self.term.set_default_bg_color(c(bg));
        let _ = self.term.set_default_cursor_color(c(cursor));
    }

    pub(crate) fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = clamp_size(cols, rows);
        if (cols, rows) == (self.cols, self.rows) {
            return;
        }
        let _ = self.term.resize(cols, rows, CELL_PX.0, CELL_PX.1);
        self.cols = cols;
        self.rows = rows;
        self.stale = false;
        self.refresh(true);
    }

    pub(crate) fn frame(&mut self) -> Frame {
        self.fresh();
        self.frame.clone()
    }

    pub(crate) fn seq(&mut self) -> u64 {
        self.fresh();
        self.frame.seq
    }

    pub(crate) fn cursor_blinking(&mut self) -> bool {
        self.fresh();
        self.blinking
    }

    pub(crate) fn damage_since(&mut self, since: u64) -> Damage {
        self.fresh();
        if since == 0 || since > self.frame.seq || since < self.full_seq {
            return Damage {
                since,
                full: true,
                rows: Vec::new(),
            };
        }
        let mut rows: Vec<(u16, u16)> = Vec::new();
        for (r, &s) in self.row_seq.iter().enumerate() {
            if s > since {
                let r = r as u16;
                match rows.last_mut() {
                    Some(last) if last.1 + 1 == r => last.1 = r,
                    _ => rows.push((r, r)),
                }
            }
        }
        Damage {
            since,
            full: false,
            rows,
        }
    }

    pub(crate) fn hyperlink_at(&mut self, row: u16, col: u16) -> Option<String> {
        self.fresh();
        if row >= self.rows || col >= self.cols {
            return None;
        }
        self.links
            .get(row as usize * self.cols as usize + col as usize)
            .cloned()
            .flatten()
            .map(|s| s.to_string())
    }

    pub(crate) fn row_mark(&mut self, row: u16) -> RowMark {
        self.fresh();
        self.marks.get(row as usize).copied().unwrap_or_default()
    }

    pub(crate) fn scrollback_len(&self) -> usize {
        self.term
            .scrollback_rows()
            .unwrap_or(0)
            .min(self.scrollback_lines)
    }

    pub(crate) fn scrollback_row(&self, index: usize) -> Option<Row> {
        let total = self.term.scrollback_rows().ok()?;
        let len = total.min(self.scrollback_lines);
        if index >= len {
            return None;
        }
        let y = (total - len + index) as u32;
        let mut clusters = vec![String::new()];
        let mut cells = Vec::with_capacity(self.cols as usize);
        let mut buf = ['\0'; 64];
        for x in 0..self.cols {
            let cell = match self
                .term
                .grid_ref(Point::History(PointCoordinate { x, y }))
                .ok()
                .and_then(|gr| {
                    let raw = gr.cell().ok()?;
                    let style = gr.style().unwrap_or_default();
                    let n = gr.graphemes(&mut buf).unwrap_or(0);
                    let text: String = buf[..n.min(buf.len())].iter().collect();
                    Some(make_cell(&style, raw, &text, &mut clusters))
                }) {
                Some(c) => c,
                None => Cell::default(),
            };
            cells.push(cell);
        }
        Some(Row { cells, clusters })
    }

    fn refresh(&mut self, force_full: bool) {
        let (cols, rows) = (self.cols as usize, self.rows as usize);
        let alt_screen = self.on_alt();
        let size_changed = self.frame.cols != self.cols || self.frame.rows != self.rows;
        let alt_changed = self.frame.alt_screen != alt_screen;
        let full = force_full || size_changed || alt_changed;
        // A fresh render state every time, so every row is copied from the
        // terminal. The engine's dirty tracking is not reliable: attaching a
        // combining mark to the previous cell does not mark its row dirty, so
        // a render state that keeps rows between updates shows the base
        // character without its mark when the mark arrives in a later write.
        if let Ok(fresh) = RenderState::new() {
            self.render = fresh;
        }
        let prev = if full {
            None
        } else {
            Some((&self.frame, self.links.as_slice()))
        };
        let Some(g) = read_grid(
            &mut self.render,
            &self.term,
            &mut self.row_iter,
            &mut self.cell_iter,
            prev,
            cols,
            rows,
            full,
            &mut self.scratch,
        ) else {
            return;
        };

        let term = &self.term;
        let on = |m: Mode| term.mode(m).unwrap_or(false);
        let modes = Modes {
            mouse: self.mouse,
            mouse_encoding: self.mouse_encoding,
            bracketed_paste: on(Mode::BRACKETED_PASTE),
            app_cursor_keys: on(Mode::DECCKM),
            app_keypad: on(Mode::KEYPAD_KEYS),
            focus_events: on(Mode::FOCUS_EVENT),
            sync_output: on(Mode::SYNC_OUTPUT),
            kitty_keyboard: term.kitty_keyboard_flags().map(|f| f.bits()).unwrap_or(0),
        };
        let cursor = Cursor {
            row: term.cursor_y().unwrap_or(0).min(self.rows - 1),
            col: term.cursor_x().unwrap_or(0).min(self.cols - 1),
            shape: match g.visual {
                Some(CursorVisualStyle::Underline) => CursorShape::Underline,
                Some(CursorVisualStyle::Bar) => CursorShape::Bar,
                _ => CursorShape::Block,
            },
            visible: term.is_cursor_visible().unwrap_or(true),
        };
        let pen = match term.cursor_style() {
            Ok(style) => {
                let underline = underline_of(&style);
                Cell {
                    ch: ' ',
                    cluster: 0,
                    fg: color_of(style.fg_color),
                    bg: color_of(style.bg_color),
                    attrs: Attrs(attrs_of(&style)),
                    underline,
                    underline_color: color_of(style.underline_color),
                }
            }
            Err(_) => Cell::default(),
        };
        self.kitty[alt_screen as usize] = modes.kitty_keyboard;
        let title = self.title.clone();
        self.pen = pen;
        self.blinking = g.blinking;
        self.marks = g.marks;
        self.wraps = g.wraps;

        let old = &self.frame;
        let mut changed: Vec<usize> = Vec::new();
        if !full {
            for r in 0..rows {
                if g.converted[r]
                    && !rows_equal(old, &self.links, &g.cells, &g.clusters, &g.links, r)
                {
                    changed.push(r);
                }
            }
        }
        let cursor_changed = old.cursor != cursor;
        let meta_changed = cursor_changed || old.modes != modes || old.title != title;
        if !(full || meta_changed || !changed.is_empty()) {
            return;
        }
        let seq = old.seq + 1;
        let old_cursor_row = old.cursor.row as usize;
        if full {
            self.full_seq = seq;
            self.row_seq = vec![seq; rows];
        } else {
            for r in changed {
                self.row_seq[r] = seq;
            }
            if cursor_changed {
                for r in [old_cursor_row, cursor.row as usize] {
                    if let Some(s) = self.row_seq.get_mut(r) {
                        *s = seq;
                    }
                }
            }
        }
        self.links = g.links;
        self.frame = Frame {
            seq,
            cols: self.cols,
            rows: self.rows,
            cells: g.cells,
            clusters: g.clusters,
            cursor,
            modes,
            damage: Damage {
                since: 0,
                full: true,
                rows: Vec::new(),
            },
            alt_screen,
            title,
        };
    }

    /// Scroll region, tab stops and character sets, as the engine's own VT
    /// formatter writes them (the terminal has no getter for any of them). The
    /// formatter is asked about one cell so the output is those extras and a
    /// single character, which [`parse_extras`] skips.
    fn extras(&self) -> Extras {
        let at = Point::Active(PointCoordinate { x: 0, y: 0 });
        let (Ok(a), Ok(b)) = (self.term.grid_ref(at), self.term.grid_ref(at)) else {
            return Extras::default();
        };
        let sel = Selection::new(a, b, false);
        let opts = FormatterOptions::new()
            .with_format(Format::Vt)
            .with_scrolling_region(true)
            .with_tabstops(true)
            .with_charsets(true)
            .with_selection(&sel);
        let Ok(mut fmt) = Formatter::new(&self.term, opts) else {
            return Extras::default();
        };
        let Ok(n) = fmt.format_len() else {
            return Extras::default();
        };
        let mut buf = vec![0u8; n];
        match fmt.format_buf(&mut buf) {
            Ok(got) => parse_extras(buf.get(..got).unwrap_or(&[])),
            Err(_) => Extras::default(),
        }
    }

    /// OSC 4, 10, 11 and 12 for what the program changed: palette entries that
    /// differ from the default palette, and foreground, background and cursor
    /// colours that differ from their defaults.
    fn write_colors(&self, out: &mut String) {
        if let (Ok(now), Ok(default)) =
            (self.term.color_palette(), self.term.default_color_palette())
        {
            for (i, (c, d)) in now.0.iter().zip(default.0.iter()).enumerate() {
                if c != d {
                    let _ = write!(
                        out,
                        "\x1b]4;{i};rgb:{:02x}/{:02x}/{:02x}\x1b\\",
                        c.r, c.g, c.b
                    );
                }
            }
        }
        let t = &self.term;
        for (osc, now, default) in [
            (10, t.fg_color(), t.default_fg_color()),
            (11, t.bg_color(), t.default_bg_color()),
            (12, t.cursor_color(), t.default_cursor_color()),
        ] {
            if let Ok(Some(c)) = now {
                if default.ok().flatten() != Some(c) {
                    let _ = write!(
                        out,
                        "\x1b]{osc};rgb:{:02x}/{:02x}/{:02x}\x1b\\",
                        c.r, c.g, c.b
                    );
                }
            }
        }
    }

    /// Escape sequences that bring a fresh `Screen` of the same size to this
    /// screen's visible grid, cursor, pen, title and modes, plus what the grid
    /// does not show but later output depends on: tab stops, character sets and
    /// shift state, palette and colour overrides, underline styles and colours,
    /// hyperlinks, prompt row marks and the cursor's prompt state. Scrollback is
    /// not carried, nor is the primary screen behind an active alternate screen.
    /// Built from our own frame (plus the engine's soft-wrap flags, and its VT
    /// formatter for the scroll region, tab stops and character sets) rather
    /// than the engine's formatter alone, which has no notion of the visible
    /// area only, and drops soft wraps.
    pub(crate) fn snapshot(&mut self) -> Vec<u8> {
        self.fresh();
        let extras = self.extras();
        let f = &self.frame;
        let mut out = String::new();
        let kitty = |out: &mut String, flags: u8| {
            if flags != 0 {
                let _ = write!(out, "\x1b[>{flags}u");
            }
        };
        out.push_str("\x1bc");
        self.write_colors(&mut out);
        if f.alt_screen {
            kitty(&mut out, self.kitty[0]);
            out.push_str("\x1b[?1049h");
        }

        let (cols, rows) = (f.cols as usize, f.rows as usize);
        let wrapped = |r: usize| r + 1 < rows && self.wraps.get(r).copied().unwrap_or(false);
        let blank = Cell::default();
        let mut cur: PenKey = pen_key(&blank);
        let mut link: Option<&Arc<str>> = None;
        let mut link_bytes = 0usize;
        for r in 0..rows {
            let row = &f.cells[r * cols..(r + 1) * cols];
            let links = &self.links[r * cols..(r + 1) * cols];
            let mark = self.marks.get(r).copied().unwrap_or_default();
            let chained = r > 0 && wrapped(r - 1);
            let end = if wrapped(r) {
                Some(cols - 1)
            } else {
                row.iter()
                    .zip(links)
                    .rposition(|(c, l)| *c != blank || l.is_some())
            };
            let end = match (end, chained) {
                (Some(e), _) => e,
                (None, true) => 0,
                (None, false) => {
                    // A blank row can still be a prompt row.
                    if mark != RowMark::None {
                        let _ = write!(out, "\x1b[{};1H", r + 1);
                        write_row_mark(&mut out, mark);
                    }
                    continue;
                }
            };
            if !chained {
                let _ = write!(out, "\x1b[{};1H", r + 1);
            }
            for (cell, l) in row[..=end].iter().zip(&links[..=end]) {
                if cell.attrs.has(Attrs::WIDE_TAIL) {
                    continue;
                }
                if l.as_ref() != link {
                    if link.is_some() {
                        out.push_str("\x1b]8;;\x1b\\");
                    }
                    link = None;
                    if let Some(uri) = l {
                        if link_bytes + uri.len() <= MAX_SNAPSHOT_LINK_BYTES {
                            link_bytes += uri.len();
                            let _ = write!(out, "\x1b]8;;{uri}\x1b\\");
                            link = Some(uri);
                        }
                    }
                }
                let key = pen_key(cell);
                if key != cur {
                    write_sgr(&mut out, key);
                    cur = key;
                }
                match f.clusters.get(cell.cluster as usize) {
                    Some(text) if cell.cluster != 0 => out.push_str(text),
                    _ => out.push(cell.ch),
                }
            }
            // A link never runs across a row jump.
            if link.take().is_some() {
                out.push_str("\x1b]8;;\x1b\\");
            }
            // The mark goes after the text, while the cursor is still on this
            // row (a pending wrap leaves it there), and the semantic state is
            // put back to output so a wrap into the next row is not marked.
            write_row_mark(&mut out, mark);
        }
        // Pen: what the next character is drawn with.
        write_sgr(&mut out, pen_key(&self.pen));
        if let Some(title) = &f.title {
            let clean: String = title.chars().filter(|c| !c.is_control()).collect();
            let _ = write!(out, "\x1b]2;{clean}\x07");
        }

        // Tab stops: clear them all, then set each one (the cursor moves, and
        // is placed below).
        if let Some(tabs) = &extras.tabs {
            out.push_str("\x1b[3g");
            for &col in tabs {
                let _ = write!(out, "\x1b[{}G\x1bH", col as u32 + 1);
            }
        }

        // The cursor's prompt state (OSC 133), which decides how the next line
        // feed marks rows. A prompt state marks the row the cursor is on, so it
        // is written on a row already marked the same way (the cursor's own if
        // it is, else the first such row); with no such row it cannot be written
        // and the cursor is left in plain output. Written before the modes and
        // the final cursor move, so origin mode and the scroll region cannot
        // redirect the jump.
        match self.semantic[self.on_alt() as usize] {
            Semantic::Output => {}
            Semantic::Prompt { cont } => {
                let want = if cont {
                    RowMark::PromptContinuation
                } else {
                    RowMark::Prompt
                };
                let at = |r: usize| self.marks.get(r).copied() == Some(want);
                let host = if at(f.cursor.row as usize) {
                    Some(f.cursor.row as usize)
                } else {
                    (0..rows).find(|&r| at(r))
                };
                if let Some(r) = host {
                    let _ = write!(
                        out,
                        "\x1b[{};1H\x1b]133;P;k={}\x1b\\",
                        r + 1,
                        if cont { 's' } else { 'i' }
                    );
                }
            }
            Semantic::Input { eol } => {
                out.push_str(if eol {
                    "\x1b]133;I\x1b\\"
                } else {
                    "\x1b]133;B\x1b\\"
                });
            }
        }

        // Modes, after the grid so insert and newline modes do not touch it.
        // Each is written in both states so a snapshot of a restored screen is
        // byte for byte the same whatever the engine's defaults are.
        let term = &self.term;
        let on = |m: Mode| term.mode(m).unwrap_or(false);
        let flag = |out: &mut String, set: bool, code: &str| {
            let _ = write!(out, "\x1b[{code}{}", if set { 'h' } else { 'l' });
        };
        flag(&mut out, on(Mode::WRAPAROUND), "?7");
        flag(&mut out, on(Mode::INSERT), "4");
        flag(&mut out, on(Mode::LINEFEED), "20");
        flag(&mut out, on(Mode::ALT_SCROLL), "?1007");
        let m = &f.modes;
        match m.mouse {
            MouseMode::Off => {}
            MouseMode::Press => out.push_str("\x1b[?9h"),
            MouseMode::Normal => out.push_str("\x1b[?1000h"),
            MouseMode::Drag => out.push_str("\x1b[?1002h"),
            MouseMode::Any => out.push_str("\x1b[?1003h"),
        }
        match m.mouse_encoding {
            MouseEncoding::Default => {}
            MouseEncoding::Utf8 => out.push_str("\x1b[?1005h"),
            MouseEncoding::Sgr => out.push_str("\x1b[?1006h"),
        }
        if m.bracketed_paste {
            out.push_str("\x1b[?2004h");
        }
        if m.app_cursor_keys {
            out.push_str("\x1b[?1h");
        }
        if m.app_keypad {
            out.push_str("\x1b=");
        }
        if m.focus_events {
            out.push_str("\x1b[?1004h");
        }
        // The active screen's flags (the other screen's went before `1049h`).
        kitty(&mut out, m.kitty_keyboard);

        // Scroll region (homes the cursor), origin mode (homes it again,
        // relative to the region), then the cursor itself.
        let top = match extras.region {
            Some((start, end)) if start < end => {
                let _ = write!(out, "\x1b[{};{}r", start + 1, end);
                start
            }
            _ => 0,
        };
        let origin = on(Mode::ORIGIN);
        if origin {
            out.push_str("\x1b[?6h");
        }
        let shape = match (f.cursor.shape, self.blinking) {
            (CursorShape::Block, true) => 1,
            (CursorShape::Block, false) => 2,
            (CursorShape::Underline, true) => 3,
            (CursorShape::Underline, false) => 4,
            (CursorShape::Bar, true) => 5,
            (CursorShape::Bar, false) => 6,
        };
        let _ = write!(out, "\x1b[{shape} q");
        let row = if origin {
            f.cursor.row.saturating_sub(top)
        } else {
            f.cursor.row
        };
        let _ = write!(out, "\x1b[{};{}H", row + 1, f.cursor.col + 1);
        // A pending autowrap (the cursor sits on the last column and the next
        // character wraps): print that column's character again, which leaves
        // the cursor in the same state. Only with autowrap on, on a narrow cell.
        if on(Mode::WRAPAROUND)
            && term.is_cursor_pending_wrap().unwrap_or(false)
            && f.cursor.col as usize + 1 == cols
        {
            let i = f.cursor.row as usize * cols + cols - 1;
            if let Some(cell) = f.cells.get(i) {
                if !cell.attrs.has(Attrs::WIDE_TAIL) && f.cursor.row < f.rows {
                    // The cell keeps its own link: printing it again with none
                    // open would clear it.
                    let own = self.links.get(i).and_then(|l| l.as_ref());
                    let own = own.filter(|u| link_bytes + u.len() <= MAX_SNAPSHOT_LINK_BYTES);
                    if let Some(uri) = own {
                        link_bytes += uri.len();
                        let _ = write!(out, "\x1b]8;;{uri}\x1b\\");
                    }
                    write_sgr(&mut out, pen_key(cell));
                    match f.clusters.get(cell.cluster as usize) {
                        Some(text) if cell.cluster != 0 => out.push_str(text),
                        _ => out.push(cell.ch),
                    }
                    write_sgr(&mut out, pen_key(&self.pen));
                    if own.is_some() {
                        out.push_str("\x1b]8;;\x1b\\");
                    }
                }
            }
        }
        // Character sets last: the grid and the reprint above were written
        // under the default sets, and the designations and shifts change how
        // the next characters print, not what is already there.
        out.extend(extras.charsets.iter().map(|&b| b as char));
        // The link the program left open, for the text it prints next.
        let screen = self.on_alt() as usize;
        if let Some(uri) = &self.open_link[screen] {
            if link_bytes + uri.len() <= MAX_SNAPSHOT_LINK_BYTES {
                let _ = write!(out, "\x1b]8;;{uri}\x1b\\");
            }
        }
        out.push_str(if f.cursor.visible {
            "\x1b[?25h"
        } else {
            "\x1b[?25l"
        });
        if m.sync_output {
            out.push_str("\x1b[?2026h");
        }
        out.into_bytes()
    }
}

fn push_reply(q: &Replies, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    let mut q = q.borrow_mut();
    if q.len() >= MAX_PENDING_REPLIES {
        q.pop_front();
    }
    q.push_back(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decstbm_is_found_among_other_output() {
        assert_eq!(parse_decstbm(b"\x1b[2;5r"), Some((1, 5)));
        assert_eq!(parse_decstbm(b"x\x1b[1m\x1b[3;9ry"), Some((2, 9)));
        assert_eq!(parse_decstbm(b"\x1b[r"), None);
        assert_eq!(parse_decstbm(b"\x1b[5;2r"), None);
        assert_eq!(parse_decstbm(b"plain"), None);
    }

    #[test]
    fn the_formatters_extras_are_read_out_of_its_output() {
        // One cell of content (with its own SGR), then the extras in the order
        // the engine writes them: scroll region, tab stops.
        let out = parse_extras(b"\x1b[1mx\x1b[0m\x1b[2;5r\x1b[3g\x1b[9G\x1bH\x1b[17G\x1bH");
        assert_eq!(out.region, Some((1, 5)));
        assert_eq!(out.tabs, Some(vec![8, 16]));
        assert!(out.charsets.is_empty());

        // Character sets come with the screen's extras, before the cursor.
        let out = parse_extras(b"x\x1b(0\x1b)A\x0e\x1b~\x1b[3g");
        assert_eq!(out.charsets, b"\x1b(0\x1b)A\x0e\x1b~");
        assert_eq!(out.tabs, Some(vec![]), "all stops cleared");

        // Nothing from the formatter, nothing carried.
        assert_eq!(parse_extras(b""), Extras::default());
        assert_eq!(parse_extras(b"plain"), Extras::default());
        // A cell's own SGR and hyperlink are not charset designations.
        let out = parse_extras(b"\x1b]8;;http://x/\x1b\\\x1b[4:3;58;2;1;2;3mq\x1b[3g");
        assert!(out.charsets.is_empty());
        // A malformed stop list ends the list instead of reading past it.
        let out = parse_extras(b"\x1b[3g\x1b[5G\x1bH\x1b[7G");
        assert_eq!(out.tabs, Some(vec![4]));
    }

    #[test]
    fn osc_133_bodies_map_to_the_cursors_prompt_state() {
        assert_eq!(semantic_of(b"A"), Some(Semantic::Prompt { cont: false }));
        assert_eq!(semantic_of(b"A;k=s"), Some(Semantic::Prompt { cont: true }));
        assert_eq!(
            semantic_of(b"P;aid=1;k=c"),
            Some(Semantic::Prompt { cont: true })
        );
        assert_eq!(
            semantic_of(b"N;k=i"),
            Some(Semantic::Prompt { cont: false })
        );
        assert_eq!(semantic_of(b"B"), Some(Semantic::Input { eol: false }));
        assert_eq!(semantic_of(b"I"), Some(Semantic::Input { eol: true }));
        assert_eq!(semantic_of(b"C"), Some(Semantic::Output));
        assert_eq!(semantic_of(b"D;0"), Some(Semantic::Output));
        assert_eq!(semantic_of(b"L"), None);
        assert_eq!(semantic_of(b"AB"), None, "the engine rejects this too");
        assert_eq!(semantic_of(b""), None);
    }

    #[test]
    fn an_sgr_names_the_underline_shape_and_colour() {
        let key = |u, c| {
            (
                Color::Default,
                Color::Default,
                Attrs(Attrs::UNDERLINE),
                u,
                c,
            )
        };
        let sgr = |u, c| {
            let mut s = String::new();
            write_sgr(&mut s, key(u, c));
            s
        };
        assert_eq!(sgr(UnderlineStyle::Single, Color::Default), "\x1b[0;4m");
        assert_eq!(sgr(UnderlineStyle::Curly, Color::Default), "\x1b[0;4:3m");
        assert_eq!(
            sgr(UnderlineStyle::Dashed, Color::Indexed(9)),
            "\x1b[0;4:5;58;5;9m"
        );
        assert_eq!(
            sgr(UnderlineStyle::Double, Color::Rgb(1, 2, 3)),
            "\x1b[0;4:2;58;2;1;2;3m"
        );
        let mut plain = String::new();
        write_sgr(&mut plain, pen_key(&Cell::default()));
        assert_eq!(plain, "\x1b[0m");
        // A colour with no underline is still written: the pen keeps it.
        let mut s = String::new();
        write_sgr(
            &mut s,
            (
                Color::Default,
                Color::Default,
                Attrs(0),
                UnderlineStyle::None,
                Color::Rgb(9, 8, 7),
            ),
        );
        assert_eq!(s, "\x1b[0;58;2;9;8;7m");
    }

    #[test]
    fn scrollback_budget_grows_with_lines() {
        assert_eq!(scrollback_bytes(0, 80), 0);
        assert!(scrollback_bytes(10_000, 80) > 10_000 * 80 * 10);
        assert!(scrollback_bytes(usize::MAX, 2000) > 0);
    }
}
