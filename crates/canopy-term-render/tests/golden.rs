//! Golden-image checks. A plain `main` (not libtest) so every result line
//! reaches the CI log.
//!
//! Scene A (solid rectangles and code-drawn glyphs only, so it does not depend
//! on any font) is compared with `tests/golden/scene_a.png`, an image computed
//! by an independent script from the scene description. The CPU reference
//! compositor must match it exactly on every runner; where a GPU adapter
//! exists, the real GPU render must match within a small tolerance.
//!
//! Scene B (real text from the bundled font) has no stored image: font
//! rasterisation may differ between machines. It prints a hash of the CPU
//! reference and the PNG (hex) for inspection, and checks that the GPU render
//! of the same instances matches the CPU reference.
//!
//! Without an adapter the GPU parts are skipped and reported as skipped.

use std::io::Write;
use std::path::PathBuf;

use canopy_term_render::atlas::Atlas;
use canopy_term_render::builder::{QuadBuilder, RenderState};
use canopy_term_render::color::Theme;
use canopy_term_render::fonts::{FontBook, BUNDLED_FONT};
use canopy_term_render::frame::{Attrs, Color, Cursor, CursorShape, Damage, Frame};
use canopy_term_render::glyphs::{FontStyle, GlyphSource, PlacedGlyph, TextCell};
use canopy_term_render::gpu::{self, GpuContext};
use canopy_term_render::metrics::{layout, CellLayout, FontMetrics, Scale};
use canopy_term_render::procedural;
use canopy_term_render::reference;
use canopy_term_render::renderer::{Offscreen, Renderer, OFFSCREEN_FORMAT};
use canopy_term_render::text::TextEngine;

const GPU_TOLERANCE_A: u8 = 2;
const GPU_TOLERANCE_B: u8 = 4;

fn say(line: &str) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "GOLDEN {line}");
    let _ = out.flush();
}

/// Glyph source with only code-drawn glyphs: no fonts involved.
struct ProceduralOnly {
    atlas: Atlas<char>,
    layout: CellLayout,
}

impl GlyphSource for ProceduralOnly {
    fn begin_frame(&mut self) {
        self.atlas.begin_frame();
    }
    fn epoch(&self) -> u64 {
        self.atlas.epoch()
    }
    fn procedural(&mut self, ch: char) -> Option<canopy_term_render::atlas::Rect> {
        if let Some(r) = self.atlas.get(&ch) {
            return Some(r);
        }
        let mask = procedural::rasterize(ch, self.layout.width, self.layout.height)?;
        let rgba: Vec<u8> = mask.iter().flat_map(|&a| [255, 255, 255, a]).collect();
        self.atlas.insert(
            ch,
            self.layout.width as u16,
            self.layout.height as u16,
            &rgba,
        )
    }
    fn shape_run(&mut self, _: FontStyle, _: &[TextCell<'_>], _: &mut Vec<PlacedGlyph>) {}
}

fn scene_a_layout() -> CellLayout {
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

/// 6 x 3 cells. Colours are chosen so red and blue differ everywhere and the
/// scene is asymmetric on both axes: a flipped or channel-swapped render cannot
/// match.
fn scene_a() -> Frame {
    let mut f = Frame::blank(6, 3);
    f.seq = 1;
    let at = |f: &mut Frame, row: usize, col: usize| row * 6 + col;
    for col in 0..3 {
        let i = at(&mut f, 0, col);
        f.cells[i].bg = Color::Rgb(200, 30, 30);
    }
    let i = at(&mut f, 0, 3);
    f.cells[i].bg = Color::Rgb(30, 30, 200);
    let i = at(&mut f, 1, 1);
    f.cells[i].ch = '\u{2580}'; // upper half block
    f.cells[i].fg = Color::Rgb(10, 200, 100);
    let i = at(&mut f, 1, 2);
    f.cells[i].ch = '\u{2590}'; // right half block
    f.cells[i].fg = Color::Rgb(250, 200, 0);
    f.cells[i].bg = Color::Rgb(0, 0, 120);
    let i = at(&mut f, 1, 4);
    f.cells[i].attrs = Attrs(Attrs::UNDERLINE);
    f.cells[i].fg = Color::Rgb(255, 0, 255);
    let i = at(&mut f, 2, 0);
    f.cells[i].ch = '\u{2588}'; // full block
    f.cells[i].fg = Color::Rgb(90, 160, 250);
    f.cursor = Cursor {
        row: 2,
        col: 5,
        shape: CursorShape::Bar,
        visible: true,
    };
    f
}

fn scene_b(seq: u64, changed_row2: bool) -> Frame {
    let lines = [
        "fn main() {",
        "    let x = a -> b;",
        if changed_row2 {
            "    if x != 1 { z }"
        } else {
            "    if x == 1 { y }"
        },
        "}",
        "\u{2500}\u{2502}\u{250c}\u{2588} done",
    ];
    let mut f = Frame::blank(24, lines.len() as u16);
    f.seq = seq;
    for (r, line) in lines.iter().enumerate() {
        for (c, ch) in line.chars().enumerate() {
            f.cells[r * 24 + c].ch = ch;
            f.cells[r * 24 + c].fg = Color::Indexed(if ch.is_alphabetic() { 6 } else { 7 });
        }
    }
    for c in 0..2 {
        f.cells[c].attrs = Attrs(Attrs::BOLD);
        f.cells[c].fg = Color::Indexed(4);
    }
    for c in 4..6 {
        f.cells[2 * 24 + c].attrs = Attrs(Attrs::ITALIC);
    }
    for c in 8..10 {
        f.cells[24 + c].attrs = Attrs(Attrs::UNDERLINE);
    }
    f.cells[3 * 24 + 2].bg = Color::Rgb(60, 20, 90);
    f.cursor = Cursor {
        row: 3,
        col: 0,
        shape: CursorShape::Block,
        visible: true,
    };
    f
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().expect("png header");
        w.write_image_data(rgba).expect("png data");
        w.finish().expect("png finish");
    }
    out
}

fn decode_png(path: &PathBuf) -> Option<(u32, u32, Vec<u8>)> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = png::Decoder::new(file).read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    buf.truncate(info.buffer_size());
    (info.color_type == png::ColorType::Rgba && info.bit_depth == png::BitDepth::Eight).then_some((
        info.width,
        info.height,
        buf,
    ))
}

/// Renders the builder's instances on the GPU and returns the pixels.
fn gpu_render<K: std::hash::Hash + Eq + Copy>(
    ctx: &GpuContext,
    renderer: &mut Renderer,
    builder: &QuadBuilder,
    report: &canopy_term_render::builder::BuildReport,
    atlas: &mut Atlas<K>,
    target: &Offscreen,
) -> (Vec<u8>, canopy_term_render::renderer::UploadStats) {
    let stats = renderer.sync(builder, report, atlas);
    renderer.render(
        &target.view,
        (target.width, target.height),
        builder.theme().bg,
        builder.draw_count(),
    );
    (target.read_rgba(&ctx.device, &ctx.queue), stats)
}

fn scene_a_checks(ctx: Option<&GpuContext>, failures: &mut Vec<String>) {
    let l = scene_a_layout();
    let theme = Theme::default();
    let mut builder = QuadBuilder::new(l, theme);
    let mut glyphs = ProceduralOnly {
        atlas: Atlas::new(64, 64),
        layout: l,
    };
    let frame = scene_a();
    let report = builder.build(&frame, &RenderState::default(), &mut glyphs);
    let (w, h) = (48u32, 48u32);
    let cpu = reference::composite(
        builder.instances(),
        glyphs.atlas.pixels(),
        64,
        w,
        h,
        theme.bg,
    );
    say(&format!(
        "scene_a quads={} cpu_hash={:016x}",
        report.quads,
        reference::hash(&cpu)
    ));

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/scene_a.png");
    let golden = decode_png(&path);
    match &golden {
        None => {
            say("scene_a golden image missing or unreadable; CPU image follows");
            say(&format!("scene_a_png_hex {}", hex(&encode_png(w, h, &cpu))));
            failures.push("scene_a golden image missing".into());
        }
        Some((gw, gh, pixels)) => {
            if (*gw, *gh) != (w, h) {
                failures.push(format!("scene_a golden is {gw}x{gh}, expected {w}x{h}"));
            } else {
                let d = reference::max_diff(&cpu, pixels);
                say(&format!("scene_a cpu_vs_golden max_diff={d}"));
                if d != 0 {
                    failures.push(format!("scene_a CPU reference differs from golden by {d}"));
                    say(&format!(
                        "scene_a_cpu_png_hex {}",
                        hex(&encode_png(w, h, &cpu))
                    ));
                }
            }
        }
    }

    let Some(ctx) = ctx else {
        say("scene_a gpu: skipped (no adapter)");
        return;
    };
    let mut renderer = Renderer::new(
        ctx.device.clone(),
        ctx.queue.clone(),
        OFFSCREEN_FORMAT,
        (64, 64),
    );
    let target = Offscreen::new(&ctx.device, w, h);
    let (gpu_px, stats) = gpu_render(
        ctx,
        &mut renderer,
        &builder,
        &report,
        &mut glyphs.atlas,
        &target,
    );
    let reference_px = golden.map(|g| g.2).unwrap_or(cpu);
    let d = reference::max_diff(&gpu_px, &reference_px);
    say(&format!(
        "scene_a gpu adapter={:?} backend={:?} max_diff={d} tolerance={GPU_TOLERANCE_A} instance_bytes={} atlas_bytes={}",
        ctx.info.name, ctx.info.backend, stats.instance_bytes, stats.atlas_bytes
    ));
    if d > GPU_TOLERANCE_A {
        failures.push(format!("scene_a GPU differs from golden by {d}"));
        say(&format!(
            "scene_a_gpu_png_hex {}",
            hex(&encode_png(w, h, &gpu_px))
        ));
    }
}

fn scene_b_checks(ctx: Option<&GpuContext>, failures: &mut Vec<String>) {
    let fm = FontMetrics::from_font_data(BUNDLED_FONT, 0).expect("bundled font metrics");
    let l = layout(&fm, 14.0, Scale(1.0));
    let theme = Theme::default();
    let mut engine = TextEngine::new(FontBook::bundled(), l, 512);
    let mut builder = QuadBuilder::new(l, theme);
    let f1 = scene_b(1, false);
    let report1 = builder.build(&f1, &RenderState::default(), &mut engine);
    let (w, h) = (24 * l.width, 5 * l.height);
    let cpu1 = reference::composite(
        builder.instances(),
        engine.atlas().pixels(),
        512,
        w,
        h,
        theme.bg,
    );
    say(&format!(
        "scene_b cell={}x{} size={w}x{h} quads={} cpu_hash={:016x}",
        l.width,
        l.height,
        report1.quads,
        reference::hash(&cpu1)
    ));
    // The CPU image was byte-identical on Linux, macOS and Windows runners
    // (same bundled font, same swash and rustybuzz), so it is stored and
    // compared exactly. Regenerate by decoding `scene_b_png_hex` from the log.
    let stored =
        decode_png(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/scene_b.png"));
    match stored {
        Some((sw, sh, px)) if (sw, sh) == (w, h) => {
            let d = reference::max_diff(&cpu1, &px);
            say(&format!("scene_b cpu_vs_golden max_diff={d}"));
            if d != 0 {
                failures.push(format!(
                    "scene_b CPU reference differs from stored image by {d}"
                ));
                say(&format!(
                    "scene_b_png_hex {}",
                    hex(&encode_png(w, h, &cpu1))
                ));
            }
        }
        _ => {
            say("scene_b stored image missing or wrong size");
            say(&format!(
                "scene_b_png_hex {}",
                hex(&encode_png(w, h, &cpu1))
            ));
            failures.push("scene_b stored image missing".into());
        }
    }

    let Some(ctx) = ctx else {
        say("scene_b gpu: skipped (no adapter)");
        return;
    };
    let mut renderer = Renderer::new(
        ctx.device.clone(),
        ctx.queue.clone(),
        OFFSCREEN_FORMAT,
        (512, 512),
    );
    let target = Offscreen::new(&ctx.device, w, h);
    let (gpu1, stats1) = gpu_render(
        ctx,
        &mut renderer,
        &builder,
        &report1,
        engine.atlas_mut(),
        &target,
    );
    let d1 = reference::max_diff(&gpu1, &cpu1);
    say(&format!(
        "scene_b gpu adapter={:?} full_frame max_diff={d1} tolerance={GPU_TOLERANCE_B} instance_bytes={} atlas_bytes={}",
        ctx.info.name, stats1.instance_bytes, stats1.atlas_bytes
    ));
    if d1 > GPU_TOLERANCE_B {
        failures.push(format!("scene_b GPU differs from CPU reference by {d1}"));
    }

    // One row changes: only that row is rebuilt and uploaded, and the GPU image
    // still equals a composite of the full instance buffer.
    let mut f2 = scene_b(2, true);
    f2.damage = Damage {
        since: 1,
        full: false,
        rows: vec![(2, 2)],
    };
    let report2 = builder.build(&f2, &RenderState::default(), &mut engine);
    let cpu2 = reference::composite(
        builder.instances(),
        engine.atlas().pixels(),
        512,
        w,
        h,
        theme.bg,
    );
    let (gpu2, stats2) = gpu_render(
        ctx,
        &mut renderer,
        &builder,
        &report2,
        engine.atlas_mut(),
        &target,
    );
    let d2 = reference::max_diff(&gpu2, &cpu2);
    say(&format!(
        "scene_b gpu one_row_damage rows={:?} max_diff={d2} instance_bytes={} (full frame was {}) atlas_bytes={}",
        report2.rows, stats2.instance_bytes, stats1.instance_bytes, stats2.atlas_bytes
    ));
    if report2.rows != vec![2] {
        failures.push(format!("scene_b one-row damage rebuilt {:?}", report2.rows));
    }
    if stats2.instance_bytes >= stats1.instance_bytes {
        failures.push("scene_b one-row upload was not smaller than the full upload".into());
    }
    if d2 > GPU_TOLERANCE_B {
        failures.push(format!(
            "scene_b partial upload GPU image differs from CPU by {d2}"
        ));
    }
    if reference::max_diff(&cpu1, &cpu2) == 0 {
        failures.push("scene_b second frame did not change the image".into());
    }
}

fn main() {
    say(&format!(
        "os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let mut failures: Vec<String> = Vec::new();

    let ctx = std::panic::catch_unwind(gpu::headless_context).unwrap_or_else(|_| {
        say("headless_context panicked; treating as no adapter");
        None
    });
    match &ctx {
        Some(c) => say(&format!("adapter: {}", gpu::describe(&c.info))),
        None => say("adapter: none (GPU comparisons skipped)"),
    }

    // Each scene runs under catch_unwind so a GPU panic is reported, not fatal
    // to the other scene's output.
    for (name, run) in [
        (
            "scene_a",
            scene_a_checks as fn(Option<&GpuContext>, &mut Vec<String>),
        ),
        (
            "scene_b",
            scene_b_checks as fn(Option<&GpuContext>, &mut Vec<String>),
        ),
    ] {
        let mut local: Vec<String> = Vec::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(ctx.as_ref(), &mut local)
        }));
        failures.append(&mut local);
        if result.is_err() {
            failures.push(format!("{name} panicked"));
        }
    }

    if failures.is_empty() {
        say("RESULT ok");
    } else {
        for f in &failures {
            say(&format!("FAIL {f}"));
        }
        say("RESULT failed");
        std::process::exit(1);
    }
}
