//! Colour resolution: the frame's `Color` against a theme, with inverse, dim and
//! hidden applied. Pure arithmetic, no GPU.

use crate::frame::{Attrs, Cell, Color};

pub type Rgb = [u8; 3];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub fg: Rgb,
    pub bg: Rgb,
    pub cursor: Rgb,
    pub selection_bg: Rgb,
    /// `None` keeps each cell's own foreground inside a selection.
    pub selection_fg: Option<Rgb>,
    /// The 16 ANSI colours.
    pub palette: [Rgb; 16],
    /// Bold text in colours 0..=7 draws as 8..=15.
    pub bold_is_bright: bool,
}

impl Default for Theme {
    fn default() -> Self {
        Theme {
            fg: [0xe5, 0xe5, 0xe5],
            bg: [0x1e, 0x1e, 0x1e],
            cursor: [0xff, 0xff, 0xff],
            selection_bg: [0x26, 0x4f, 0x78],
            selection_fg: None,
            palette: [
                [0x00, 0x00, 0x00],
                [0xcd, 0x31, 0x31],
                [0x0d, 0xbc, 0x79],
                [0xe5, 0xe5, 0x10],
                [0x24, 0x72, 0xc8],
                [0xbc, 0x3f, 0xbc],
                [0x11, 0xa8, 0xcd],
                [0xe5, 0xe5, 0xe5],
                [0x66, 0x66, 0x66],
                [0xf1, 0x4c, 0x4c],
                [0x23, 0xd1, 0x8b],
                [0xf5, 0xf5, 0x43],
                [0x3b, 0x8e, 0xea],
                [0xd6, 0x70, 0xd6],
                [0x29, 0xb8, 0xdb],
                [0xff, 0xff, 0xff],
            ],
            bold_is_bright: false,
        }
    }
}

impl Theme {
    /// xterm 256-colour table: 16 ANSI, a 6x6x6 cube, then 24 greys.
    pub fn indexed(&self, i: u8) -> Rgb {
        match i {
            0..=15 => self.palette[i as usize],
            16..=231 => {
                const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
                let n = (i - 16) as usize;
                [LEVELS[n / 36], LEVELS[(n / 6) % 6], LEVELS[n % 6]]
            }
            232..=255 => {
                let v = 8 + 10 * (i - 232);
                [v, v, v]
            }
        }
    }

    fn resolve(&self, c: Color, default: Rgb) -> Rgb {
        match c {
            Color::Default => default,
            Color::Indexed(i) => self.indexed(i),
            Color::Rgb(r, g, b) => [r, g, b],
        }
    }
}

/// Mixes `a` toward `b`: `num/den` of `a`, the rest of `b`.
fn mix(a: Rgb, b: Rgb, num: u32, den: u32) -> Rgb {
    let f = |x: u8, y: u8| ((x as u32 * num + y as u32 * (den - num) + den / 2) / den) as u8;
    [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])]
}

/// What a cell draws as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resolved {
    pub fg: Rgb,
    pub bg: Rgb,
    /// False when the background is the theme background, so no rectangle is
    /// needed (the target is cleared to it).
    pub bg_drawn: bool,
}

/// Resolves a cell: bold-bright, inverse (swap), dim (two thirds toward the
/// background) and hidden (foreground becomes the background).
pub fn resolve_cell(theme: &Theme, cell: &Cell) -> Resolved {
    let attrs: Attrs = cell.attrs;
    let mut fg_color = cell.fg;
    if theme.bold_is_bright && attrs.has(Attrs::BOLD) {
        if let Color::Indexed(i @ 0..=7) = fg_color {
            fg_color = Color::Indexed(i + 8);
        }
    }
    let mut fg = theme.resolve(fg_color, theme.fg);
    let mut bg = theme.resolve(cell.bg, theme.bg);
    let mut bg_drawn = cell.bg != Color::Default;
    if attrs.has(Attrs::INVERSE) {
        std::mem::swap(&mut fg, &mut bg);
        bg_drawn = true;
    }
    if attrs.has(Attrs::DIM) {
        fg = mix(fg, bg, 2, 3);
    }
    if attrs.has(Attrs::HIDDEN) {
        fg = bg;
    }
    Resolved { fg, bg, bg_drawn }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell(fg: Color, bg: Color, attrs: u16) -> Cell {
        Cell {
            fg,
            bg,
            attrs: Attrs(attrs),
            ..Cell::default()
        }
    }

    #[test]
    fn default_colours_come_from_the_theme_and_draw_no_background() {
        let t = Theme::default();
        let r = resolve_cell(&t, &Cell::default());
        assert_eq!(r.fg, t.fg);
        assert_eq!(r.bg, t.bg);
        assert!(!r.bg_drawn);
    }

    #[test]
    fn indexed_covers_palette_cube_and_greys() {
        let t = Theme::default();
        assert_eq!(t.indexed(1), t.palette[1]);
        assert_eq!(t.indexed(16), [0, 0, 0]);
        assert_eq!(t.indexed(21), [0, 0, 255]);
        assert_eq!(t.indexed(196), [255, 0, 0]);
        assert_eq!(t.indexed(231), [255, 255, 255]);
        assert_eq!(t.indexed(232), [8, 8, 8]);
        assert_eq!(t.indexed(255), [238, 238, 238]);
    }

    #[test]
    fn truecolour_passes_through() {
        let t = Theme::default();
        let r = resolve_cell(&t, &cell(Color::Rgb(1, 2, 3), Color::Rgb(4, 5, 6), 0));
        assert_eq!((r.fg, r.bg, r.bg_drawn), ([1, 2, 3], [4, 5, 6], true));
    }

    #[test]
    fn inverse_swaps_and_forces_a_background() {
        let t = Theme::default();
        let r = resolve_cell(&t, &cell(Color::Default, Color::Default, Attrs::INVERSE));
        assert_eq!((r.fg, r.bg), (t.bg, t.fg));
        assert!(r.bg_drawn);
    }

    #[test]
    fn dim_moves_the_foreground_toward_the_background() {
        let t = Theme::default();
        let plain = resolve_cell(&t, &cell(Color::Rgb(255, 255, 255), Color::Rgb(0, 0, 0), 0));
        let dim = resolve_cell(
            &t,
            &cell(Color::Rgb(255, 255, 255), Color::Rgb(0, 0, 0), Attrs::DIM),
        );
        assert_eq!(plain.fg, [255, 255, 255]);
        assert_eq!(dim.fg, [170, 170, 170]);
    }

    #[test]
    fn hidden_text_takes_the_background() {
        let t = Theme::default();
        let r = resolve_cell(
            &t,
            &cell(Color::Rgb(9, 9, 9), Color::Rgb(7, 7, 7), Attrs::HIDDEN),
        );
        assert_eq!(r.fg, r.bg);
    }

    #[test]
    fn bold_is_bright_only_when_asked_and_only_for_low_colours() {
        let mut t = Theme::default();
        let c = cell(Color::Indexed(1), Color::Default, Attrs::BOLD);
        assert_eq!(resolve_cell(&t, &c).fg, t.palette[1]);
        t.bold_is_bright = true;
        assert_eq!(resolve_cell(&t, &c).fg, t.palette[9]);
        let high = cell(Color::Indexed(9), Color::Default, Attrs::BOLD);
        assert_eq!(resolve_cell(&t, &high).fg, t.palette[9]);
    }
}
