//! Pixels to cells: the window's surface size and the cell size give the grid,
//! a pointer position gives a cell, and the font size steps for zoom.
//!
//! Everything is in physical pixels, the unit the renderer's `CellLayout` uses
//! and the unit AccessKit and the surface use.
//!
//! The grid does not start at the surface's corner: it is inset by a padding on
//! every side (`padding_px`, a logical size times the window scale factor).
//! The grid's top-left, the *origin*, is `(pad, pad)` and is the one place
//! every consumer takes its offset from: the renderer's `set_origin`, the
//! pointer (`to_grid` before `cell_at`), the IME area (`PxRect::offset`) and
//! the AccessKit root transform. Rounding down to whole cells leaves a blank
//! remainder on the right and bottom, drawn in the terminal background.

/// One cell in physical pixels (from the renderer's `CellLayout`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellPx {
    pub width: u32,
    pub height: u32,
}

/// A rectangle in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PxRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl PxRect {
    /// The same rectangle moved by the grid's origin: grid-relative pixels to
    /// surface pixels.
    pub fn offset(self, origin: (u32, u32)) -> PxRect {
        PxRect {
            x: self.x + origin.0,
            y: self.y + origin.1,
            ..self
        }
    }
}

/// Default padding around the grid, in logical pixels.
pub const DEFAULT_PADDING_PX: f32 = 8.0;

/// Padding in physical pixels: the logical size times the scale factor, to a
/// whole pixel. Negative or non-finite input is no padding.
pub fn padding_px(logical: f32, scale: f32) -> u32 {
    let v = logical * scale;
    if v.is_finite() && v > 0.0 {
        v.round().min(u16::MAX as f32) as u32
    } else {
        0
    }
}

/// The grid's top-left corner on the surface for a padding on every side.
pub fn grid_origin(pad: u32) -> (u32, u32) {
    (pad, pad)
}

/// The surface size that holds `cols` x `rows` cells inside `pad` on every
/// side: what the window asks for when it opens.
pub fn surface_for_grid(cell: CellPx, cols: u16, rows: u16, pad: u32) -> (u32, u32) {
    (
        cell.width * cols.max(1) as u32 + 2 * pad,
        cell.height * rows.max(1) as u32 + 2 * pad,
    )
}

/// The grid that fits a surface inside `pad` on every side: whole cells only (a
/// partial last column or row is left blank), never less than 1 x 1, never more
/// than `u16::MAX`.
pub fn grid_size(surface: (u32, u32), cell: CellPx, pad: u32) -> (u16, u16) {
    let fit = |px: u32, cell: u32| {
        let inner = px.saturating_sub(pad.saturating_mul(2));
        (inner / cell.max(1)).clamp(1, u16::MAX as u32) as u16
    };
    (fit(surface.0, cell.width), fit(surface.1, cell.height))
}

/// A surface position (pointer) relative to the grid's top-left corner. Left of
/// or above the grid it is negative, which `cell_at` clamps to the first
/// column or row and `edge_scroll` reads as "past the top".
pub fn to_grid(pos: (f64, f64), origin: (u32, u32)) -> (f64, f64) {
    (pos.0 - origin.0 as f64, pos.1 - origin.1 as f64)
}

/// The cell under a grid-relative position (see `to_grid`), clamped into the
/// grid (a drag past the edge selects up to the edge). `None` for an empty
/// grid.
pub fn cell_at(pos: (f64, f64), cell: CellPx, grid: (u16, u16)) -> Option<(u16, u16)> {
    if grid.0 == 0 || grid.1 == 0 {
        return None;
    }
    let idx = |v: f64, size: u32, n: u16| -> u16 {
        let i = (v / size.max(1) as f64).floor();
        if i.is_nan() || i < 0.0 {
            0
        } else {
            (i as u64).min(n as u64 - 1) as u16
        }
    };
    let col = idx(pos.0, cell.width, grid.0);
    let row = idx(pos.1, cell.height, grid.1);
    Some((row, col))
}

/// The pixel rectangle of `cols` cells starting at (`row`, `col`).
pub fn cell_rect(cell: CellPx, row: u16, col: u16, cols: u16) -> PxRect {
    PxRect {
        x: col as u32 * cell.width,
        y: row as u32 * cell.height,
        w: cols.max(1) as u32 * cell.width,
        h: cell.height,
    }
}

/// Font size in logical pixels with zoom steps. The physical size is this times
/// the window's scale factor (the renderer's `metrics::layout` does that).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontZoom {
    pub default_px: f32,
    pub px: f32,
    pub min_px: f32,
    pub max_px: f32,
    pub step_px: f32,
}

impl FontZoom {
    pub fn new(default_px: f32) -> Self {
        FontZoom {
            default_px,
            px: default_px,
            min_px: 6.0,
            max_px: 72.0,
            step_px: 1.0,
        }
    }

    fn set(&mut self, px: f32) -> bool {
        let px = px.clamp(self.min_px, self.max_px);
        let changed = (px - self.px).abs() > f32::EPSILON;
        self.px = px;
        changed
    }

    /// Returns whether the size changed (false at the limit).
    pub fn zoom_in(&mut self) -> bool {
        self.set(self.px + self.step_px)
    }

    pub fn zoom_out(&mut self) -> bool {
        self.set(self.px - self.step_px)
    }

    pub fn reset(&mut self) -> bool {
        self.set(self.default_px)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CELL: CellPx = CellPx {
        width: 8,
        height: 17,
    };

    #[test]
    fn whole_cells_fit_and_the_remainder_is_left_blank() {
        assert_eq!(grid_size((640, 408), CELL, 0), (80, 24));
        assert_eq!(grid_size((647, 424), CELL, 0), (80, 24));
        assert_eq!(grid_size((648, 425), CELL, 0), (81, 25));
    }

    #[test]
    fn hidpi_doubles_cell_size_so_the_grid_stays_the_same() {
        // A 2x display: the surface is twice as big in physical pixels and so
        // is the cell (font size times scale), so the grid does not change.
        let cell2 = CellPx {
            width: 16,
            height: 34,
        };
        assert_eq!(grid_size((1280, 816), cell2, 0), (80, 24));
        // Fractional 1.5x: 12 x 26 cells.
        let cell15 = CellPx {
            width: 12,
            height: 26,
        };
        assert_eq!(grid_size((960, 624), cell15, 0), (80, 24));
    }

    #[test]
    fn whole_pixel_cells_change_the_grid_across_scales() {
        // The bundled font at 14 px: 8 px wide at 1x but 17 px (16.8 rounded)
        // at 2x. A window keeping its logical size across displays therefore
        // gains or loses columns; the window sizes itself from the real cell
        // when it opens.
        let cell1 = CellPx {
            width: 8,
            height: 17,
        };
        let cell2 = CellPx {
            width: 17,
            height: 35,
        };
        assert_eq!(grid_size((800, 510), cell1, 0), (100, 30));
        assert_eq!(grid_size((1600, 1020), cell2, 0), (94, 29));
        assert_eq!(grid_size((1700, 1050), cell2, 0), (100, 30));
    }

    #[test]
    fn a_tiny_or_minimised_window_still_has_one_cell() {
        assert_eq!(grid_size((0, 0), CELL, 0), (1, 1));
        assert_eq!(grid_size((3, 5), CELL, 0), (1, 1));
        assert_eq!(
            grid_size(
                (100, 100),
                CellPx {
                    width: 0,
                    height: 0
                },
                0
            ),
            (100, 100)
        );
    }

    #[test]
    fn huge_surfaces_clamp_to_u16() {
        let one = CellPx {
            width: 1,
            height: 1,
        };
        assert_eq!(grid_size((100_000, 70_000), one, 0), (u16::MAX, u16::MAX));
    }

    #[test]
    fn padding_is_scaled_to_whole_physical_pixels() {
        assert_eq!(padding_px(8.0, 1.0), 8);
        assert_eq!(padding_px(8.0, 2.0), 16);
        assert_eq!(padding_px(8.0, 1.5), 12);
        assert_eq!(padding_px(8.0, 1.25), 10);
        assert_eq!(padding_px(5.0, 1.5), 8, "7.5 rounds up");
        assert_eq!(padding_px(0.0, 2.0), 0);
        assert_eq!(padding_px(-4.0, 2.0), 0);
        assert_eq!(padding_px(f32::NAN, 2.0), 0);
        assert_eq!(padding_px(8.0, f32::INFINITY), 0);
        assert_eq!(grid_origin(16), (16, 16));
    }

    #[test]
    fn the_grid_fits_inside_the_padding_on_every_side() {
        // 8 px pad at 1x: an 80 x 24 grid of 8 x 17 cells needs 656 x 424.
        assert_eq!(surface_for_grid(CELL, 80, 24, 8), (656, 424));
        assert_eq!(grid_size((656, 424), CELL, 8), (80, 24));
        // One pixel short in either direction loses a whole cell.
        assert_eq!(grid_size((655, 424), CELL, 8), (79, 24));
        assert_eq!(grid_size((656, 423), CELL, 8), (80, 23));
        // The remainder is blank, not a partial cell.
        assert_eq!(grid_size((663, 440), CELL, 8), (80, 24));
        // Without padding it is the old behaviour.
        assert_eq!(grid_size((640, 408), CELL, 0), (80, 24));
    }

    #[test]
    fn padding_on_hidpi_and_fractional_scales() {
        // 2x: 16 px pad, 16 x 34 cells.
        let cell2 = CellPx {
            width: 16,
            height: 34,
        };
        let pad2 = padding_px(DEFAULT_PADDING_PX, 2.0);
        assert_eq!(surface_for_grid(cell2, 80, 24, pad2), (1312, 848));
        assert_eq!(grid_size((1312, 848), cell2, pad2), (80, 24));
        // 1.5x: 12 px pad, 12 x 26 cells.
        let cell15 = CellPx {
            width: 12,
            height: 26,
        };
        let pad15 = padding_px(DEFAULT_PADDING_PX, 1.5);
        assert_eq!(surface_for_grid(cell15, 80, 24, pad15), (984, 648));
        assert_eq!(grid_size((984, 648), cell15, pad15), (80, 24));
        // 3x with a custom 4 px padding: 12 px.
        let cell3 = CellPx {
            width: 25,
            height: 52,
        };
        let pad3 = padding_px(4.0, 3.0);
        assert_eq!(pad3, 12);
        assert_eq!(
            grid_size((25 * 100 + 24, 52 * 30 + 24), cell3, pad3),
            (100, 30)
        );
    }

    #[test]
    fn a_window_smaller_than_its_padding_still_has_one_cell() {
        assert_eq!(grid_size((10, 10), CELL, 8), (1, 1));
        assert_eq!(grid_size((0, 0), CELL, 8), (1, 1));
        assert_eq!(grid_size((16, 16), CELL, 8), (1, 1));
        assert_eq!(grid_size((u32::MAX, u32::MAX), CELL, u32::MAX), (1, 1));
    }

    #[test]
    fn the_pointer_is_measured_from_the_grid_origin() {
        let origin = grid_origin(8);
        let grid = (80, 24);
        let at = |x: f64, y: f64| cell_at(to_grid((x, y), origin), CELL, grid);
        // Inside the padding: the first cell (clamped).
        assert_eq!(at(0.0, 0.0), Some((0, 0)));
        assert_eq!(at(7.9, 7.9), Some((0, 0)));
        // The first pixel of the grid is cell (0, 0); the next cell starts one
        // cell later, offset by the padding.
        assert_eq!(at(8.0, 8.0), Some((0, 0)));
        assert_eq!(at(15.9, 24.9), Some((0, 0)));
        assert_eq!(at(16.0, 25.0), Some((1, 1)));
        // The far edge: the last column ends at 8 + 80 * 8.
        assert_eq!(at(8.0 + 639.0, 8.0), Some((0, 79)));
        assert_eq!(at(8.0 + 640.0, 8.0), Some((0, 79)), "right padding clamps");
        assert_eq!(at(10_000.0, 10_000.0), Some((23, 79)));
        assert_eq!(to_grid((3.0, 20.0), origin), (-5.0, 12.0));
    }

    #[test]
    fn rectangles_move_with_the_origin() {
        let r = cell_rect(CELL, 2, 3, 2).offset(grid_origin(8));
        assert_eq!(
            r,
            PxRect {
                x: 32,
                y: 42,
                w: 16,
                h: 17
            }
        );
        assert_eq!(cell_rect(CELL, 0, 0, 1).offset((0, 0)).x, 0);
    }

    #[test]
    fn pointer_maps_to_cells_and_clamps_at_the_edges() {
        let grid = (80, 24);
        assert_eq!(cell_at((0.0, 0.0), CELL, grid), Some((0, 0)));
        assert_eq!(cell_at((7.9, 16.9), CELL, grid), Some((0, 0)));
        assert_eq!(cell_at((8.0, 17.0), CELL, grid), Some((1, 1)));
        assert_eq!(cell_at((-30.0, -1.0), CELL, grid), Some((0, 0)));
        assert_eq!(cell_at((10_000.0, 10_000.0), CELL, grid), Some((23, 79)));
        assert_eq!(cell_at((f64::NAN, 5.0), CELL, grid), Some((0, 0)));
        assert_eq!(cell_at((1.0, 1.0), CELL, (0, 0)), None);
    }

    #[test]
    fn cell_rects_are_integer_and_span_wide_cells() {
        assert_eq!(
            cell_rect(CELL, 2, 3, 2),
            PxRect {
                x: 24,
                y: 34,
                w: 16,
                h: 17
            }
        );
        assert_eq!(cell_rect(CELL, 0, 0, 0).w, 8);
    }

    #[test]
    fn zoom_steps_and_stops_at_the_limits() {
        let mut z = FontZoom::new(14.0);
        assert!(z.zoom_in());
        assert_eq!(z.px, 15.0);
        assert!(z.zoom_out() && z.zoom_out());
        assert_eq!(z.px, 13.0);
        assert!(z.reset());
        assert_eq!(z.px, 14.0);
        assert!(!z.reset());
        z.px = z.max_px;
        assert!(!z.zoom_in());
        z.px = z.min_px;
        assert!(!z.zoom_out());
    }
}
