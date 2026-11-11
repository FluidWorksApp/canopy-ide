//! A CPU compositor that does what `shader.wgsl` does, one instance at a time:
//! sample the atlas at integer texels, tint, blend premultiplied over the
//! target. It makes the whole pipeline (builder, atlas, shader maths) testable
//! on machines with no GPU, and gives the GPU test an expected image.

use crate::color::Rgb;
use crate::instance::{Instance, FLAG_COLOR};

/// Composites `instances` (in order) over a `clear` background into tightly
/// packed RGBA8. `atlas_pixels` is the atlas as RGBA8, `atlas_width` texels wide.
pub fn composite(
    instances: &[Instance],
    atlas_pixels: &[u8],
    atlas_width: u32,
    width: u32,
    height: u32,
    clear: Rgb,
) -> Vec<u8> {
    let mut out = vec![0u8; (width * height * 4) as usize];
    for px in out.chunks_exact_mut(4) {
        px.copy_from_slice(&[clear[0], clear[1], clear[2], 255]);
    }
    let atlas_height = (atlas_pixels.len() as u32 / 4) / atlas_width.max(1);
    for inst in instances.iter().filter(|i| !i.is_empty()) {
        let [x, y] = inst.pos;
        let [w, h] = inst.size;
        // Pixels whose centre is inside the rectangle.
        let x0 = ((x - 0.5).ceil().max(0.0)) as u32;
        let y0 = ((y - 0.5).ceil().max(0.0)) as u32;
        let x1 = (((x + w - 0.5).ceil()).max(0.0) as u32).min(width);
        let y1 = (((y + h - 0.5).ceil()).max(0.0) as u32).min(height);
        let tint = inst.color.to_le_bytes();
        for py in y0..y1 {
            for px in x0..x1 {
                let cx = (px as f32 + 0.5 - x) / w;
                let cy = (py as f32 + 0.5 - y) / h;
                let sx = inst.uv[0] as f32 + cx * inst.uv[2] as f32;
                let sy = inst.uv[1] as f32 + cy * inst.uv[3] as f32;
                let tx = (sx.floor().max(0.0) as u32).min(atlas_width - 1);
                let ty = (sy.floor().max(0.0) as u32).min(atlas_height.saturating_sub(1));
                let t = ((ty * atlas_width + tx) * 4) as usize;
                let texel = &atlas_pixels[t..t + 4];
                let a = (texel[3] as f32 / 255.0) * (tint[3] as f32 / 255.0);
                let o = ((py * width + px) * 4) as usize;
                for c in 0..3 {
                    let rgb = if inst.flags & FLAG_COLOR != 0 {
                        texel[c]
                    } else {
                        tint[c]
                    };
                    let src = (rgb as f32 / 255.0) * a;
                    let dst = out[o + c] as f32 / 255.0;
                    let v = src + dst * (1.0 - a);
                    out[o + c] = (v * 255.0 + 0.5).floor().clamp(0.0, 255.0) as u8;
                }
            }
        }
    }
    out
}

/// Largest per-channel difference between two equally sized RGBA buffers.
pub fn max_diff(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len(), "images differ in size");
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

/// A stable 64-bit FNV-1a hash of an image, for logging and cross-machine
/// comparison.
pub fn hash(bytes: &[u8]) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atlas::Atlas;
    use crate::geometry::PxRect;

    fn white_atlas() -> (Vec<u8>, u32) {
        let atlas: Atlas<u32> = Atlas::new(16, 16);
        (atlas.pixels().to_vec(), 16)
    }

    fn px(img: &[u8], w: u32, x: u32, y: u32) -> [u8; 3] {
        let o = ((y * w + x) * 4) as usize;
        [img[o], img[o + 1], img[o + 2]]
    }

    #[test]
    fn a_solid_rectangle_covers_exactly_its_pixels() {
        let (atlas, aw) = white_atlas();
        let r = Instance::solid(
            PxRect {
                x: 2,
                y: 1,
                w: 3,
                h: 2,
            },
            [200, 100, 50],
        );
        let img = composite(&[r], &atlas, aw, 8, 4, [10, 10, 10]);
        assert_eq!(px(&img, 8, 2, 1), [200, 100, 50]);
        assert_eq!(px(&img, 8, 4, 2), [200, 100, 50]);
        assert_eq!(px(&img, 8, 5, 1), [10, 10, 10], "one past the right edge");
        assert_eq!(px(&img, 8, 2, 3), [10, 10, 10], "one past the bottom edge");
        assert_eq!(px(&img, 8, 1, 1), [10, 10, 10]);
    }

    #[test]
    fn red_and_blue_are_not_swapped_and_y_is_not_flipped() {
        let (atlas, aw) = white_atlas();
        let top_left = Instance::solid(
            PxRect {
                x: 0,
                y: 0,
                w: 1,
                h: 1,
            },
            [255, 0, 0],
        );
        let bottom_right = Instance::solid(
            PxRect {
                x: 3,
                y: 1,
                w: 1,
                h: 1,
            },
            [0, 0, 255],
        );
        let img = composite(&[top_left, bottom_right], &atlas, aw, 4, 2, [0, 0, 0]);
        assert_eq!(px(&img, 4, 0, 0), [255, 0, 0]);
        assert_eq!(px(&img, 4, 3, 1), [0, 0, 255]);
        assert_eq!(px(&img, 4, 0, 1), [0, 0, 0]);
    }

    #[test]
    fn later_instances_paint_over_earlier_ones() {
        let (atlas, aw) = white_atlas();
        let a = PxRect {
            x: 0,
            y: 0,
            w: 2,
            h: 1,
        };
        let img = composite(
            &[Instance::solid(a, [1, 2, 3]), Instance::solid(a, [9, 8, 7])],
            &atlas,
            aw,
            2,
            1,
            [0, 0, 0],
        );
        assert_eq!(px(&img, 2, 0, 0), [9, 8, 7]);
    }

    #[test]
    fn a_mask_glyph_blends_by_coverage() {
        let mut atlas: Atlas<u32> = Atlas::new(16, 16);
        // 2x1 mask: full coverage, half coverage.
        let r = atlas
            .insert(1, 2, 1, &[255, 255, 255, 255, 255, 255, 255, 128])
            .unwrap();
        let clip = PxRect {
            x: 0,
            y: 0,
            w: 4,
            h: 2,
        };
        let g = Instance::glyph(r, 1, 0, [200, 200, 200], false, clip).unwrap();
        let img = composite(&[g], atlas.pixels(), 16, 4, 2, [0, 0, 0]);
        assert_eq!(px(&img, 4, 1, 0), [200, 200, 200]);
        let half = px(&img, 4, 2, 0);
        assert!((half[0] as i32 - 100).abs() <= 1, "{half:?}");
        assert_eq!(px(&img, 4, 0, 0), [0, 0, 0]);
    }

    #[test]
    fn a_colour_glyph_ignores_the_tint() {
        let mut atlas: Atlas<u32> = Atlas::new(16, 16);
        let r = atlas.insert(1, 1, 1, &[10, 20, 30, 255]).unwrap();
        let clip = PxRect {
            x: 0,
            y: 0,
            w: 2,
            h: 2,
        };
        let g = Instance::glyph(r, 0, 0, [250, 250, 250], true, clip).unwrap();
        let img = composite(&[g], atlas.pixels(), 16, 2, 2, [0, 0, 0]);
        assert_eq!(px(&img, 2, 0, 0), [10, 20, 30]);
    }

    #[test]
    fn rectangles_outside_the_target_are_clipped() {
        let (atlas, aw) = white_atlas();
        let r = Instance::solid(
            PxRect {
                x: -2,
                y: -2,
                w: 100,
                h: 100,
            },
            [5, 5, 5],
        );
        let img = composite(&[r], &atlas, aw, 3, 3, [0, 0, 0]);
        assert_eq!(px(&img, 3, 2, 2), [5, 5, 5]);
        assert_eq!(img.len(), 3 * 3 * 4);
    }

    #[test]
    fn diff_and_hash_helpers() {
        assert_eq!(max_diff(&[1, 2, 3], &[1, 5, 3]), 3);
        assert_eq!(hash(b"abc"), hash(b"abc"));
        assert_ne!(hash(b"abc"), hash(b"abd"));
    }
}
