//! The GPU instance: one textured rectangle. Solid rectangles (backgrounds,
//! underlines, cursor) sample the atlas's white block, so a single pipeline and
//! a single draw call render everything.

use crate::atlas::{Rect, WHITE};
use crate::color::Rgb;
use crate::geometry::PxRect;

/// 32 bytes, no padding. Layout must match `shader.wgsl` and the vertex
/// attributes in `gpu.rs`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Instance {
    /// Destination top-left in surface pixels.
    pub pos: [f32; 2],
    /// Destination size in pixels. Zero makes the instance degenerate (unused).
    pub size: [f32; 2],
    /// Source in atlas texels: x, y, w, h. A solid rectangle has w = h = 0 and
    /// points at the white block.
    pub uv: [u16; 4],
    /// Tint, RGBA8 packed little-endian (r in the low byte).
    pub color: u32,
    /// Bit 0: colour bitmap (ignore the tint's rgb).
    pub flags: u32,
}

pub const FLAG_COLOR: u32 = 1;

impl Instance {
    pub const EMPTY: Instance = Instance {
        pos: [0.0; 2],
        size: [0.0; 2],
        uv: [0; 4],
        color: 0,
        flags: 0,
    };

    pub fn is_empty(&self) -> bool {
        self.size[0] == 0.0 || self.size[1] == 0.0
    }

    pub fn pack(rgb: Rgb, alpha: u8) -> u32 {
        u32::from_le_bytes([rgb[0], rgb[1], rgb[2], alpha])
    }

    /// A solid rectangle.
    pub fn solid(r: PxRect, rgb: Rgb) -> Instance {
        if r.w == 0 || r.h == 0 {
            return Instance::EMPTY;
        }
        Instance {
            pos: [r.x as f32, r.y as f32],
            size: [r.w as f32, r.h as f32],
            uv: [WHITE.x, WHITE.y, 0, 0],
            color: Self::pack(rgb, 255),
            flags: 0,
        }
    }

    /// An atlas glyph drawn with its top-left at (`x`, `y`), clipped to `clip`
    /// so it can never paint over a neighbouring cell. `None` when nothing of it
    /// is inside the clip.
    pub fn glyph(
        src: Rect,
        x: i32,
        y: i32,
        rgb: Rgb,
        color: bool,
        clip: PxRect,
    ) -> Option<Instance> {
        let (cx0, cy0) = (clip.x, clip.y);
        let (cx1, cy1) = (clip.x + clip.w as i32, clip.y + clip.h as i32);
        let x0 = x.max(cx0);
        let y0 = y.max(cy0);
        let x1 = (x + src.w as i32).min(cx1);
        let y1 = (y + src.h as i32).min(cy1);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        Some(Instance {
            pos: [x0 as f32, y0 as f32],
            size: [(x1 - x0) as f32, (y1 - y0) as f32],
            uv: [
                src.x + (x0 - x) as u16,
                src.y + (y0 - y) as u16,
                (x1 - x0) as u16,
                (y1 - y0) as u16,
            ],
            color: Self::pack(rgb, 255),
            flags: if color { FLAG_COLOR } else { 0 },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instance_is_32_bytes_with_no_padding() {
        assert_eq!(std::mem::size_of::<Instance>(), 32);
        assert_eq!(std::mem::align_of::<Instance>(), 4);
    }

    #[test]
    fn empty_and_zero_area_instances_are_degenerate() {
        assert!(Instance::EMPTY.is_empty());
        let r = PxRect {
            x: 1,
            y: 1,
            w: 0,
            h: 4,
        };
        assert!(Instance::solid(r, [1, 2, 3]).is_empty());
    }

    #[test]
    fn a_solid_samples_the_white_block() {
        let i = Instance::solid(
            PxRect {
                x: 8,
                y: 16,
                w: 8,
                h: 16,
            },
            [10, 20, 30],
        );
        assert_eq!(i.pos, [8.0, 16.0]);
        assert_eq!(i.size, [8.0, 16.0]);
        assert_eq!(i.uv, [WHITE.x, WHITE.y, 0, 0]);
        assert_eq!(i.color.to_le_bytes(), [10, 20, 30, 255]);
    }

    #[test]
    fn a_glyph_inside_its_clip_is_unchanged() {
        let clip = PxRect {
            x: 0,
            y: 0,
            w: 8,
            h: 16,
        };
        let src = Rect {
            x: 40,
            y: 50,
            w: 6,
            h: 10,
        };
        let i = Instance::glyph(src, 1, 3, [0; 3], false, clip).unwrap();
        assert_eq!(i.pos, [1.0, 3.0]);
        assert_eq!(i.size, [6.0, 10.0]);
        assert_eq!(i.uv, [40, 50, 6, 10]);
    }

    #[test]
    fn a_glyph_overhanging_its_cell_is_clipped_with_matching_uvs() {
        let clip = PxRect {
            x: 8,
            y: 16,
            w: 8,
            h: 16,
        };
        let src = Rect {
            x: 40,
            y: 50,
            w: 10,
            h: 20,
        };
        // Starts 2 px left of and 3 px above the clip, runs past right/bottom.
        let i = Instance::glyph(src, 6, 13, [0; 3], false, clip).unwrap();
        assert_eq!(i.pos, [8.0, 16.0]);
        assert_eq!(i.size, [8.0, 16.0]);
        assert_eq!(i.uv, [42, 53, 8, 16]);
    }

    #[test]
    fn a_glyph_fully_outside_its_clip_vanishes() {
        let clip = PxRect {
            x: 0,
            y: 0,
            w: 8,
            h: 16,
        };
        let src = Rect {
            x: 0,
            y: 0,
            w: 4,
            h: 4,
        };
        assert!(Instance::glyph(src, 8, 0, [0; 3], false, clip).is_none());
        assert!(Instance::glyph(src, 0, -4, [0; 3], false, clip).is_none());
    }

    #[test]
    fn colour_glyphs_set_the_flag() {
        let clip = PxRect {
            x: 0,
            y: 0,
            w: 8,
            h: 8,
        };
        let src = Rect {
            x: 0,
            y: 0,
            w: 8,
            h: 8,
        };
        let i = Instance::glyph(src, 0, 0, [0; 3], true, clip).unwrap();
        assert_eq!(i.flags, FLAG_COLOR);
    }
}
