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
    /// The right half of a double-width character; `Cell::text` is empty.
    pub const WIDE_TAIL: u16 = 1 << 7;

    pub fn has(self, flag: u16) -> bool {
        self.0 & flag != 0
    }
}

/// One grid position. `text` is a full grapheme cluster (one or more scalars),
/// empty for a blank cell or the tail of a wide character.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Cell {
    pub text: String,
    pub fg: Color,
    pub bg: Color,
    pub attrs: Attrs,
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

/// Rows that changed since the last frame the renderer saw, as inclusive ranges.
/// `full` means redraw everything (resize, alt-screen switch, a snapshot attach).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Damage {
    pub full: bool,
    pub rows: Vec<(u16, u16)>,
}

/// A complete view of the visible screen. Scrollback is requested separately.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Frame {
    pub cols: u16,
    pub rows: u16,
    /// Row-major, `cols * rows` cells.
    pub cells: Vec<Cell>,
    pub cursor: Cursor,
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
            damage: Damage {
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
}
