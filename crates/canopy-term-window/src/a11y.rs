//! The visible screen as an AccessKit tree, so VoiceOver, NVDA, Narrator and
//! Orca can read the terminal.
//!
//! Shape:
//! * `Window` (root, labelled with the title) containing
//! * one `Terminal` node (focusable; holds the caret and the selection as an
//!   AccessKit text selection), whose children are
//! * one `TextRun` per visible row, in order. Each run's value is the row's text
//!   (wide-character tails skipped, clusters whole, concealed cells as spaces,
//!   trailing blanks trimmed but never left of the cursor) followed by `\n`
//!   on all but the last row, with per-character byte lengths, pixel positions
//!   and widths (physical pixels, the unit AccessKit adapters expect), and word
//!   starts.
//! * New output is announced politely: a `Label` node with `Live::Polite` is
//!   added under the root with the lines that appeared (lines that scrolled in,
//!   or rows that changed, other than the cursor row, which is where typing
//!   echoes). Each announcement is a new node id: adapters announce a live node
//!   when it is added or its text changes, so identical output twice is still
//!   announced. Nothing is announced on the alternate screen (full-screen
//!   programs redraw constantly) or across a resize or screen switch.
//!
//! `A11yTree` diffs against the rows it last published, not against frame
//! damage: the adapter is inactive most of the time and only asks for a tree
//! when a screen reader is running, so its baseline is its own.

use accesskit::{
    Action, Live, Node, NodeId, Rect, Role, TextDirection, TextPosition, TextSelection, TreeId,
    TreeInfo, TreeUpdate,
};
use canopy_term_core::frame::{Attrs, Frame};

use crate::grid::CellPx;
use crate::selection::Selection;

pub const ROOT_ID: NodeId = NodeId(1);
pub const TERMINAL_ID: NodeId = NodeId(2);
/// "Scrolled back N of M lines": present only while the view is scrolled back.
pub const STATUS_ID: NodeId = NodeId(3);
const LINE_BASE: u64 = 1 << 16;
const ANNOUNCE_BASE: u64 = 1 << 32;
/// At most this many lines go into one announcement (the newest ones).
pub const MAX_ANNOUNCE_LINES: usize = 20;
/// And at most this many bytes.
pub const MAX_ANNOUNCE_BYTES: usize = 4000;

/// What the window shows besides the screen, for the tree to describe.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UiExtras {
    /// (lines above the live screen, lines of history) while scrolled back.
    pub scrollback: Option<(usize, usize)>,
}

impl UiExtras {
    fn child_ids(&self) -> Vec<NodeId> {
        let mut ids = Vec::new();
        if self.scrollback.is_some() {
            ids.push(STATUS_ID);
        }
        ids
    }

    fn nodes(&self) -> Vec<(NodeId, Node)> {
        let mut nodes = Vec::new();
        if let Some((offset, total)) = self.scrollback {
            nodes.push((STATUS_ID, status_node(offset, total)));
        }
        nodes
    }
}

fn status_node(offset: usize, total: usize) -> Node {
    let text = format!("Scrolled back {offset} of {total} lines");
    let mut node = Node::new(Role::Label);
    node.set_value(text.clone());
    node.set_label(text);
    // Polite: a screen reader says where the view moved to, briefly.
    node.set_live(Live::Polite);
    node
}

pub fn line_id(row: u16) -> NodeId {
    NodeId(LINE_BASE + row as u64)
}

fn row_of(id: NodeId) -> Option<u16> {
    let n = id.0.checked_sub(LINE_BASE)?;
    (n <= u16::MAX as u64 && id.0 < ANNOUNCE_BASE).then_some(n as u16)
}

/// One character of a row: its starting column, columns covered and UTF-8
/// byte length in the row's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineChar {
    pub col: u16,
    pub cols: u8,
    pub len: u8,
}

/// One row as screen-reader text (without the line break).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct LineText {
    pub text: String,
    pub chars: Vec<LineChar>,
}

impl LineText {
    /// The character index of the cell at `col`: the character covering it (a
    /// wide character's tail maps to its head), or the end of the text when
    /// `col` is past it.
    pub fn char_index(&self, col: u16) -> usize {
        self.chars
            .iter()
            .position(|c| c.col + c.cols as u16 > col)
            .unwrap_or(self.chars.len())
    }

    /// The index just after the character at `col`, for the end of a selection.
    pub fn char_index_after(&self, col: u16) -> usize {
        (self.char_index(col) + 1).min(self.chars.len())
    }

    /// The column a character index starts at (the end of the text maps to the
    /// column after the last character).
    pub fn col_of(&self, index: usize) -> u16 {
        match self.chars.get(index) {
            Some(c) => c.col,
            None => self.chars.last().map_or(0, |c| c.col + c.cols as u16),
        }
    }
}

/// The text of `row`. Trailing blanks are trimmed, except that characters
/// starting left of `keep_to` are always kept (so the caret after a prompt's
/// trailing space still has a character to sit after).
pub fn line_text(frame: &Frame, row: u16, keep_to: u16) -> LineText {
    let mut line = LineText::default();
    if row >= frame.rows {
        return line;
    }
    for col in 0..frame.cols {
        let Some(cell) = frame.cell(row, col) else {
            break;
        };
        if cell.attrs.has(Attrs::WIDE_TAIL) {
            continue;
        }
        let cols = if frame
            .cell(row, col + 1)
            .is_some_and(|n| n.attrs.has(Attrs::WIDE_TAIL))
        {
            2
        } else {
            1
        };
        let start = line.text.len();
        if cell.attrs.has(Attrs::HIDDEN) || cell.ch == '\0' {
            line.text.push(' ');
        } else {
            let text = frame.text(cell);
            // AccessKit stores a character's length in a byte; a cluster that
            // long is reduced to its first scalar.
            if text.len() <= u8::MAX as usize {
                line.text.push_str(&text);
            } else {
                line.text.push(cell.ch);
            }
        }
        line.chars.push(LineChar {
            col,
            cols,
            len: (line.text.len() - start) as u8,
        });
    }
    while let Some(last) = line.chars.last() {
        let start = line.text.len() - last.len as usize;
        if last.col < keep_to || &line.text[start..] != " " {
            break;
        }
        line.text.truncate(start);
        line.chars.pop();
    }
    line
}

/// Word starts by character index: a non-space after a space (or at 0).
/// `None` when an index does not fit AccessKit's byte-sized list.
fn word_starts(line: &LineText) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut prev_space = true;
    let mut byte = 0;
    for (i, c) in line.chars.iter().enumerate() {
        let s = &line.text[byte..byte + c.len as usize];
        byte += c.len as usize;
        let space = s.chars().all(char::is_whitespace);
        if !space && prev_space {
            if i > u8::MAX as usize {
                return None;
            }
            out.push(i as u8);
        }
        prev_space = space;
    }
    Some(out)
}

fn line_node(line: &LineText, row: u16, last_row: bool, cell: CellPx, cols: u16) -> Node {
    let (w, h) = (cell.width as f64, cell.height as f64);
    let mut node = Node::new(Role::TextRun);
    let y0 = row as f64 * h;
    node.set_bounds(Rect {
        x0: 0.0,
        y0,
        x1: cols as f64 * w,
        y1: y0 + h,
    });
    let mut value = line.text.clone();
    let mut lens = Vec::with_capacity(line.chars.len() + 1);
    let mut positions = Vec::with_capacity(line.chars.len() + 1);
    let mut widths = Vec::with_capacity(line.chars.len() + 1);
    for c in &line.chars {
        lens.push(c.len);
        positions.push((c.col as f64 * w) as f32);
        widths.push((c.cols as f64 * w) as f32);
    }
    if !last_row {
        value.push('\n');
        lens.push(1);
        positions.push((line.col_of(line.chars.len()) as f64 * w) as f32);
        widths.push(0.0);
    }
    node.set_value(value);
    node.set_character_lengths(lens);
    node.set_character_positions(positions);
    node.set_character_widths(widths);
    if let Some(starts) = word_starts(line) {
        node.set_word_starts(starts);
    }
    node.set_text_direction(TextDirection::LeftToRight);
    node
}

/// The caret (or the selection) as an AccessKit text selection over the row
/// nodes.
pub fn text_selection(
    lines: &[LineText],
    frame: &Frame,
    selection: Option<&Selection>,
) -> Option<TextSelection> {
    let rows = lines.len() as u16;
    if rows == 0 {
        return None;
    }
    let at = |(r, c): (u16, u16), after: bool| {
        let r = r.min(rows - 1);
        let line = &lines[r as usize];
        TextPosition {
            node: line_id(r),
            character_index: if after {
                line.char_index_after(c)
            } else {
                line.char_index(c)
            },
        }
    };
    Some(match selection {
        Some(s) if s.start <= s.end => TextSelection {
            anchor: at(s.start, false),
            focus: at(s.end, true),
        },
        Some(s) => TextSelection {
            anchor: at(s.start, true),
            focus: at(s.end, false),
        },
        None => {
            let caret = at((frame.cursor.row, frame.cursor.col), false);
            TextSelection {
                anchor: caret,
                focus: caret,
            }
        }
    })
}

fn root_node(title: &str, announce: Option<NodeId>, extras: &UiExtras) -> Node {
    let mut node = Node::new(Role::Window);
    node.set_label(title.to_string());
    let mut children = vec![TERMINAL_ID];
    children.extend(extras.child_ids());
    children.extend(announce);
    node.set_children(children);
    node
}

fn terminal_node(rows: u16, cols: u16, cell: CellPx, sel: Option<&TextSelection>) -> Node {
    let mut node = Node::new(Role::Terminal);
    node.set_label("Terminal".to_string());
    node.set_bounds(Rect {
        x0: 0.0,
        y0: 0.0,
        x1: cols as f64 * cell.width as f64,
        y1: rows as f64 * cell.height as f64,
    });
    node.set_children((0..rows).map(line_id).collect::<Vec<_>>());
    node.add_action(Action::Focus);
    node.add_action(Action::SetTextSelection);
    node.set_text_direction(TextDirection::LeftToRight);
    if let Some(sel) = sel {
        node.set_text_selection(*sel);
    }
    node
}

fn announce_node(text: &str) -> Node {
    let mut node = Node::new(Role::Label);
    // A Label's accessible name comes from its value on every adapter; the
    // label is set too for any that read it.
    node.set_value(text.to_string());
    node.set_label(text.to_string());
    node.set_live(Live::Polite);
    node
}

fn all_lines(frame: &Frame) -> Vec<LineText> {
    (0..frame.rows)
        .map(|r| {
            let keep = if r == frame.cursor.row {
                frame.cursor.col.min(frame.cols)
            } else {
                0
            };
            line_text(frame, r, keep)
        })
        .collect()
}

fn title_of(frame: &Frame) -> String {
    frame
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Terminal".to_string())
}

fn tree_info() -> TreeInfo {
    let mut info = TreeInfo::new(ROOT_ID);
    info.toolkit_name = Some("canopy-term".to_string());
    info.toolkit_version = Some(env!("CARGO_PKG_VERSION").to_string());
    info
}

/// The whole tree for one frame: a pure function, also what an adapter gets
/// when a screen reader first asks.
pub fn tree_for(frame: &Frame, cell: CellPx, selection: Option<&Selection>) -> TreeUpdate {
    let lines = all_lines(frame);
    full_update(frame, cell, &lines, selection, None, &UiExtras::default())
}

fn full_update(
    frame: &Frame,
    cell: CellPx,
    lines: &[LineText],
    selection: Option<&Selection>,
    announce: Option<(NodeId, &str)>,
    extras: &UiExtras,
) -> TreeUpdate {
    let sel = text_selection(lines, frame, selection);
    let mut nodes = Vec::with_capacity(lines.len() + 3);
    nodes.push((
        ROOT_ID,
        root_node(&title_of(frame), announce.map(|a| a.0), extras),
    ));
    nodes.push((
        TERMINAL_ID,
        terminal_node(frame.rows, frame.cols, cell, sel.as_ref()),
    ));
    let last = frame.rows.saturating_sub(1);
    for (r, line) in lines.iter().enumerate() {
        let r = r as u16;
        nodes.push((line_id(r), line_node(line, r, r == last, cell, frame.cols)));
    }
    nodes.extend(extras.nodes());
    if let Some((id, text)) = announce {
        nodes.push((id, announce_node(text)));
    }
    TreeUpdate {
        nodes,
        tree: Some(tree_info()),
        tree_id: TreeId::ROOT,
        focus: TERMINAL_ID,
    }
}

/// Rows that are new output: the best scroll offset is found by matching
/// non-empty old rows against new rows (the cursor row is not evidence: a fresh
/// prompt often equals an old one); rows with no match (scrolled in, or changed
/// in place) are new. The cursor row and blank rows are left out. Rows are
/// compared without trailing blanks: the cursor row keeps them and the same
/// row loses them once the cursor leaves, which is not new output.
pub fn new_output(old: &[LineText], new: &[LineText], cursor_row: u16) -> Vec<String> {
    let n = new.len();
    if old.len() != n || n == 0 {
        return Vec::new();
    }
    let o = |r: usize| old[r].text.trim_end();
    let w = |r: usize| new[r].text.trim_end();
    let mut best = (0usize, 0usize); // (matches, offset)
    for s in 0..n {
        let matches = (0..n - s)
            .filter(|&r| r != cursor_row as usize && !w(r).is_empty() && o(r + s) == w(r))
            .count();
        if matches > best.0 {
            best = (matches, s);
        }
    }
    let s = best.1;
    let mut out: Vec<String> = (0..n)
        .filter(|&r| r != cursor_row as usize)
        .filter(|&r| r + s >= n || o(r + s) != w(r))
        .map(|r| new[r].text.trim_end().to_string())
        .filter(|t| !t.trim().is_empty())
        .collect();
    if out.len() > MAX_ANNOUNCE_LINES {
        out.drain(..out.len() - MAX_ANNOUNCE_LINES);
    }
    let mut bytes: usize = out.iter().map(|l| l.len() + 1).sum();
    while bytes > MAX_ANNOUNCE_BYTES && out.len() > 1 {
        bytes -= out[0].len() + 1;
        out.remove(0);
    }
    out
}

struct Published {
    cols: u16,
    rows: u16,
    cell: CellPx,
    alt_screen: bool,
    title: String,
    lines: Vec<LineText>,
    selection: Option<TextSelection>,
    announce: Option<NodeId>,
    extras: UiExtras,
}

/// Incremental tree updates against what was last published.
#[derive(Default)]
pub struct A11yTree {
    published: Option<Published>,
    announcements: u64,
    extras: UiExtras,
}

impl A11yTree {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the window shows besides the screen (scrollback badge). Takes
    /// effect with the next [`A11yTree::update`] or [`A11yTree::full`].
    pub fn set_extras(&mut self, extras: UiExtras) {
        self.extras = extras;
    }

    /// The full tree (a screen reader just started), which becomes the
    /// baseline.
    pub fn full(
        &mut self,
        frame: &Frame,
        cell: CellPx,
        selection: Option<&Selection>,
    ) -> TreeUpdate {
        let lines = all_lines(frame);
        let update = full_update(frame, cell, &lines, selection, None, &self.extras);
        self.published = Some(Published {
            cols: frame.cols,
            rows: frame.rows,
            cell,
            alt_screen: frame.alt_screen,
            title: title_of(frame),
            selection: text_selection(&lines, frame, selection),
            lines,
            announce: None,
            extras: self.extras.clone(),
        });
        update
    }

    /// The screen reader went away: the next update is a full tree.
    pub fn deactivate(&mut self) {
        self.published = None;
    }

    /// The changes since the last update, or `None` when nothing a screen
    /// reader sees changed. Without a baseline this is the full tree.
    pub fn update(
        &mut self,
        frame: &Frame,
        cell: CellPx,
        selection: Option<&Selection>,
    ) -> Option<TreeUpdate> {
        if self.published.is_none() {
            return Some(self.full(frame, cell, selection));
        }
        let prev = self.published.as_mut().expect("checked above");
        let lines = all_lines(frame);
        let sel = text_selection(&lines, frame, selection);
        let title = title_of(frame);
        let reshaped = prev.cols != frame.cols || prev.rows != frame.rows || prev.cell != cell;
        let mut nodes = Vec::new();

        let mut announce = None;
        // Moving through history is not new output, and neither is output
        // that arrives while the view is scrolled back.
        let scrolled = self.extras.scrollback.is_some() || prev.extras.scrollback.is_some();
        if !reshaped && !frame.alt_screen && !prev.alt_screen && !scrolled {
            let output = new_output(&prev.lines, &lines, frame.cursor.row);
            if !output.is_empty() {
                self.announcements += 1;
                let id = NodeId(ANNOUNCE_BASE + self.announcements);
                announce = Some((id, output.join("\n")));
            }
        }

        let extras_changed = self.extras != prev.extras;
        let root_changed = title != prev.title || announce.is_some() || extras_changed;
        if root_changed {
            let id = announce.as_ref().map(|a| a.0).or(prev.announce);
            nodes.push((ROOT_ID, root_node(&title, id, &self.extras)));
        }
        if extras_changed {
            nodes.extend(self.extras.nodes());
        }
        if reshaped || sel != prev.selection {
            nodes.push((
                TERMINAL_ID,
                terminal_node(frame.rows, frame.cols, cell, sel.as_ref()),
            ));
        }
        let last = frame.rows.saturating_sub(1);
        let prev_last = prev.rows.saturating_sub(1);
        for (r, line) in lines.iter().enumerate() {
            let r16 = r as u16;
            // The last row has no line break, so a row becoming (or ceasing to
            // be) the last changes its node too.
            let same =
                !reshaped && prev.lines.get(r) == Some(line) && (r16 == last) == (r16 == prev_last);
            if !same {
                nodes.push((
                    line_id(r16),
                    line_node(line, r16, r16 == last, cell, frame.cols),
                ));
            }
        }
        if let Some((id, text)) = &announce {
            nodes.push((*id, announce_node(text)));
        }

        prev.cols = frame.cols;
        prev.rows = frame.rows;
        prev.cell = cell;
        prev.alt_screen = frame.alt_screen;
        prev.title = title;
        prev.lines = lines;
        prev.selection = sel;
        prev.extras = self.extras.clone();
        if let Some((id, _)) = announce {
            prev.announce = Some(id);
        }

        if nodes.is_empty() {
            return None;
        }
        Some(TreeUpdate {
            nodes,
            tree: None,
            tree_id: TreeId::ROOT,
            focus: TERMINAL_ID,
        })
    }

    /// The grid cell a screen reader's text position refers to (for its
    /// "set selection" requests), from the last published rows.
    pub fn cell_for(&self, pos: &TextPosition) -> Option<(u16, u16)> {
        let prev = self.published.as_ref()?;
        let row = row_of(pos.node)?;
        let line = prev.lines.get(row as usize)?;
        Some((row, line.col_of(pos.character_index)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_core::frame::Cell;

    const CELL: CellPx = CellPx {
        width: 10,
        height: 20,
    };

    fn frame_of(lines: &[&str], cols: u16) -> Frame {
        let mut f = Frame::blank(cols, lines.len() as u16);
        for (r, line) in lines.iter().enumerate() {
            for (c, ch) in line.chars().enumerate() {
                f.cells[r * cols as usize + c].ch = ch;
            }
        }
        f.seq = 1;
        f
    }

    fn node(update: &TreeUpdate, id: NodeId) -> &Node {
        &update
            .nodes
            .iter()
            .find(|(i, _)| *i == id)
            .unwrap_or_else(|| panic!("node {id:?} missing"))
            .1
    }

    fn ids(update: &TreeUpdate) -> Vec<NodeId> {
        let mut v: Vec<NodeId> = update.nodes.iter().map(|(i, _)| *i).collect();
        v.sort();
        v
    }

    #[test]
    fn the_full_tree_has_a_terminal_with_one_text_run_per_row() {
        let mut f = frame_of(&["$ ls", "a.txt  b.txt", ""], 20);
        f.cursor.row = 2;
        f.title = Some("zsh".into());
        let u = tree_for(&f, CELL, None);
        assert_eq!(u.tree.as_ref().unwrap().root, ROOT_ID);
        assert_eq!(u.focus, TERMINAL_ID);
        let root = node(&u, ROOT_ID);
        assert_eq!(root.role(), Role::Window);
        assert_eq!(root.label(), Some("zsh"));
        assert_eq!(root.children(), &[TERMINAL_ID]);
        let term = node(&u, TERMINAL_ID);
        assert_eq!(term.role(), Role::Terminal);
        assert_eq!(term.children(), &[line_id(0), line_id(1), line_id(2)]);
        let r0 = node(&u, line_id(0));
        assert_eq!(r0.role(), Role::TextRun);
        assert_eq!(r0.value(), Some("$ ls\n"));
        assert_eq!(r0.character_lengths(), &[1, 1, 1, 1, 1]);
        assert_eq!(
            r0.character_positions(),
            Some(&[0.0f32, 10.0, 20.0, 30.0, 40.0][..])
        );
        assert_eq!(r0.word_starts(), &[0, 2]);
        let b = r0.bounds().unwrap();
        assert_eq!((b.x0, b.y0, b.x1, b.y1), (0.0, 0.0, 200.0, 20.0));
        assert_eq!(node(&u, line_id(1)).value(), Some("a.txt  b.txt\n"));
        // The last row has no line break.
        assert_eq!(node(&u, line_id(2)).value(), Some(""));
        assert_eq!(node(&u, line_id(2)).bounds().unwrap().y0, 40.0);
    }

    #[test]
    fn the_caret_sits_after_a_prompts_trailing_space() {
        let mut f = frame_of(&["$ ", ""], 10);
        f.cursor.col = 2;
        let u = tree_for(&f, CELL, None);
        // The trailing space is kept because the cursor is after it.
        assert_eq!(node(&u, line_id(0)).value(), Some("$ \n"));
        let sel = node(&u, TERMINAL_ID).text_selection().unwrap();
        assert_eq!(sel.anchor, sel.focus);
        assert_eq!(sel.focus.node, line_id(0));
        // Index 2 is the line break: the caret is at the end of the line.
        assert_eq!(sel.focus.character_index, 2);
    }

    #[test]
    fn the_caret_maps_columns_to_characters_across_wide_chars_and_clusters() {
        let mut f = Frame::blank(10, 1);
        f.cells[0].ch = '日';
        f.cells[1] = Cell {
            ch: '\0',
            attrs: Attrs(Attrs::WIDE_TAIL),
            ..Cell::default()
        };
        f.clusters.push("e\u{301}".into());
        f.cells[2] = Cell {
            ch: 'e',
            cluster: 1,
            ..Cell::default()
        };
        f.cells[3].ch = 'x';
        f.cursor.col = 3;
        let lines = all_lines(&f);
        assert_eq!(lines[0].text, "日e\u{301}x");
        assert_eq!(
            lines[0].chars,
            vec![
                LineChar {
                    col: 0,
                    cols: 2,
                    len: 3
                },
                LineChar {
                    col: 2,
                    cols: 1,
                    len: 3
                },
                LineChar {
                    col: 3,
                    cols: 1,
                    len: 1
                },
            ]
        );
        assert_eq!(lines[0].char_index(0), 0);
        assert_eq!(lines[0].char_index(1), 0, "a wide tail maps to its head");
        assert_eq!(lines[0].char_index(2), 1);
        assert_eq!(lines[0].char_index(3), 2);
        assert_eq!(lines[0].char_index(9), 3, "past the text: end");
        let u = tree_for(&f, CELL, None);
        let r0 = node(&u, line_id(0));
        assert_eq!(r0.character_lengths(), &[3, 3, 1]);
        assert_eq!(r0.character_widths(), Some(&[20.0f32, 10.0, 10.0][..]));
        assert_eq!(
            node(&u, TERMINAL_ID)
                .text_selection()
                .unwrap()
                .focus
                .character_index,
            2
        );
    }

    #[test]
    fn concealed_text_is_not_exposed() {
        let mut f = frame_of(&["pw: secret"], 12);
        for c in 4..10 {
            f.cells[c].attrs = Attrs(Attrs::HIDDEN);
        }
        f.cursor.col = 0;
        let u = tree_for(&f, CELL, None);
        assert_eq!(node(&u, line_id(0)).value(), Some("pw:"));
    }

    #[test]
    fn a_mouse_selection_becomes_the_text_selection_across_rows() {
        let f = frame_of(&["hello world", "second line"], 12);
        let sel = Selection {
            start: (0, 6),
            end: (1, 5),
            block: false,
        };
        let u = tree_for(&f, CELL, Some(&sel));
        let ts = node(&u, TERMINAL_ID).text_selection().unwrap();
        assert_eq!(
            ts.anchor,
            TextPosition {
                node: line_id(0),
                character_index: 6
            }
        );
        assert_eq!(
            ts.focus,
            TextPosition {
                node: line_id(1),
                character_index: 6
            }
        );
        // Dragged backwards: anchor after the start cell, focus on the end.
        let back = Selection {
            start: (1, 5),
            end: (0, 6),
            block: false,
        };
        let u = tree_for(&f, CELL, Some(&back));
        let ts = node(&u, TERMINAL_ID).text_selection().unwrap();
        assert_eq!(ts.anchor.character_index, 6);
        assert_eq!(ts.anchor.node, line_id(1));
        assert_eq!(ts.focus.character_index, 6);
        assert_eq!(ts.focus.node, line_id(0));
    }

    #[test]
    fn an_unchanged_frame_produces_no_update() {
        let f = frame_of(&["a", "b"], 5);
        let mut t = A11yTree::new();
        let first = t.update(&f, CELL, None).expect("first update is full");
        assert!(first.tree.is_some());
        assert_eq!(first.nodes.len(), 4);
        assert!(t.update(&f, CELL, None).is_none());
    }

    #[test]
    fn a_changed_row_sends_only_that_row() {
        let mut f = frame_of(&["one", "two", "three"], 8);
        f.cursor.row = 1;
        f.cursor.col = 3;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        // Typing on the cursor row: only that row changes (the caret moves too).
        f.cells[8 + 3].ch = 'x';
        f.cursor.col = 4;
        let u = t.update(&f, CELL, None).unwrap();
        assert_eq!(ids(&u), vec![TERMINAL_ID, line_id(1)]);
        assert!(u.tree.is_none());
        assert_eq!(u.focus, TERMINAL_ID);
        assert_eq!(node(&u, line_id(1)).value(), Some("twox\n"));
    }

    #[test]
    fn a_caret_move_sends_only_the_terminal_node() {
        let mut f = frame_of(&["abc", "def"], 5);
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        f.cursor.col = 2;
        let u = t.update(&f, CELL, None).unwrap();
        assert_eq!(ids(&u), vec![TERMINAL_ID]);
        let ts = node(&u, TERMINAL_ID).text_selection().unwrap();
        assert_eq!(ts.focus.character_index, 2);
    }

    #[test]
    fn output_below_the_prompt_is_announced_and_the_new_prompt_is_not() {
        // `ls` typed on row 0; it prints one line and a new prompt follows.
        let mut f = frame_of(&["$ ls", "", ""], 12);
        f.cursor.col = 4;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let mut g = frame_of(&["$ ls", "a.txt", "$ "], 12);
        g.cursor.row = 2;
        g.cursor.col = 2;
        let u = t.update(&g, CELL, None).unwrap();
        let root = node(&u, ROOT_ID);
        assert_eq!(root.children().len(), 2);
        let ann = node(&u, root.children()[1]);
        assert_eq!(ann.role(), Role::Label);
        assert_eq!(ann.live(), Some(Live::Polite));
        assert_eq!(ann.value(), Some("a.txt"));
    }

    #[test]
    fn output_that_scrolls_the_screen_announces_only_the_new_lines() {
        let mut f = frame_of(&["old", "$ ls", "$ "], 12);
        f.cursor.row = 2;
        f.cursor.col = 2;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        // Scrolled up by one: "$ ls" moved to row 0, output on row 1, and a
        // new prompt (equal to the old one) on the last row.
        let mut g = frame_of(&["$ ls", "a.txt", "$ "], 12);
        g.cursor.row = 2;
        g.cursor.col = 2;
        let u = t.update(&g, CELL, None).unwrap();
        let root = node(&u, ROOT_ID);
        assert_eq!(node(&u, root.children()[1]).value(), Some("a.txt"));
    }

    #[test]
    fn enter_on_an_empty_prompt_announces_nothing() {
        // In place: the old prompt loses its trailing space when the cursor
        // leaves it; that is not output.
        let mut f = frame_of(&["$ ", "", ""], 6);
        f.cursor.col = 2;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let mut g = frame_of(&["$ ", "$ ", ""], 6);
        g.cursor.row = 1;
        g.cursor.col = 2;
        let u = t.update(&g, CELL, None).unwrap();
        assert!(!u.nodes.iter().any(|(i, _)| *i == ROOT_ID));
        // At the bottom: the screen scrolls by one.
        let mut f = frame_of(&["a", "b", "$ "], 6);
        f.cursor.row = 2;
        f.cursor.col = 2;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let mut g = frame_of(&["b", "$ ", "$ "], 6);
        g.cursor.row = 2;
        g.cursor.col = 2;
        let u = t.update(&g, CELL, None).unwrap();
        assert!(!u.nodes.iter().any(|(i, _)| *i == ROOT_ID));
    }

    #[test]
    fn identical_output_twice_is_announced_twice_with_a_new_node() {
        let mut f = frame_of(&["", "", "$ "], 6);
        f.cursor.row = 2;
        f.cursor.col = 2;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let mut g = frame_of(&["ok", "", "$ "], 6);
        g.cursor = f.cursor;
        let u1 = t.update(&g, CELL, None).unwrap();
        let a1 = node(&u1, ROOT_ID).children()[1];
        t.update(&f, CELL, None);
        let u2 = t.update(&g, CELL, None).unwrap();
        let a2 = node(&u2, ROOT_ID).children()[1];
        assert_ne!(a1, a2);
        assert_eq!(node(&u2, a2).value(), Some("ok"));
        // The previous announcement is dropped from the root, not re-sent.
        assert_eq!(node(&u2, ROOT_ID).children(), &[TERMINAL_ID, a2]);
        assert!(!u2.nodes.iter().any(|(i, _)| *i == a1));
    }

    #[test]
    fn nothing_is_announced_on_the_alternate_screen_or_at_a_switch() {
        let mut f = frame_of(&["", "", ""], 6);
        f.alt_screen = true;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let mut g = frame_of(&["top 1", "top 2", ""], 6);
        g.alt_screen = true;
        let u = t.update(&g, CELL, None).unwrap();
        assert!(!u.nodes.iter().any(|(i, _)| *i == ROOT_ID));
        let mut h = frame_of(&["back", "", ""], 6);
        h.alt_screen = false;
        let u = t.update(&h, CELL, None).unwrap();
        assert!(!u.nodes.iter().any(|(i, _)| *i == ROOT_ID));
    }

    #[test]
    fn a_resize_resends_the_terminal_with_its_new_children() {
        let f = frame_of(&["a", "b", "c"], 5);
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let g = frame_of(&["a", "b"], 5);
        let u = t.update(&g, CELL, None).unwrap();
        let term = node(&u, TERMINAL_ID);
        assert_eq!(term.children(), &[line_id(0), line_id(1)]);
        // Row 1 became the last row: its line break goes.
        assert_eq!(node(&u, line_id(1)).value(), Some("b"));
        assert!(!u.nodes.iter().any(|(i, _)| *i == line_id(2)));
        assert!(!u.nodes.iter().any(|(i, _)| *i == ROOT_ID));
    }

    #[test]
    fn a_zoom_moves_every_row() {
        let f = frame_of(&["a", "b"], 5);
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let big = CellPx {
            width: 20,
            height: 40,
        };
        let u = t.update(&f, big, None).unwrap();
        assert_eq!(node(&u, line_id(1)).bounds().unwrap().y0, 40.0);
        assert_eq!(ids(&u), vec![TERMINAL_ID, line_id(0), line_id(1)]);
    }

    #[test]
    fn a_title_change_sends_only_the_root() {
        let mut f = frame_of(&["a"], 5);
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        f.title = Some("vim".into());
        let u = t.update(&f, CELL, None).unwrap();
        assert_eq!(ids(&u), vec![ROOT_ID]);
        assert_eq!(node(&u, ROOT_ID).label(), Some("vim"));
    }

    #[test]
    fn after_deactivation_the_next_update_is_a_full_tree() {
        let f = frame_of(&["a"], 5);
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        t.deactivate();
        let u = t.update(&f, CELL, None).unwrap();
        assert!(u.tree.is_some());
    }

    #[test]
    fn text_positions_map_back_to_cells() {
        let mut f = Frame::blank(6, 2);
        f.cells[0].ch = '日';
        f.cells[1] = Cell {
            ch: '\0',
            attrs: Attrs(Attrs::WIDE_TAIL),
            ..Cell::default()
        };
        f.cells[2].ch = 'a';
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        let pos = |i| TextPosition {
            node: line_id(0),
            character_index: i,
        };
        assert_eq!(t.cell_for(&pos(1)), Some((0, 2)));
        assert_eq!(t.cell_for(&pos(2)), Some((0, 3)));
        assert_eq!(
            t.cell_for(&TextPosition {
                node: TERMINAL_ID,
                character_index: 0
            }),
            None
        );
    }

    #[test]
    fn new_output_keeps_the_newest_lines_within_the_limits() {
        let old: Vec<LineText> = (0..30).map(|_| LineText::default()).collect();
        let new: Vec<LineText> = (0..30)
            .map(|i| LineText {
                text: format!("line {i}"),
                chars: Vec::new(),
            })
            .collect();
        let out = new_output(&old, &new, 29);
        assert_eq!(out.len(), MAX_ANNOUNCE_LINES);
        assert_eq!(out.last().unwrap(), "line 28");
    }

    fn scrolled(offset: usize, total: usize) -> UiExtras {
        UiExtras {
            scrollback: Some((offset, total)),
        }
    }

    #[test]
    fn scrolled_back_adds_a_polite_status_node_under_the_root() {
        let f = frame_of(&["a", "b"], 5);
        let mut t = A11yTree::new();
        t.set_extras(scrolled(12, 340));
        let u = t.full(&f, CELL, None);
        let root = node(&u, ROOT_ID);
        assert_eq!(root.children(), &[TERMINAL_ID, STATUS_ID]);
        let status = node(&u, STATUS_ID);
        assert_eq!(status.role(), Role::Label);
        assert_eq!(status.value(), Some("Scrolled back 12 of 340 lines"));
        assert_eq!(status.live(), Some(Live::Polite));
        // Without extras the tree has no status node.
        let plain = tree_for(&f, CELL, None);
        assert!(!plain.nodes.iter().any(|(i, _)| *i == STATUS_ID));
    }

    #[test]
    fn moving_through_history_updates_the_status_and_is_not_announced_as_output() {
        let mut f = frame_of(&["one", "two", "three"], 8);
        f.cursor.row = 2;
        let mut t = A11yTree::new();
        t.full(&f, CELL, None);
        // Scroll back: different rows appear, the status node is added, and
        // nothing is announced.
        let mut g = frame_of(&["old a", "old b", "one"], 8);
        g.cursor.row = 2;
        g.scrolled_back = true;
        g.viewport_offset = 2;
        t.set_extras(scrolled(2, 10));
        let u = t.update(&g, CELL, None).unwrap();
        assert!(u.nodes.iter().any(|(i, _)| *i == STATUS_ID));
        assert!(
            u.nodes.iter().all(|(i, _)| i.0 < ANNOUNCE_BASE),
            "no announcement node"
        );
        assert_eq!(node(&u, line_id(0)).value(), Some("old a\n"));
        // Further up: the status text changes.
        let mut h = frame_of(&["older", "old a", "old b"], 8);
        h.cursor.row = 2;
        t.set_extras(scrolled(3, 10));
        let u = t.update(&h, CELL, None).unwrap();
        assert_eq!(
            node(&u, STATUS_ID).value(),
            Some("Scrolled back 3 of 10 lines")
        );
        // Back to live: the status node leaves the root's children.
        let mut live = frame_of(&["one", "two", "three"], 8);
        live.cursor.row = 2;
        t.set_extras(UiExtras::default());
        let u = t.update(&live, CELL, None).unwrap();
        assert_eq!(node(&u, ROOT_ID).children(), &[TERMINAL_ID]);
        assert!(!u.nodes.iter().any(|(i, _)| *i == STATUS_ID));
    }

    #[test]
    fn an_unchanged_scrolled_state_produces_no_update() {
        let f = frame_of(&["a", "b"], 5);
        let mut t = A11yTree::new();
        t.set_extras(scrolled(1, 5));
        t.full(&f, CELL, None);
        t.set_extras(scrolled(1, 5));
        assert!(t.update(&f, CELL, None).is_none());
    }
}
