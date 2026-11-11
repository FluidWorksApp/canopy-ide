//! Glyphs drawn by code instead of taken from a font: box drawing, block
//! elements and the first Powerline shapes. Fonts draw these with their own
//! side bearings and hinting, so lines break at cell edges; drawing them from
//! the cell size makes adjacent cells meet with no gap and no overlap.
//!
//! Output is an alpha mask of exactly `w * h` bytes (row-major, 255 = ink).
//!
//! Known approximations: double-line junctions are plain overlaps of the two
//! lines (no gap toward the crossing), dashed box characters render as solid
//! lines, rounded corners render square, and diagonals (U+2571..2573) are left
//! to the font.

/// True when `ch` is drawn here rather than from a font.
pub fn is_procedural(ch: char) -> bool {
    let c = ch as u32;
    match c {
        0x2500..=0x257F => BOX[(c - 0x2500) as usize] != [0, 0, 0, 0],
        0x2580..=0x259F => true,
        0xE0B0..=0xE0B3 => true,
        _ => false,
    }
}

/// Rasterises `ch` into a `w * h` alpha mask, or `None` if it is not procedural.
pub fn rasterize(ch: char, w: u32, h: u32) -> Option<Vec<u8>> {
    if w == 0 || h == 0 || !is_procedural(ch) {
        return None;
    }
    let mut m = Mask::new(w, h);
    let c = ch as u32;
    match c {
        0x2500..=0x257F => box_drawing(&mut m, BOX[(c - 0x2500) as usize]),
        0x2580..=0x259F => block_element(&mut m, c),
        0xE0B0..=0xE0B3 => powerline(&mut m, c),
        _ => return None,
    }
    Some(m.data)
}

struct Mask {
    w: u32,
    h: u32,
    data: Vec<u8>,
}

impl Mask {
    fn new(w: u32, h: u32) -> Self {
        Mask {
            w,
            h,
            data: vec![0; (w * h) as usize],
        }
    }

    /// Fills `[x0, x1) x [y0, y1)` with `alpha`, clipped to the mask.
    fn fill(&mut self, x0: u32, y0: u32, x1: u32, y1: u32, alpha: u8) {
        for y in y0.min(self.h)..y1.min(self.h) {
            for x in x0.min(self.w)..x1.min(self.w) {
                self.data[(y * self.w + x) as usize] = alpha;
            }
        }
    }
}

fn box_drawing(m: &mut Mask, [l, r, u, d]: [u8; 4]) {
    let (w, h) = (m.w, m.h);
    let light = ((w as f32 / 8.0).round() as u32).max(1);
    let thick = |style: u8| match style {
        0 => 0,
        1 => light,
        2 => (light * 2).max(light + 1),
        _ => light * 3, // double: two lines of `light` with a `light` gap
    };
    let vt = thick(u).max(thick(d));
    let ht = thick(l).max(thick(r));
    let vx0 = (w.saturating_sub(vt)) / 2;
    let hy0 = (h.saturating_sub(ht)) / 2;
    let v_end_x = vx0 + vt; // right edge of the vertical band
    let h_end_y = hy0 + ht; // bottom edge of the horizontal band

    // Draws one horizontal arm across `[x0, x1)`.
    let h_arm = |m: &mut Mask, style: u8, x0: u32, x1: u32| {
        let t = thick(style);
        if t == 0 {
            return;
        }
        let y0 = (h.saturating_sub(t)) / 2;
        if style == 3 {
            m.fill(x0, y0, x1, y0 + light, 255);
            m.fill(x0, y0 + 2 * light, x1, y0 + 3 * light, 255);
        } else {
            m.fill(x0, y0, x1, y0 + t, 255);
        }
    };
    let v_arm = |m: &mut Mask, style: u8, y0: u32, y1: u32| {
        let t = thick(style);
        if t == 0 {
            return;
        }
        let x0 = (w.saturating_sub(t)) / 2;
        if style == 3 {
            m.fill(x0, y0, x0 + light, y1, 255);
            m.fill(x0 + 2 * light, y0, x0 + 3 * light, y1, 255);
        } else {
            m.fill(x0, y0, x0 + t, y1, 255);
        }
    };
    // Arms run to the far side of the perpendicular band so corners are filled.
    let left_end = if vt == 0 {
        w / 2 + (ht.min(1))
    } else {
        v_end_x
    };
    let right_start = if vt == 0 { w / 2 } else { vx0 };
    let up_end = if ht == 0 {
        h / 2 + (vt.min(1))
    } else {
        h_end_y
    };
    let down_start = if ht == 0 { h / 2 } else { hy0 };
    h_arm(m, l, 0, left_end);
    h_arm(m, r, right_start, w);
    v_arm(m, u, 0, up_end);
    v_arm(m, d, down_start, h);
}

fn block_element(m: &mut Mask, c: u32) {
    let (w, h) = (m.w, m.h);
    let eighth_h = |n: u32| ((h * n) as f32 / 8.0).round() as u32;
    let eighth_w = |n: u32| ((w * n) as f32 / 8.0).round() as u32;
    match c {
        0x2580 => m.fill(0, 0, w, h / 2, 255),
        0x2581..=0x2588 => {
            let n = c - 0x2580;
            m.fill(0, h - eighth_h(n), w, h, 255);
        }
        // The left half uses `w / 2` so it partitions the cell with U+2590.
        0x258C => m.fill(0, 0, w / 2, h, 255),
        0x2589..=0x258F => {
            let n = 0x2590 - c;
            m.fill(0, 0, eighth_w(n), h, 255);
        }
        0x2590 => m.fill(w / 2, 0, w, h, 255),
        0x2591 => m.fill(0, 0, w, h, 64),
        0x2592 => m.fill(0, 0, w, h, 128),
        0x2593 => m.fill(0, 0, w, h, 192),
        0x2594 => m.fill(0, 0, w, eighth_h(1), 255),
        0x2595 => m.fill(w - eighth_w(1), 0, w, h, 255),
        0x2596..=0x259F => {
            // Quadrants as a bit set: UL=1 UR=2 LL=4 LR=8.
            const Q: [u8; 10] = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14];
            let q = Q[(c - 0x2596) as usize];
            let (mx, my) = (w / 2, h / 2);
            if q & 1 != 0 {
                m.fill(0, 0, mx, my, 255);
            }
            if q & 2 != 0 {
                m.fill(mx, 0, w, my, 255);
            }
            if q & 4 != 0 {
                m.fill(0, my, mx, h, 255);
            }
            if q & 8 != 0 {
                m.fill(mx, my, w, h, 255);
            }
        }
        _ => {}
    }
}

/// Powerline separators: E0B0 solid right triangle, E0B1 right chevron,
/// E0B2 solid left triangle, E0B3 left chevron. 4x4 supersampled edges.
fn powerline(m: &mut Mask, c: u32) {
    let (w, h) = (m.w as f32, m.h as f32);
    let left = c == 0xE0B2 || c == 0xE0B3;
    let outline = c == 0xE0B1 || c == 0xE0B3;
    let stroke = (w / 8.0).max(1.0);
    const N: u32 = 4;
    for y in 0..m.h {
        for x in 0..m.w {
            let mut hits = 0;
            for sy in 0..N {
                for sx in 0..N {
                    let px = x as f32 + (sx as f32 + 0.5) / N as f32;
                    let py = y as f32 + (sy as f32 + 0.5) / N as f32;
                    // x of the tip edge at this height, measured from the base.
                    let edge = w * (1.0 - (2.0 * py / h - 1.0).abs());
                    let dx = if left { w - px } else { px };
                    let inside = if outline {
                        (dx - edge).abs() <= stroke / 2.0 + 0.0
                    } else {
                        dx <= edge
                    };
                    if inside {
                        hits += 1;
                    }
                }
            }
            m.data[(y * m.w + x) as usize] = (hits * 255 / (N * N)) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(m: &[u8], w: u32, x: u32, y: u32) -> u8 {
        m[(y * w + x) as usize]
    }

    #[test]
    fn only_drawn_ranges_are_procedural() {
        assert!(is_procedural('─'));
        assert!(is_procedural('█'));
        assert!(is_procedural('\u{E0B0}'));
        assert!(!is_procedural('a'));
        assert!(!is_procedural('╱'), "diagonals stay with the font");
    }

    #[test]
    fn full_block_is_solid_and_exactly_cell_sized() {
        let m = rasterize('█', 8, 16).unwrap();
        assert_eq!(m.len(), 8 * 16);
        assert!(m.iter().all(|&a| a == 255));
    }

    #[test]
    fn halves_tile_the_cell_with_no_gap_or_overlap() {
        for (w, h) in [(8, 16), (9, 17), (7, 15)] {
            let top = rasterize('▀', w, h).unwrap();
            let bottom = rasterize('▄', w, h).unwrap();
            let left = rasterize('▌', w, h).unwrap();
            let right = rasterize('▐', w, h).unwrap();
            for i in 0..(w * h) as usize {
                // Top half is [0, h/2); bottom is the rounded half, so for odd
                // heights they may overlap by a row but must never leave a gap.
                assert!(top[i] == 255 || bottom[i] == 255, "vertical gap at {i}");
                assert_eq!(
                    (left[i] == 255) as u8 + (right[i] == 255) as u8,
                    1,
                    "horizontal halves must partition at {i} for {w}x{h}"
                );
            }
        }
    }

    #[test]
    fn horizontal_line_spans_the_full_width_so_cells_join() {
        let (w, h) = (8, 16);
        let m = rasterize('─', w, h).unwrap();
        let rows: Vec<u32> = (0..h).filter(|&y| at(&m, w, 0, y) == 255).collect();
        assert!(!rows.is_empty());
        for &y in &rows {
            for x in 0..w {
                assert_eq!(at(&m, w, x, y), 255, "gap at {x},{y}");
            }
        }
        // Centred vertically.
        let first = *rows.first().unwrap();
        let last = *rows.last().unwrap();
        assert!(first.abs_diff(h - 1 - last) <= 1);
    }

    #[test]
    fn vertical_line_spans_the_full_height() {
        let (w, h) = (8, 16);
        let m = rasterize('│', w, h).unwrap();
        let cols: Vec<u32> = (0..w).filter(|&x| at(&m, w, x, 0) == 255).collect();
        assert!(!cols.is_empty());
        for &x in &cols {
            for y in 0..h {
                assert_eq!(at(&m, w, x, y), 255);
            }
        }
    }

    #[test]
    fn a_corner_joins_two_edges_and_leaves_the_rest_empty() {
        let (w, h) = (8, 16);
        let m = rasterize('┌', w, h).unwrap(); // down and right
        let (cx, cy) = ((w - 1) / 2, (h - 1) / 2);
        assert_eq!(at(&m, w, w - 1, cy), 255, "reaches the right edge");
        assert_eq!(at(&m, w, cx, h - 1), 255, "reaches the bottom edge");
        assert_eq!(at(&m, w, 0, cy), 0, "nothing on the left");
        assert_eq!(at(&m, w, cx, 0), 0, "nothing above");
    }

    #[test]
    fn heavy_is_thicker_than_light_and_double_has_two_lines() {
        let (w, h) = (16, 32);
        let count = |ch| {
            rasterize(ch, w, h)
                .unwrap()
                .iter()
                .enumerate()
                .filter(|(i, &a)| a == 255 && (*i as u32 % w) == 0)
                .count()
        };
        assert!(count('━') > count('─'));
        let m = rasterize('═', w, h).unwrap();
        let col: Vec<u8> = (0..h).map(|y| at(&m, w, 0, y)).collect();
        let runs =
            col.windows(2).filter(|p| p[0] == 0 && p[1] == 255).count() + (col[0] == 255) as usize;
        assert_eq!(runs, 2);
    }

    #[test]
    fn shades_use_alpha() {
        assert_eq!(rasterize('░', 4, 4).unwrap()[0], 64);
        assert_eq!(rasterize('▒', 4, 4).unwrap()[0], 128);
        assert_eq!(rasterize('▓', 4, 4).unwrap()[0], 192);
    }

    #[test]
    fn quadrants_cover_the_right_corners() {
        let (w, h) = (8, 8);
        let m = rasterize('▚', w, h).unwrap(); // upper left + lower right
        assert_eq!(at(&m, w, 0, 0), 255);
        assert_eq!(at(&m, w, w - 1, h - 1), 255);
        assert_eq!(at(&m, w, w - 1, 0), 0);
        assert_eq!(at(&m, w, 0, h - 1), 0);
    }

    #[test]
    fn powerline_triangle_is_solid_at_the_base_and_empty_past_the_tip() {
        let (w, h) = (8, 16);
        let right = rasterize('\u{E0B0}', w, h).unwrap();
        assert_eq!(at(&right, w, 0, h / 2), 255);
        assert_eq!(at(&right, w, 0, 2), 255, "base is wide near the top");
        assert_eq!(at(&right, w, w - 1, 0), 0, "tip is at the middle only");
        let left = rasterize('\u{E0B2}', w, h).unwrap();
        assert_eq!(at(&left, w, w - 1, h / 2), 255);
        assert_eq!(at(&left, w, 0, 0), 0);
    }

    #[test]
    fn every_listed_box_char_rasterises_to_a_cell_sized_mask() {
        for c in 0x2500u32..0x2600 {
            let ch = char::from_u32(c).unwrap();
            if is_procedural(ch) {
                let m = rasterize(ch, 9, 18).unwrap();
                assert_eq!(m.len(), 9 * 18);
                assert!(m.iter().any(|&a| a != 0), "{c:X} is blank");
            }
        }
    }

    #[test]
    fn zero_sized_cells_produce_nothing() {
        assert!(rasterize('█', 0, 10).is_none());
    }
}

const BOX: [[u8; 4]; 128] = [
    [1, 1, 0, 0], // 2500 light horizontal
    [2, 2, 0, 0], // 2501 heavy horizontal
    [0, 0, 1, 1], // 2502 light vertical
    [0, 0, 2, 2], // 2503 heavy vertical
    [1, 1, 0, 0], // 2504 light triple dash horizontal
    [2, 2, 0, 0], // 2505 heavy triple dash horizontal
    [0, 0, 1, 1], // 2506 light triple dash vertical
    [0, 0, 2, 2], // 2507 heavy triple dash vertical
    [1, 1, 0, 0], // 2508 light quadruple dash horizontal
    [2, 2, 0, 0], // 2509 heavy quadruple dash horizontal
    [0, 0, 1, 1], // 250A light quadruple dash vertical
    [0, 0, 2, 2], // 250B heavy quadruple dash vertical
    [0, 1, 0, 1], // 250C light down and right
    [0, 2, 0, 1], // 250D down light and right heavy
    [0, 1, 0, 2], // 250E down heavy and right light
    [0, 2, 0, 2], // 250F heavy down and right
    [1, 0, 0, 1], // 2510 light down and left
    [2, 0, 0, 1], // 2511 down light and left heavy
    [1, 0, 0, 2], // 2512 down heavy and left light
    [2, 0, 0, 2], // 2513 heavy down and left
    [0, 1, 1, 0], // 2514 light up and right
    [0, 2, 1, 0], // 2515 up light and right heavy
    [0, 1, 2, 0], // 2516 up heavy and right light
    [0, 2, 2, 0], // 2517 heavy up and right
    [1, 0, 1, 0], // 2518 light up and left
    [2, 0, 1, 0], // 2519 up light and left heavy
    [1, 0, 2, 0], // 251A up heavy and left light
    [2, 0, 2, 0], // 251B heavy up and left
    [0, 1, 1, 1], // 251C light vertical and right
    [0, 2, 1, 1], // 251D vertical light and right heavy
    [0, 1, 2, 1], // 251E up heavy and right down light
    [0, 1, 1, 2], // 251F down heavy and right up light
    [0, 1, 2, 2], // 2520 vertical heavy and right light
    [0, 2, 2, 1], // 2521 down light and right up heavy
    [0, 2, 1, 2], // 2522 up light and right down heavy
    [0, 2, 2, 2], // 2523 heavy vertical and right
    [1, 0, 1, 1], // 2524 light vertical and left
    [2, 0, 1, 1], // 2525 vertical light and left heavy
    [1, 0, 2, 1], // 2526 up heavy and left down light
    [1, 0, 1, 2], // 2527 down heavy and left up light
    [1, 0, 2, 2], // 2528 vertical heavy and left light
    [2, 0, 2, 1], // 2529 down light and left up heavy
    [2, 0, 1, 2], // 252A up light and left down heavy
    [2, 0, 2, 2], // 252B heavy vertical and left
    [1, 1, 0, 1], // 252C light down and horizontal
    [2, 1, 0, 1], // 252D left heavy and right down light
    [1, 2, 0, 1], // 252E right heavy and left down light
    [2, 2, 0, 1], // 252F down light and horizontal heavy
    [1, 1, 0, 2], // 2530 down heavy and horizontal light
    [2, 1, 0, 2], // 2531 right light and left down heavy
    [1, 2, 0, 2], // 2532 left light and right down heavy
    [2, 2, 0, 2], // 2533 heavy down and horizontal
    [1, 1, 1, 0], // 2534 light up and horizontal
    [2, 1, 1, 0], // 2535 left heavy and right up light
    [1, 2, 1, 0], // 2536 right heavy and left up light
    [2, 2, 1, 0], // 2537 up light and horizontal heavy
    [1, 1, 2, 0], // 2538 up heavy and horizontal light
    [2, 1, 2, 0], // 2539 right light and left up heavy
    [1, 2, 2, 0], // 253A left light and right up heavy
    [2, 2, 2, 0], // 253B heavy up and horizontal
    [1, 1, 1, 1], // 253C light vertical and horizontal
    [2, 1, 1, 1], // 253D left heavy and right vertical light
    [1, 2, 1, 1], // 253E right heavy and left vertical light
    [2, 2, 1, 1], // 253F vertical light and horizontal heavy
    [1, 1, 2, 1], // 2540 up heavy and down horizontal light
    [1, 1, 1, 2], // 2541 down heavy and up horizontal light
    [1, 1, 2, 2], // 2542 vertical heavy and horizontal light
    [2, 1, 2, 1], // 2543 left up heavy and right down light
    [1, 2, 2, 1], // 2544 right up heavy and left down light
    [2, 1, 1, 2], // 2545 left down heavy and right up light
    [1, 2, 1, 2], // 2546 right down heavy and left up light
    [2, 2, 2, 1], // 2547 down light and up horizontal heavy
    [2, 2, 1, 2], // 2548 up light and down horizontal heavy
    [2, 1, 2, 2], // 2549 right light and left vertical heavy
    [1, 2, 2, 2], // 254A left light and right vertical heavy
    [2, 2, 2, 2], // 254B heavy vertical and horizontal
    [1, 1, 0, 0], // 254C light double dash horizontal
    [2, 2, 0, 0], // 254D heavy double dash horizontal
    [0, 0, 1, 1], // 254E light double dash vertical
    [0, 0, 2, 2], // 254F heavy double dash vertical
    [3, 3, 0, 0], // 2550 double horizontal
    [0, 0, 3, 3], // 2551 double vertical
    [0, 3, 0, 1], // 2552 down single and right double
    [0, 1, 0, 3], // 2553 down double and right single
    [0, 3, 0, 3], // 2554 double down and right
    [3, 0, 0, 1], // 2555 down single and left double
    [1, 0, 0, 3], // 2556 down double and left single
    [3, 0, 0, 3], // 2557 double down and left
    [0, 3, 1, 0], // 2558 up single and right double
    [0, 1, 3, 0], // 2559 up double and right single
    [0, 3, 3, 0], // 255A double up and right
    [3, 0, 1, 0], // 255B up single and left double
    [1, 0, 3, 0], // 255C up double and left single
    [3, 0, 3, 0], // 255D double up and left
    [0, 3, 1, 1], // 255E vertical single and right double
    [0, 1, 3, 3], // 255F vertical double and right single
    [0, 3, 3, 3], // 2560 double vertical and right
    [3, 0, 1, 1], // 2561 vertical single and left double
    [1, 0, 3, 3], // 2562 vertical double and left single
    [3, 0, 3, 3], // 2563 double vertical and left
    [3, 3, 0, 1], // 2564 down single and horizontal double
    [1, 1, 0, 3], // 2565 down double and horizontal single
    [3, 3, 0, 3], // 2566 double down and horizontal
    [3, 3, 1, 0], // 2567 up single and horizontal double
    [1, 1, 3, 0], // 2568 up double and horizontal single
    [3, 3, 3, 0], // 2569 double up and horizontal
    [3, 3, 1, 1], // 256A vertical single and horizontal double
    [1, 1, 3, 3], // 256B vertical double and horizontal single
    [3, 3, 3, 3], // 256C double vertical and horizontal
    [0, 1, 0, 1], // 256D light arc down and right
    [1, 0, 0, 1], // 256E light arc down and left
    [1, 0, 1, 0], // 256F light arc up and left
    [0, 1, 1, 0], // 2570 light arc up and right
    [0, 0, 0, 0], // 2571 light diagonal upper right to lower left
    [0, 0, 0, 0], // 2572 light diagonal upper left to lower right
    [0, 0, 0, 0], // 2573 light diagonal cross
    [1, 0, 0, 0], // 2574 light left
    [0, 0, 1, 0], // 2575 light up
    [0, 1, 0, 0], // 2576 light right
    [0, 0, 0, 1], // 2577 light down
    [2, 0, 0, 0], // 2578 heavy left
    [0, 0, 2, 0], // 2579 heavy up
    [0, 2, 0, 0], // 257A heavy right
    [0, 0, 0, 2], // 257B heavy down
    [1, 2, 0, 0], // 257C light left and heavy right
    [0, 0, 1, 2], // 257D light up and heavy down
    [2, 1, 0, 0], // 257E heavy left and light right
    [0, 0, 2, 1], // 257F heavy up and light down
];
