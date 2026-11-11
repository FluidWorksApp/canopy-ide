/// A colour as the terminal specified it. The renderer resolves `Indexed`
/// against its palette and `Default` against the theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// Cell attributes. A plain bit set so a frame stays cheap to copy and compare.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Attrs(pub u16);

impl Attrs {
    pub const BOLD: u16 = 1;
    pub const ITALIC: u16 = 1 << 1;
    pub const UNDERLINE: u16 = 1 << 2;
    pub const INVERSE: u16 = 1 << 3;
    pub const STRIKE: u16 = 1 << 4;
    pub const DIM: u16 = 1 << 5;
    pub const HIDDEN: u16 = 1 << 6;
    /// The right half of a double-width character; `Cell::ch` is `'\0'`.
    pub const WIDE_TAIL: u16 = 1 << 7;
    /// Underline styles. `UNDERLINE` is set for every style, so a renderer
    /// that ignores these draws a single line; with none of these set the
    /// underline is single.
    pub const UNDERLINE_DOUBLE: u16 = 1 << 8;
    pub const UNDERLINE_CURLY: u16 = 1 << 9;
    pub const UNDERLINE_DOTTED: u16 = 1 << 10;
    pub const UNDERLINE_DASHED: u16 = 1 << 11;
    /// All the underline style bits.
    pub const UNDERLINE_STYLES: u16 = Self::UNDERLINE_DOUBLE
        | Self::UNDERLINE_CURLY
        | Self::UNDERLINE_DOTTED
        | Self::UNDERLINE_DASHED;

    pub fn has(self, flag: u16) -> bool {
        self.0 & flag != 0
    }
}

/// One grid position, fixed size and `Copy` so a frame is a flat buffer with no
/// allocation per cell. `ch` is the first scalar; a grapheme cluster with more
/// scalars sets `cluster` to a non-zero index into `Frame::clusters` (the full
/// text), and `ch` stays the first scalar for renderers that ignore clusters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub ch: char,
    pub cluster: u32,
    pub fg: Color,
    pub bg: Color,
    pub attrs: Attrs,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            ch: ' ',
            cluster: 0,
            fg: Color::Default,
            bg: Color::Default,
            attrs: Attrs(0),
        }
    }
}

/// An OSC 8 hyperlink as the program set it. Cells name one by index into
/// [`Frame::links`] through [`Frame::link_ids`].
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Link {
    /// The program's `id=` (or one the emulator made up): cells with the same
    /// id belong to the same link, even on different rows.
    pub id: String,
    pub uri: String,
}

impl Link {
    /// Whether opening this link is reasonable without asking: `http`,
    /// `https` and `mailto` only. The URI comes from whatever printed to the
    /// terminal, so `file:`, custom schemes and anything else need a prompt or
    /// a refusal, decided by the application.
    pub fn is_safe_scheme(&self) -> bool {
        let Some((scheme, rest)) = self.uri.split_once(':') else {
            return false;
        };
        let scheme = scheme.to_ascii_lowercase();
        match scheme.as_str() {
            "http" | "https" => rest.starts_with("//") && rest.len() > 2,
            "mailto" => !rest.is_empty(),
            _ => false,
        }
    }
}

/// The colour of one cell's underline (SGR 58), where it is not the text's.
/// Cells without an entry underline in the foreground colour.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnderlineColor {
    pub row: u16,
    pub col: u16,
    pub color: Color,
}

/// An OSC 133 mark on a visible row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowMark {
    pub row: u16,
    pub kind: crate::event::SemanticMark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CursorShape {
    #[default]
    Block,
    Underline,
    Bar,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Cursor {
    pub row: u16,
    pub col: u16,
    pub shape: CursorShape,
    pub visible: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum MouseMode {
    #[default]
    Off,
    /// Button presses only (X10).
    Press,
    /// Press and release (1000).
    Normal,
    /// Motion while a button is held (1002).
    Drag,
    /// All motion (1003).
    Any,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum MouseEncoding {
    #[default]
    Default,
    Utf8,
    Sgr,
}

/// What the program has asked of input and output. Input encoding needs these,
/// and so does an attach snapshot: a client that joins mid-session must be put
/// in the modes the program already set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Modes {
    pub mouse: MouseMode,
    pub mouse_encoding: MouseEncoding,
    pub bracketed_paste: bool,
    /// DECCKM: arrow keys send application sequences.
    pub app_cursor_keys: bool,
    /// DECKPAM: keypad sends application sequences.
    pub app_keypad: bool,
    pub focus_events: bool,
    /// Synchronized output (2026): the program is mid-update, hold the frame.
    pub sync_output: bool,
    /// Kitty keyboard protocol flags currently pushed (0 = legacy).
    pub kitty_keyboard: u8,
}

/// Rows that changed, as inclusive ranges, relative to a frame the consumer
/// names. Consumers (the IDE, the CLI, a window) each remember their own last
/// sequence, so damage is never "since whoever looked last".
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Damage {
    /// The frame sequence this damage is relative to. `0` means "no baseline".
    pub since: u64,
    /// Redraw everything (resize, alt-screen switch, snapshot attach, or a
    /// `since` the producer no longer remembers).
    pub full: bool,
    pub rows: Vec<(u16, u16)>,
}

/// A complete view of the visible screen. Scrollback is requested separately.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Frame {
    /// Increases by at least one with every change; `Damage::since` refers to it.
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    /// Row-major, `cols * rows` cells.
    pub cells: Vec<Cell>,
    /// Text of multi-scalar clusters; index 0 is unused so `Cell::cluster == 0`
    /// means "none".
    pub clusters: Vec<String>,
    pub cursor: Cursor,
    pub modes: Modes,
    pub damage: Damage,
    /// True on the alternate screen (full-screen programs), where scrollback
    /// does not apply.
    pub alt_screen: bool,
    /// Window title set by the program, if any.
    pub title: Option<String>,
    /// Hyperlinks (OSC 8) on the visible cells; index 0 is unused so a link id
    /// of 0 means "none". Empty when no visible cell has a link. Bounded: see
    /// `screen::MAX_FRAME_LINKS` and `screen::MAX_URI_BYTES`.
    pub links: Vec<Link>,
    /// Per cell, row-major: an index into `links`, or 0. Empty (not
    /// `cols * rows` zeros) when no visible cell has a link.
    pub link_ids: Vec<u16>,
    /// Underline colours, sorted by row then column. Empty when none is set.
    pub underline_colors: Vec<UnderlineColor>,
    /// OSC 133 marks on visible rows, top to bottom. Empty on the alternate
    /// screen. `Screen::marks` has the ones in scrollback too.
    pub marks: Vec<RowMark>,
}

impl Frame {
    pub fn blank(cols: u16, rows: u16) -> Self {
        Frame {
            cols,
            rows,
            cells: vec![Cell::default(); cols as usize * rows as usize],
            clusters: vec![String::new()],
            damage: Damage {
                since: 0,
                full: true,
                rows: Vec::new(),
            },
            ..Default::default()
        }
    }

    pub fn cell(&self, row: u16, col: u16) -> Option<&Cell> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        self.cells
            .get(row as usize * self.cols as usize + col as usize)
    }

    /// The hyperlink on a cell, if it has one.
    pub fn link_at(&self, row: u16, col: u16) -> Option<&Link> {
        if row >= self.rows || col >= self.cols {
            return None;
        }
        let id = *self
            .link_ids
            .get(row as usize * self.cols as usize + col as usize)?;
        if id == 0 {
            return None;
        }
        self.links.get(id as usize)
    }

    /// The colour of a cell's underline when it differs from the text colour.
    pub fn underline_color_at(&self, row: u16, col: u16) -> Option<Color> {
        self.underline_colors
            .binary_search_by_key(&(row, col), |u| (u.row, u.col))
            .ok()
            .map(|i| self.underline_colors[i].color)
    }

    /// The full text of a cell, following its cluster when it has one.
    pub fn text(&self, cell: &Cell) -> String {
        match self.clusters.get(cell.cluster as usize) {
            Some(text) if cell.cluster != 0 => text.clone(),
            _ => cell.ch.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_frame_is_sized_and_fully_damaged() {
        let f = Frame::blank(80, 24);
        assert_eq!(f.cells.len(), 80 * 24);
        assert!(f.damage.full);
        assert!(f.cell(23, 79).is_some());
        assert!(f.cell(24, 0).is_none());
        assert!(f.cell(0, 80).is_none());
    }

    #[test]
    fn attrs_report_their_flags() {
        let a = Attrs(Attrs::BOLD | Attrs::UNDERLINE);
        assert!(a.has(Attrs::BOLD) && a.has(Attrs::UNDERLINE));
        assert!(!a.has(Attrs::ITALIC));
    }

    #[test]
    fn a_cell_is_plain_data_with_no_heap_allocation() {
        fn assert_copy<T: Copy>() {}
        assert_copy::<Cell>();
        assert!(std::mem::size_of::<Cell>() <= 24);
    }

    #[test]
    fn link_and_underline_lookups_follow_the_side_tables() {
        let mut f = Frame::blank(3, 2);
        assert!(f.link_at(0, 0).is_none());
        f.links = vec![
            Link::default(),
            Link {
                id: "a".into(),
                uri: "https://example.com/".into(),
            },
        ];
        f.link_ids = vec![0, 1, 1, 0, 0, 0];
        assert_eq!(f.link_at(0, 1).unwrap().uri, "https://example.com/");
        assert!(f.link_at(0, 0).is_none());
        assert!(f.link_at(2, 0).is_none(), "outside the grid");
        f.underline_colors = vec![
            UnderlineColor {
                row: 0,
                col: 2,
                color: Color::Rgb(1, 2, 3),
            },
            UnderlineColor {
                row: 1,
                col: 0,
                color: Color::Indexed(4),
            },
        ];
        assert_eq!(f.underline_color_at(1, 0), Some(Color::Indexed(4)));
        assert_eq!(f.underline_color_at(0, 0), None);
    }

    #[test]
    fn only_web_and_mail_links_are_safe_to_open_unasked() {
        let link = |uri: &str| Link {
            id: String::new(),
            uri: uri.to_string(),
        };
        assert!(link("https://example.com/x").is_safe_scheme());
        assert!(link("HTTP://example.com").is_safe_scheme());
        assert!(link("mailto:someone@example.com").is_safe_scheme());
        assert!(!link("file:///etc/passwd").is_safe_scheme());
        assert!(!link("javascript:alert(1)").is_safe_scheme());
        assert!(!link("ssh://host").is_safe_scheme());
        assert!(!link("https:").is_safe_scheme());
        assert!(!link("example.com").is_safe_scheme());
    }

    #[test]
    fn a_cluster_cell_reads_its_full_text() {
        let mut f = Frame::blank(2, 1);
        f.clusters.push("e\u{301}".to_string());
        f.cells[0] = Cell {
            ch: 'e',
            cluster: 1,
            ..Cell::default()
        };
        assert_eq!(f.text(&f.cells[0]), "e\u{301}");
        assert_eq!(f.text(&f.cells[1]), " ");
    }
}
