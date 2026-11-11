//! Report-only performance numbers. Nothing here asserts on timing: it prints
//! `PERF key=value` lines for the CI log. A plain `main` so the output is not
//! captured. Note the build profile: `cargo test` builds with the dev profile
//! unless told otherwise, so absolute numbers are pessimistic.

use std::io::Write;
use std::time::Instant;

use canopy_term_render::atlas::Atlas;
use canopy_term_render::builder::{QuadBuilder, RenderState};
use canopy_term_render::color::Theme;
use canopy_term_render::fonts::{FontBook, BUNDLED_FONT};
use canopy_term_render::frame::{Attrs, Color, Damage, Frame};
use canopy_term_render::glyphs::{FontStyle, GlyphSource, TextCell};
use canopy_term_render::metrics::{layout, FontMetrics, Scale};
use canopy_term_render::text::TextEngine;

const COLS: u16 = 120;
const ROWS: u16 = 40;

fn say(line: &str) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "PERF {line}");
    let _ = out.flush();
}

/// A deterministic, synthetic screen of code-like text with colour, a few
/// backgrounds and underlines.
fn synthetic_frame() -> Frame {
    let words = [
        "fn", "let", "mut", "->", "=>", "==", "{", "}", "(", ")", ";", "value", "count", "0123",
        "if", "else", "match", "::", "&str", "//",
    ];
    let mut f = Frame::blank(COLS, ROWS);
    for r in 0..ROWS as usize {
        let mut c = 0usize;
        let mut w = r;
        while c < COLS as usize {
            let word = words[w % words.len()];
            for ch in word.chars() {
                if c >= COLS as usize {
                    break;
                }
                let cell = &mut f.cells[r * COLS as usize + c];
                cell.ch = ch;
                cell.fg = Color::Indexed(((r + w) % 8) as u8);
                if (r + c) % 37 == 0 {
                    cell.bg = Color::Indexed(4);
                }
                if w % 11 == 0 {
                    cell.attrs = Attrs(Attrs::UNDERLINE);
                }
                c += 1;
            }
            c += 1; // a space between words
            w += 1;
        }
    }
    f.cursor.visible = false;
    f
}

fn main() {
    say(&format!(
        "profile={} os={} arch={}",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let fm = FontMetrics::from_font_data(BUNDLED_FONT, 0).expect("font metrics");
    let l = layout(&fm, 14.0, Scale(1.0));
    say(&format!(
        "grid={COLS}x{ROWS} cell={}x{} font_px={}",
        l.width, l.height, l.font_px
    ));

    // 1. Glyph rasterising and packing: every printable ASCII glyph, cold.
    let mut engine = TextEngine::new(FontBook::bundled(), l, 1024);
    let text: Vec<String> = (33u8..127).map(|b| (b as char).to_string()).collect();
    let cells: Vec<TextCell<'_>> = text
        .iter()
        .map(|t| TextCell {
            text: t.as_str(),
            cols: 1,
        })
        .collect();
    let mut placed = Vec::new();
    let t0 = Instant::now();
    engine.shape_run(FontStyle::default(), &cells, &mut placed);
    let cold = t0.elapsed();
    let dirty: usize = engine
        .atlas_mut()
        .take_dirty()
        .iter()
        .map(|r| r.w as usize * r.h as usize * 4)
        .sum();
    say(&format!(
        "ascii_cold_shape_raster_pack glyphs={} micros={} atlas_upload_bytes={}",
        placed.len(),
        cold.as_micros(),
        dirty
    ));
    let t0 = Instant::now();
    placed.clear();
    engine.shape_run(FontStyle::default(), &cells, &mut placed);
    say(&format!(
        "ascii_warm_shape glyphs={} micros={}",
        placed.len(),
        t0.elapsed().as_micros()
    ));

    // 2. The allocator alone: pack many glyph-sized bitmaps into a fresh atlas.
    let mut atlas: Atlas<u32> = Atlas::new(1024, 1024);
    let bitmap = vec![255u8; 8 * 16 * 4];
    let t0 = Instant::now();
    let mut packed = 0u32;
    for k in 0..4000u32 {
        if atlas.insert(k, 8, 16, &bitmap).is_some() {
            packed += 1;
        }
    }
    say(&format!(
        "atlas_pack bitmaps={packed} micros={}",
        t0.elapsed().as_micros()
    ));

    // 3. Quad building: full frame vs one-row damage (atlas already warm).
    let theme = Theme::default();
    let mut builder = QuadBuilder::new(l, theme);
    let state = RenderState::default();
    let mut frame = synthetic_frame();
    frame.seq = 1;
    builder.build(&frame, &state, &mut engine); // warm the atlas and the buffer
    engine.atlas_mut().take_dirty();

    let full_iters = 30u32;
    let mut quads_full = 0usize;
    let mut bytes_full = 0usize;
    let t0 = Instant::now();
    for _ in 0..full_iters {
        let prev = frame.seq;
        frame.seq += 1;
        frame.damage = Damage {
            since: prev,
            full: true,
            rows: Vec::new(),
        };
        let r = builder.build(&frame, &state, &mut engine);
        quads_full = r.quads;
        bytes_full = r.upload_bytes();
    }
    let full = t0.elapsed();
    say(&format!(
        "build_full_frame quads={quads_full} upload_bytes={bytes_full} iters={full_iters} micros_per_frame={} quads_per_sec={:.0}",
        full.as_micros() / full_iters as u128,
        quads_full as f64 * full_iters as f64 / full.as_secs_f64()
    ));

    let row_iters = 500u32;
    let mut quads_row = 0usize;
    let mut bytes_row = 0usize;
    let t0 = Instant::now();
    for i in 0..row_iters {
        let prev = frame.seq;
        frame.seq += 1;
        let row = (i % ROWS as u32) as u16;
        frame.damage = Damage {
            since: prev,
            full: false,
            rows: vec![(row, row)],
        };
        let r = builder.build(&frame, &state, &mut engine);
        quads_row = r.quads;
        bytes_row = r.upload_bytes();
    }
    let one = t0.elapsed();
    say(&format!(
        "build_one_row quads={quads_row} upload_bytes={bytes_row} iters={row_iters} micros_per_frame={} quads_per_sec={:.0}",
        one.as_micros() / row_iters as u128,
        quads_row as f64 * row_iters as f64 / one.as_secs_f64()
    ));

    let idle_iters = 5000u32;
    let t0 = Instant::now();
    let mut idle_quads = 0usize;
    for _ in 0..idle_iters {
        let prev = frame.seq;
        frame.seq += 1;
        frame.damage = Damage {
            since: prev,
            full: false,
            rows: Vec::new(),
        };
        idle_quads += builder.build(&frame, &state, &mut engine).quads;
    }
    say(&format!(
        "build_unchanged quads={idle_quads} iters={idle_iters} micros_per_frame={}",
        t0.elapsed().as_micros() / idle_iters as u128
    ));
    say(&format!(
        "instance_bytes={} buffer_bytes={}",
        std::mem::size_of::<canopy_term_render::instance::Instance>(),
        builder.instances().len() * std::mem::size_of::<canopy_term_render::instance::Instance>()
    ));
    let a = engine.atlas().stats();
    say(&format!(
        "atlas entries={} inserts={} hits={} evicted_shelves={}",
        a.entries, a.inserts, a.hits, a.evicted_shelves
    ));
}
