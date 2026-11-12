//! Themes and line height through the real builder and the CPU reference
//! compositor (no GPU, no fonts: the scene is background colours only).
//!
//! What it pins: a cell's palette colour is drawn in the theme's own RGB, the
//! default cells and the margin take the theme background, and a line-height
//! multiplier gives taller rows that still tile with no gaps or overlap.

use canopy_term_render::atlas::{Atlas, Rect};
use canopy_term_render::builder::{QuadBuilder, RenderState};
use canopy_term_render::color::{Rgb, Theme};
use canopy_term_render::fonts::BUNDLED_FONT;
use canopy_term_render::frame::{Color, Frame};
use canopy_term_render::glyphs::{FontStyle, GlyphSource, PlacedGlyph, TextCell};
use canopy_term_render::metrics::{layout, layout_with, CellLayout, FontMetrics, Scale};
use canopy_term_render::reference;

/// No glyphs at all: only backgrounds are drawn.
struct NoGlyphs(Atlas<char>);

impl GlyphSource for NoGlyphs {
    fn begin_frame(&mut self) {
        self.0.begin_frame();
    }
    fn epoch(&self) -> u64 {
        self.0.epoch()
    }
    fn procedural(&mut self, _: char) -> Option<Rect> {
        None
    }
    fn shape_run(&mut self, _: FontStyle, _: &[TextCell<'_>], _: &mut Vec<PlacedGlyph>) {}
}

/// 4 columns x 3 rows: row 0 palette 1, 9 and a truecolour cell, the rest default.
fn frame() -> Frame {
    let mut f = Frame::blank(4, 3);
    f.seq = 1;
    f.cursor.visible = false;
    f.cells[0].bg = Color::Indexed(1);
    f.cells[1].bg = Color::Indexed(9);
    f.cells[2].bg = Color::Rgb(1, 2, 3);
    f.cells[5].bg = Color::Indexed(4); // row 1, col 1
    f
}

fn render(theme: Theme, l: CellLayout) -> (Vec<u8>, u32, u32) {
    let mut builder = QuadBuilder::new(l, theme);
    let mut glyphs = NoGlyphs(Atlas::new(16, 16));
    builder.build(&frame(), &RenderState::default(), &mut glyphs);
    let (w, h) = (4 * l.width, 3 * l.height);
    let px = reference::composite(builder.instances(), glyphs.0.pixels(), 16, w, h, theme.bg);
    (px, w, h)
}

fn at(px: &[u8], w: u32, x: u32, y: u32) -> Rgb {
    let o = ((y * w + x) * 4) as usize;
    [px[o], px[o + 1], px[o + 2]]
}

fn cell_layout(line_height: f32) -> CellLayout {
    let fm = FontMetrics::from_font_data(BUNDLED_FONT, 0).expect("metrics");
    layout_with(&fm, 14.0, Scale(1.0), line_height)
}

fn check_theme(theme: Theme, name: &str) {
    let l = cell_layout(1.0);
    let (px, w, _) = render(theme, l);
    let centre = |col: u32, row: u32| {
        at(
            &px,
            w,
            col * l.width + l.width / 2,
            row * l.height + l.height / 2,
        )
    };
    assert_eq!(centre(0, 0), theme.palette[1], "{name}: palette 1");
    assert_eq!(centre(1, 0), theme.palette[9], "{name}: palette 9");
    assert_eq!(centre(2, 0), [1, 2, 3], "{name}: truecolour");
    assert_eq!(centre(1, 1), theme.palette[4], "{name}: palette 4");
    assert_eq!(
        centre(3, 0),
        theme.bg,
        "{name}: a default cell is the background"
    );
    assert_eq!(
        centre(3, 2),
        theme.bg,
        "{name}: a default cell is the background"
    );
}

#[test]
fn the_dark_theme_draws_its_palette() {
    check_theme(Theme::dark(), "dark");
}

#[test]
fn the_light_theme_draws_its_palette_on_white() {
    check_theme(Theme::light(), "light");
    let (px, w, h) = render(Theme::light(), cell_layout(1.0));
    assert_eq!(at(&px, w, w - 1, h - 1), [0xff, 0xff, 0xff]);
}

#[test]
fn a_custom_palette_and_background_reach_the_pixels() {
    let mut t = Theme::dark();
    t.bg = [9, 8, 7];
    t.palette[1] = [0x11, 0x22, 0x33];
    t.palette[4] = [0x44, 0x55, 0x66];
    check_theme(t, "custom");
}

#[test]
fn line_height_makes_taller_rows_that_tile_without_gaps() {
    let plain = cell_layout(1.0);
    let tall = cell_layout(1.5);
    assert!(tall.height > plain.height);
    assert_eq!(tall.width, plain.width);
    let theme = Theme::dark();
    let (px, w, h) = render(theme, tall);
    assert_eq!(h, 3 * tall.height);
    // Row 1's coloured cell fills its whole (taller) row and stops at the edge.
    let x = tall.width + tall.width / 2;
    assert_eq!(
        at(&px, w, x, tall.height),
        theme.palette[4],
        "first line of row 1"
    );
    assert_eq!(
        at(&px, w, x, 2 * tall.height - 1),
        theme.palette[4],
        "last line of row 1"
    );
    assert_eq!(
        at(&px, w, x, tall.height - 1),
        theme.palette[9],
        "row 0 above it is its own colour"
    );
    assert_eq!(
        at(&px, w, x, 2 * tall.height),
        theme.bg,
        "row 2 below it is plain"
    );
}

#[test]
fn line_height_one_is_the_unchanged_layout() {
    let fm = FontMetrics::from_font_data(BUNDLED_FONT, 0).expect("metrics");
    assert_eq!(cell_layout(1.0), layout(&fm, 14.0, Scale(1.0)));
}
