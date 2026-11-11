//! Pixels to cells: the window's surface size and the cell size give the grid,
//! a pointer position gives a cell, and the font size steps for zoom.
//!
//! Everything is in physical pixels, the unit the renderer's `CellLayout` uses
//! and the unit AccessKit and the surface use. The renderer draws from the
//! surface's top-left with no padding, so there is no padding here either.

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

/// The grid that fits a surface: whole cells only (a partial last column or row
/// is left blank), never less than 1 x 1, never more than `u16::MAX`.
pub fn grid_size(surface: (u32, u32), cell: CellPx) -> (u16, u16) {
    let fit = |px: u32, cell: u32| (px / cell.max(1)).clamp(1, u16::MAX as u32) as u16;
    (fit(surface.0, cell.width), fit(surface.1, cell.height))
}

/// The cell under a pointer position, clamped into the grid (a drag past the
/// edge selects up to the edge). `None` for an empty grid.
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
        assert_eq!(grid_size((640, 408), CELL), (80, 24));
        assert_eq!(grid_size((647, 424), CELL), (80, 24));
        assert_eq!(grid_size((648, 425), CELL), (81, 25));
    }

    #[test]
    fn hidpi_doubles_cell_size_so_the_grid_stays_the_same() {
        // A 2x display: the surface is twice as big in physical pixels and so
        // is the cell (font size times scale), so the grid does not change.
        let cell2 = CellPx {
            width: 16,
            height: 34,
        };
        assert_eq!(grid_size((1280, 816), cell2), (80, 24));
        // Fractional 1.5x: 12 x 26 cells.
        let cell15 = CellPx {
            width: 12,
            height: 26,
        };
        assert_eq!(grid_size((960, 624), cell15), (80, 24));
    }

    #[test]
    fn a_tiny_or_minimised_window_still_has_one_cell() {
        assert_eq!(grid_size((0, 0), CELL), (1, 1));
        assert_eq!(grid_size((3, 5), CELL), (1, 1));
        assert_eq!(
            grid_size(
                (100, 100),
                CellPx {
                    width: 0,
                    height: 0
                }
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
        assert_eq!(grid_size((100_000, 70_000), one), (u16::MAX, u16::MAX));
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
