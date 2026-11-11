//! Renders `canopy_term_core::frame::Frame`s. Layout, glyph atlas and damage
//! tracking live here and stay testable without a GPU; the window and device are
//! a thin layer on top.

pub use canopy_term_core::frame;

/// Pixel size of one cell for a given font. The grid is cells, the surface is
/// pixels, and every other number here derives from this one.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellMetrics {
    pub width: f32,
    pub height: f32,
}

/// The surface size needed to show `cols` x `rows` cells, rounded up so the last
/// column and row are never clipped.
pub fn surface_for(metrics: CellMetrics, cols: u16, rows: u16) -> (u32, u32) {
    (
        (metrics.width * cols as f32).ceil() as u32,
        (metrics.height * rows as f32).ceil() as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_surface_never_clips_a_fractional_cell() {
        let m = CellMetrics {
            width: 8.4,
            height: 16.5,
        };
        assert_eq!(surface_for(m, 80, 24), (672, 396));
    }
}
