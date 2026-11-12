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

    pub fn has(self, flag: u16) -> bool {
        self.0 & flag != 0
    }
}

/// How a cell's underline is drawn. `Attrs::UNDERLINE` is set for every style
/// but `None`, so a consumer that only knows a single underline keeps working.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum UnderlineStyle {
    #[default]
    None,
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
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
    /// The underline's shape (SGR `4:n`, `21`). `None` exactly when
    /// `attrs` has no `UNDERLINE`.
    pub underline: UnderlineStyle,
    /// The underline's own colour (SGR 58); `Default` draws it in the
    /// foreground colour. The engine keeps it on the pen even while there is no
    /// underline, so it can be set without one; it only draws with one.
    pub underline_color: Color,
}

impl Default for Cell {
    fn default() -> Self {
        Cell {
            ch: ' ',
            cluster: 0,
            fg: Color::Default,
            bg: Color::Default,
            attrs: Attrs(0),
            underline: UnderlineStyle::None,
            underline_color: Color::Default,
        }
    }
}

/// Whether opening an OSC 8 link is reasonable without asking: `http`, `https`
/// and `mailto` only. The URI comes from whatever printed to the terminal, so
/// `file:`, `javascript:`, custom schemes and anything else need a prompt or a
/// refusal, decided by the application. Pair it with `Screen::hyperlink_at`.
pub fn is_safe_link(uri: &str) -> bool {
    let Some((scheme, rest)) = uri.split_once(':') else {
        return false;
    };
    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" => rest.starts_with("//") && rest.len() > 2,
        "mailto" => !rest.is_empty(),
        _ => false,
    }
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
        assert_eq!(Cell::default().underline, UnderlineStyle::None);
        assert_eq!(Cell::default().underline_color, Color::Default);
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

    #[test]
    fn only_web_and_mail_links_are_safe_to_open_unasked() {
        assert!(is_safe_link("https://example.com/x"));
        assert!(is_safe_link("HTTP://example.com"));
        assert!(is_safe_link("mailto:someone@example.com"));
        assert!(!is_safe_link("file:///etc/passwd"));
        assert!(!is_safe_link("javascript:alert(1)"));
        assert!(!is_safe_link("ssh://host"));
        assert!(!is_safe_link("https:"));
        assert!(!is_safe_link("https://"));
        assert!(!is_safe_link("example.com"));
        assert!(!is_safe_link(""));
    }
}
