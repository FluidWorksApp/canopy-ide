//! Pixel geometry derived from the cell layout: cell rectangles, underline and
//! strike lines, cursor shapes and selection ranges. All integers in physical
//! pixels; nothing here allocates or touches a GPU.

use crate::frame::CursorShape;
use crate::metrics::CellLayout;

/// A pixel rectangle. Origin is top-left of the surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PxRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// The rectangle of `cols` consecutive cells starting at (`row`, `col`).
pub fn cell_rect(l: &CellLayout, row: u16, col: u16, cols: u16) -> PxRect {
    PxRect {
        x: col as i32 * l.width as i32,
        y: row as i32 * l.height as i32,
        w: cols as u32 * l.width,
        h: l.height,
    }
}

pub fn underline_rect(l: &CellLayout, row: u16, col: u16, cols: u16) -> PxRect {
    let c = cell_rect(l, row, col, cols);
    PxRect {
        y: c.y + l.underline_top as i32,
        h: l.underline_thickness,
        ..c
    }
}

pub fn strike_rect(l: &CellLayout, row: u16, col: u16, cols: u16) -> PxRect {
    let c = cell_rect(l, row, col, cols);
    PxRect {
        y: c.y + l.strike_top as i32,
        h: l.strike_thickness,
        ..c
    }
}

/// The part of the cell the cursor paints. A block covers the cell (and both
/// halves of a wide character); an underline sits at the bottom of the cell; a
/// bar is a left-edge strip at least one pixel wide.
pub fn cursor_rect(l: &CellLayout, row: u16, col: u16, cols: u16, shape: CursorShape) -> PxRect {
    let c = cell_rect(l, row, col, cols);
    match shape {
        CursorShape::Block => c,
        CursorShape::Underline => {
            let t = l.underline_thickness.max(l.height / 8).max(1).min(l.height);
            PxRect {
                y: c.y + (l.height - t) as i32,
                h: t,
                ..c
            }
        }
        CursorShape::Bar => PxRect {
            w: (l.width / 8).max(1).min(l.width),
            ..c
        },
    }
}

/// A selection between two cells, as the user dragged it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Selection {
    pub start: (u16, u16),
    pub end: (u16, u16),
    /// Rectangular (block) selection instead of flowing text.
    pub block: bool,
}

impl Selection {
    /// Start and end in reading order, as (row, col).
    fn ordered(&self) -> ((u16, u16), (u16, u16)) {
        if self.start <= self.end {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        }
    }

    pub fn rows(&self) -> (u16, u16) {
        let (a, b) = self.ordered();
        if self.block {
            (self.start.0.min(self.end.0), self.start.0.max(self.end.0))
        } else {
            (a.0, b.0)
        }
    }

    /// The selected columns on `row` as `[start, end)`, or `None`.
    pub fn cols_on(&self, row: u16, cols: u16) -> Option<(u16, u16)> {
        let (first, last) = self.rows();
        if row < first || row > last || cols == 0 {
            return None;
        }
        if self.block {
            let a = self.start.1.min(self.end.1);
            let b = self.start.1.max(self.end.1);
            return Some((a.min(cols), (b + 1).min(cols))).filter(|(s, e)| s < e);
        }
        let (a, b) = self.ordered();
        let start = if row == a.0 { a.1 } else { 0 };
        let end = if row == b.0 { b.1 + 1 } else { cols };
        Some((start.min(cols), end.min(cols))).filter(|(s, e)| s < e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout() -> CellLayout {
        CellLayout {
            width: 8,
            height: 16,
            baseline: 12,
            underline_top: 14,
            underline_thickness: 1,
            strike_top: 8,
            strike_thickness: 1,
            font_px: 14,
        }
    }

    #[test]
    fn cells_tile_on_integer_boundaries() {
        let l = layout();
        let a = cell_rect(&l, 1, 2, 1);
        let b = cell_rect(&l, 1, 3, 1);
        assert_eq!(a.x + a.w as i32, b.x);
        assert_eq!((a.x, a.y, a.w, a.h), (16, 16, 8, 16));
        assert_eq!(cell_rect(&l, 0, 0, 2).w, 16, "a wide char spans two cells");
    }

    #[test]
    fn underline_and_strike_sit_inside_their_cell() {
        let l = layout();
        let c = cell_rect(&l, 3, 4, 1);
        for r in [underline_rect(&l, 3, 4, 1), strike_rect(&l, 3, 4, 1)] {
            assert!(r.y >= c.y && r.y + r.h as i32 <= c.y + c.h as i32);
            assert_eq!((r.x, r.w), (c.x, c.w));
        }
        assert_eq!(underline_rect(&l, 0, 0, 1).y, 14);
    }

    #[test]
    fn cursor_shapes() {
        let l = layout();
        let c = cell_rect(&l, 0, 0, 1);
        assert_eq!(cursor_rect(&l, 0, 0, 1, CursorShape::Block), c);
        let u = cursor_rect(&l, 0, 0, 1, CursorShape::Underline);
        assert_eq!(u.y + u.h as i32, c.y + c.h as i32, "flush with the bottom");
        assert!(u.h >= 1 && u.w == c.w);
        let b = cursor_rect(&l, 0, 0, 1, CursorShape::Bar);
        assert_eq!((b.x, b.h), (c.x, c.h));
        assert!(b.w >= 1 && b.w < c.w);
    }

    #[test]
    fn a_wide_cursor_covers_both_halves() {
        let l = layout();
        assert_eq!(cursor_rect(&l, 0, 0, 2, CursorShape::Block).w, 16);
    }

    #[test]
    fn linear_selection_flows_across_rows() {
        let s = Selection {
            start: (1, 5),
            end: (3, 2),
            block: false,
        };
        assert_eq!(s.cols_on(0, 10), None);
        assert_eq!(s.cols_on(1, 10), Some((5, 10)));
        assert_eq!(s.cols_on(2, 10), Some((0, 10)));
        assert_eq!(s.cols_on(3, 10), Some((0, 3)));
        assert_eq!(s.cols_on(4, 10), None);
    }

    #[test]
    fn backwards_drag_selects_the_same_cells() {
        let fwd = Selection {
            start: (1, 2),
            end: (2, 4),
            block: false,
        };
        let back = Selection {
            start: fwd.end,
            end: fwd.start,
            block: false,
        };
        for row in 0..4 {
            assert_eq!(fwd.cols_on(row, 10), back.cols_on(row, 10));
        }
    }

    #[test]
    fn block_selection_is_a_rectangle_whichever_way_it_is_dragged() {
        let s = Selection {
            start: (3, 6),
            end: (1, 2),
            block: true,
        };
        for row in 1..=3 {
            assert_eq!(s.cols_on(row, 10), Some((2, 7)));
        }
        assert_eq!(s.cols_on(0, 10), None);
        assert_eq!(s.cols_on(4, 10), None);
    }

    #[test]
    fn selection_is_clipped_to_the_grid() {
        let s = Selection {
            start: (0, 8),
            end: (0, 40),
            block: false,
        };
        assert_eq!(s.cols_on(0, 10), Some((8, 10)));
        let off = Selection {
            start: (0, 20),
            end: (0, 30),
            block: false,
        };
        assert_eq!(off.cols_on(0, 10), None);
    }
}
