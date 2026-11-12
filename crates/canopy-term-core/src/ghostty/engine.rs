//! The libghostty-vt side of `Screen`. Everything in this file runs on the one
//! thread that created the [`Engine`]: libghostty-vt types are `!Send` and
//! `!Sync`, and nothing here is `Send` either (it holds `Rc`s the engine's
//! callbacks write to). `mod.rs` owns the thread and ships closures to it.

use super::scan::{base64_decode, rgb_spec, split_osc, Osc, Scanner, Step};
use super::{Event, PromptKind, PromptMark, RowMark, MAX_CLIPBOARD_BYTES, MAX_PENDING_EVENTS};
use crate::frame::{
    Attrs, Cell, Color, Cursor, CursorShape, Damage, Frame, Modes, MouseEncoding, MouseMode,
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
use libghostty_vt::style::{PaletteIndex, RgbColor, Style, StyleColor, Underline};
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
    clipboard_read_events: bool,
    scratch: String,
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
    let wide = raw.wide();
    if matches!(wide, Ok(CellWide::SpacerTail)) {
        return Cell {
            ch: '\0',
            cluster: 0,
            fg,
            bg,
            attrs: Attrs(attrs | Attrs::WIDE_TAIL),
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
        if x.fg != y.fg || x.bg != y.bg || x.attrs != y.attrs || x.ch != y.ch {
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

fn write_sgr(out: &mut String, fg: Color, bg: Color, attrs: Attrs) {
    out.push_str("\x1b[0");
    for (flag, code) in [
        (Attrs::BOLD, 1),
        (Attrs::DIM, 2),
        (Attrs::ITALIC, 3),
        (Attrs::UNDERLINE, 4),
        (Attrs::INVERSE, 7),
        (Attrs::HIDDEN, 8),
        (Attrs::STRIKE, 9),
    ] {
        if attrs.has(flag) {
            let _ = write!(out, ";{code}");
        }
    }
    match fg {
        Color::Default => {}
        Color::Indexed(i) => {
            let _ = write!(out, ";38;5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(out, ";38;2;{r};{g};{b}");
        }
    }
    match bg {
        Color::Default => {}
        Color::Indexed(i) => {
            let _ = write!(out, ";48;5;{i}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(out, ";48;2;{r};{g};{b}");
        }
    }
    out.push('m');
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
    let full = force_full || prev.is_none() || dirty != Dirty::Clean;
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
            clipboard_read_events: false,
            scratch: String::new(),
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

    /// Rebuild the frame after a run of `feed`s.
    pub(crate) fn settle(&mut self) {
        self.refresh(false);
    }

    fn step(&mut self, step: Step) {
        match step {
            Step::Reset => {
                self.title = None;
                self.kitty = [0; 2];
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
        let end: &str = if osc.bel { "\x07" } else { "\x1b\\" };
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
            4 => {
                let text = String::from_utf8_lossy(rest);
                let mut it = text.split(';');
                while let (Some(index), Some(spec)) = (it.next(), it.next()) {
                    if spec != "?" {
                        continue;
                    }
                    let Ok(i) = index.parse::<u8>() else { continue };
                    if let Ok(p) = self.term.color_palette() {
                        let c = p.get(PaletteIndex(i));
                        let s = format!("\x1b]4;{i};{}{end}", rgb_spec(c.r, c.g, c.b));
                        self.reply(s.into_bytes());
                    }
                }
            }
            10..=12 => {
                let text = String::from_utf8_lossy(rest);
                for (k, piece) in text.split(';').enumerate() {
                    let n = num + k as u32;
                    if piece != "?" || n > 12 {
                        continue;
                    }
                    let color = match n {
                        10 => self.term.fg_color(),
                        11 => self.term.bg_color(),
                        _ => self.term.cursor_color(),
                    };
                    if let Ok(Some(c)) = color {
                        let s = format!("\x1b]{n};{}{end}", rgb_spec(c.r, c.g, c.b));
                        self.reply(s.into_bytes());
                    }
                }
            }
            52 => self.osc52(&osc, rest),
            133 => {
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
        self.refresh(true);
    }

    pub(crate) fn frame(&self) -> Frame {
        self.frame.clone()
    }

    pub(crate) fn seq(&self) -> u64 {
        self.frame.seq
    }

    pub(crate) fn cursor_blinking(&self) -> bool {
        self.blinking
    }

    pub(crate) fn damage_since(&self, since: u64) -> Damage {
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

    pub(crate) fn hyperlink_at(&self, row: u16, col: u16) -> Option<String> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        self.links
            .get(row as usize * self.cols as usize + col as usize)
            .cloned()
            .flatten()
            .map(|s| s.to_string())
    }

    pub(crate) fn row_mark(&self, row: u16) -> RowMark {
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
        let tracking = term.is_mouse_tracking().unwrap_or(false);
        let mouse = if !tracking {
            MouseMode::Off
        } else if on(Mode::ANY_MOUSE) {
            MouseMode::Any
        } else if on(Mode::BUTTON_MOUSE) {
            MouseMode::Drag
        } else if on(Mode::NORMAL_MOUSE) {
            MouseMode::Normal
        } else if on(Mode::X10_MOUSE) {
            MouseMode::Press
        } else {
            MouseMode::Off
        };
        let mouse_encoding = if on(Mode::SGR_MOUSE) {
            MouseEncoding::Sgr
        } else if on(Mode::UTF8_MOUSE) {
            MouseEncoding::Utf8
        } else {
            MouseEncoding::Default
        };
        let modes = Modes {
            mouse,
            mouse_encoding,
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
            Ok(style) => Cell {
                ch: ' ',
                cluster: 0,
                fg: color_of(style.fg_color),
                bg: color_of(style.bg_color),
                attrs: Attrs(attrs_of(&style)),
            },
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

    /// The scroll region, as the engine's own VT formatter writes it (the
    /// terminal has no getter for it). Zero-based `start..end`; `None` for the
    /// whole screen.
    fn scroll_region(&self) -> Option<(u16, u16)> {
        let at = Point::Active(PointCoordinate { x: 0, y: 0 });
        let a = self.term.grid_ref(at).ok()?;
        let b = self.term.grid_ref(at).ok()?;
        let sel = Selection::new(a, b, false);
        let opts = FormatterOptions::new()
            .with_format(Format::Vt)
            .with_scrolling_region(true)
            .with_selection(&sel);
        let mut fmt = Formatter::new(&self.term, opts).ok()?;
        let n = fmt.format_len().ok()?;
        let mut buf = vec![0u8; n];
        let got = fmt.format_buf(&mut buf).ok()?;
        parse_decstbm(buf.get(..got)?)
    }

    /// Escape sequences that bring a fresh `Screen` of the same size to this
    /// screen's visible grid, cursor, pen, title and modes. Scrollback is not
    /// carried, nor is the primary screen behind an active alternate screen.
    /// Built from our own frame (plus the engine's soft-wrap flags and scroll
    /// region) rather than the engine's VT formatter, which has no notion of
    /// the visible area only, and drops soft wraps.
    pub(crate) fn snapshot(&self) -> Vec<u8> {
        let f = &self.frame;
        let mut out = String::new();
        let kitty = |out: &mut String, flags: u8| {
            if flags != 0 {
                let _ = write!(out, "\x1b[>{flags}u");
            }
        };
        out.push_str("\x1bc");
        if f.alt_screen {
            kitty(&mut out, self.kitty[0]);
            out.push_str("\x1b[?1049h");
        }

        let (cols, rows) = (f.cols as usize, f.rows as usize);
        let wrapped = |r: usize| r + 1 < rows && self.wraps.get(r).copied().unwrap_or(false);
        let blank = Cell::default();
        let mut cur: (Color, Color, Attrs) = (Color::Default, Color::Default, Attrs(0));
        let mut link: Option<&Arc<str>> = None;
        let mut link_bytes = 0usize;
        for r in 0..rows {
            let row = &f.cells[r * cols..(r + 1) * cols];
            let links = &self.links[r * cols..(r + 1) * cols];
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
                (None, false) => continue,
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
                let attrs = Attrs(cell.attrs.0 & !Attrs::WIDE_TAIL);
                if (cell.fg, cell.bg, attrs) != cur {
                    write_sgr(&mut out, cell.fg, cell.bg, attrs);
                    cur = (cell.fg, cell.bg, attrs);
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
        }
        // Pen: what the next character is drawn with.
        write_sgr(
            &mut out,
            self.pen.fg,
            self.pen.bg,
            Attrs(self.pen.attrs.0 & !Attrs::WIDE_TAIL),
        );
        if let Some(title) = &f.title {
            let clean: String = title.chars().filter(|c| !c.is_control()).collect();
            let _ = write!(out, "\x1b]2;{clean}\x07");
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
        let top = match self.scroll_region() {
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
                    write_sgr(&mut out, cell.fg, cell.bg, cell.attrs);
                    match f.clusters.get(cell.cluster as usize) {
                        Some(text) if cell.cluster != 0 => out.push_str(text),
                        _ => out.push(cell.ch),
                    }
                    write_sgr(
                        &mut out,
                        self.pen.fg,
                        self.pen.bg,
                        Attrs(self.pen.attrs.0 & !Attrs::WIDE_TAIL),
                    );
                }
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
    fn scrollback_budget_grows_with_lines() {
        assert_eq!(scrollback_bytes(0, 80), 0);
        assert!(scrollback_bytes(10_000, 80) > 10_000 * 80 * 10);
        assert!(scrollback_bytes(usize::MAX, 2000) > 0);
    }
}
