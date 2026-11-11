//! The real `GlyphSource`: shapes runs with rustybuzz (MIT), rasterises with
//! swash (MIT/Apache-2.0) and packs the bitmaps into the atlas.
//!
//! Terminal rules applied here:
//! * The grid, not the font, decides positions: a glyph is placed at its cell
//!   origin plus the rasteriser's bearing plus the shaper's mark offset.
//!   Advances are ignored, so a proportional fallback face cannot push text off
//!   the grid.
//! * A run is split into segments per face (fallback fonts), then shaped as one
//!   string per segment so contextual alternates and ligatures form.
//! * A cluster's glyphs (base plus combining marks) all start at the cell the
//!   cluster starts in.
//! * Colour bitmaps (emoji) are area-resampled to the cell height.

use std::collections::{HashMap, HashSet};

use rustybuzz::{Direction, UnicodeBuffer};
use swash::scale::image::Content;
use swash::scale::{Render, ScaleContext, Source, StrikeWith};
use swash::zeno::{Angle, Format, Transform};
use swash::FontRef;

use crate::atlas::{Atlas, Rect};
use crate::fonts::{FaceChoice, FontBook};
use crate::glyphs::{FontStyle, GlyphSource, PlacedGlyph, TextCell};
use crate::metrics::CellLayout;
use crate::procedural;

const FLAG_SYNTH_BOLD: u8 = 1;
const FLAG_SYNTH_ITALIC: u8 = 2;
const FLAG_PROCEDURAL: u8 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct GlyphKey {
    face: u32,
    glyph: u32,
    px: u16,
    flags: u8,
}

#[derive(Clone, Copy)]
struct Meta {
    left: i32,
    top: i32,
    color: bool,
}

struct Raster {
    w: u16,
    h: u16,
    left: i32,
    top: i32,
    rgba: Vec<u8>,
    color: bool,
}

pub struct TextEngine {
    fonts: FontBook,
    atlas: Atlas<GlyphKey>,
    scale: ScaleContext,
    layout: CellLayout,
    meta: HashMap<GlyphKey, Meta>,
    /// Glyphs that rasterise to nothing (spaces, marks without ink).
    blanks: HashSet<GlyphKey>,
    /// The atlas was already cleared during this frame.
    cleared_this_frame: bool,
    /// A glyph was dropped because the atlas stayed full.
    overflowed: bool,
    ligatures: bool,
    /// Buffers reused across runs so steady-state shaping does not allocate
    /// them again.
    shape_text: String,
    shape_starts: Vec<usize>,
    shape_choices: Vec<Option<FaceChoice>>,
    buzz_buffer: Option<UnicodeBuffer>,
}

/// Index of the cell whose text contains byte offset `byte`, given each cell's
/// starting byte offset (ascending).
pub fn cell_for_byte(starts: &[usize], byte: usize) -> usize {
    starts.partition_point(|&s| s <= byte).saturating_sub(1)
}

/// Area-averages RGBA (straight alpha) down or up to `nw x nh`, averaging in
/// premultiplied space so transparent texels do not darken the edges.
pub fn resample_rgba(src: &[u8], w: u32, h: u32, nw: u32, nh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        let sy0 = y * h / nh;
        let sy1 = (((y + 1) * h).div_ceil(nh)).clamp(sy0 + 1, h);
        for x in 0..nw {
            let sx0 = x * w / nw;
            let sx1 = (((x + 1) * w).div_ceil(nw)).clamp(sx0 + 1, w);
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = ((sy * w + sx) * 4) as usize;
                    let alpha = src[i + 3] as u64;
                    r += src[i] as u64 * alpha;
                    g += src[i + 1] as u64 * alpha;
                    b += src[i + 2] as u64 * alpha;
                    a += alpha;
                    n += 1;
                }
            }
            let o = ((y * nw + x) * 4) as usize;
            if a > 0 {
                out[o] = (r / a) as u8;
                out[o + 1] = (g / a) as u8;
                out[o + 2] = (b / a) as u8;
                out[o + 3] = (a / n) as u8;
            }
        }
    }
    out
}

impl TextEngine {
    pub fn new(fonts: FontBook, layout: CellLayout, atlas_size: u16) -> Self {
        TextEngine {
            fonts,
            atlas: Atlas::new(atlas_size, atlas_size),
            scale: ScaleContext::new(),
            layout,
            meta: HashMap::new(),
            blanks: HashSet::new(),
            cleared_this_frame: false,
            overflowed: false,
            ligatures: true,
            shape_text: String::new(),
            shape_starts: Vec::new(),
            shape_choices: Vec::new(),
            buzz_buffer: None,
        }
    }

    /// Turns ligatures and contextual alternates (`liga`, `clig`, `calt`) on or
    /// off. Changing it redraws everything.
    pub fn set_ligatures(&mut self, on: bool) {
        if on != self.ligatures {
            self.ligatures = on;
            self.atlas.clear();
            self.meta.clear();
        }
    }

    pub fn atlas(&self) -> &Atlas<GlyphKey> {
        &self.atlas
    }

    pub fn atlas_mut(&mut self) -> &mut Atlas<GlyphKey> {
        &mut self.atlas
    }

    pub fn layout(&self) -> &CellLayout {
        &self.layout
    }

    /// A new cell size or font size invalidates every rasterised glyph.
    pub fn set_layout(&mut self, layout: CellLayout) {
        if layout != self.layout {
            self.layout = layout;
            self.atlas.clear();
            self.meta.clear();
            self.blanks.clear();
        }
    }

    fn key(&self, choice: FaceChoice, glyph: u32) -> GlyphKey {
        GlyphKey {
            face: choice.face,
            glyph,
            px: self.layout.font_px as u16,
            flags: if choice.synth_bold {
                FLAG_SYNTH_BOLD
            } else {
                0
            } | if choice.synth_italic {
                FLAG_SYNTH_ITALIC
            } else {
                0
            },
        }
    }

    fn rasterize(&mut self, key: GlyphKey) -> Option<Raster> {
        let loaded = self.fonts.face(key.face);
        let font = FontRef::from_index(&loaded.data[..], loaded.index as usize)?;
        let mut scaler = self
            .scale
            .builder(font)
            .size(key.px as f32)
            .hint(false)
            .build();
        let sources = [
            Source::ColorBitmap(StrikeWith::BestFit),
            Source::ColorOutline(0),
            Source::Outline,
        ];
        let mut render = Render::new(&sources);
        render.format(Format::Alpha);
        if key.flags & FLAG_SYNTH_BOLD != 0 {
            render.embolden(key.px as f32 / 36.0);
        }
        if key.flags & FLAG_SYNTH_ITALIC != 0 {
            render.transform(Some(Transform::skew(
                Angle::from_degrees(14.0),
                Angle::from_degrees(0.0),
            )));
        }
        let image = render.render(&mut scaler, key.glyph as u16)?;
        let p = image.placement;
        if p.width == 0 || p.height == 0 {
            return None;
        }
        match image.content {
            Content::Mask => {
                let mut rgba = Vec::with_capacity(image.data.len() * 4);
                for &a in &image.data {
                    rgba.extend_from_slice(&[255, 255, 255, a]);
                }
                Some(Raster {
                    w: p.width as u16,
                    h: p.height as u16,
                    left: p.left,
                    top: p.top,
                    rgba,
                    color: false,
                })
            }
            Content::Color => {
                let s = (self.layout.height as f32 / p.height as f32)
                    .min((2 * self.layout.width) as f32 / p.width as f32);
                let nw = ((p.width as f32 * s).round() as u32).max(1);
                let nh = ((p.height as f32 * s).round() as u32).max(1);
                let rgba = resample_rgba(&image.data, p.width, p.height, nw, nh);
                Some(Raster {
                    w: nw as u16,
                    h: nh as u16,
                    left: (p.left as f32 * s).round() as i32,
                    top: (p.top as f32 * s).round() as i32,
                    rgba,
                    color: true,
                })
            }
            Content::SubpixelMask => None,
        }
    }

    /// Inserts into the atlas. A bitmap that can never fit is remembered as
    /// blank (no clear). When the atlas is full it is cleared at most once per
    /// frame (bumping the epoch so the builder redraws); a second overflow in
    /// the same frame leaves the glyph blank and raises `overflowed`.
    fn pack(&mut self, key: GlyphKey, w: u16, h: u16, rgba: &[u8]) -> Option<Rect> {
        if !self.atlas.can_ever_fit(w, h) {
            self.blanks.insert(key);
            return None;
        }
        if let Some(r) = self.atlas.insert(key, w, h, rgba) {
            return Some(r);
        }
        if self.cleared_this_frame {
            self.overflowed = true;
            return None;
        }
        self.cleared_this_frame = true;
        self.atlas.clear();
        self.meta.clear();
        let placed = self.atlas.insert(key, w, h, rgba);
        if placed.is_none() {
            // It does not fit even in an empty atlas: stop retrying it.
            self.blanks.insert(key);
        }
        placed
    }

    fn glyph(&mut self, key: GlyphKey) -> Option<(Rect, Meta)> {
        if self.blanks.contains(&key) {
            return None;
        }
        if let Some(rect) = self.atlas.get(&key) {
            if let Some(&m) = self.meta.get(&key) {
                return Some((rect, m));
            }
        }
        let Some(r) = self.rasterize(key) else {
            self.blanks.insert(key);
            return None;
        };
        let rect = self.pack(key, r.w, r.h, &r.rgba)?;
        let m = Meta {
            left: r.left,
            top: r.top,
            color: r.color,
        };
        self.meta.insert(key, m);
        Some((rect, m))
    }

    fn shape_segment(
        &mut self,
        choice: FaceChoice,
        cells: &[TextCell<'_>],
        first_cell: usize,
        out: &mut Vec<PlacedGlyph>,
    ) {
        let mut text = std::mem::take(&mut self.shape_text);
        text.clear();
        let mut starts = std::mem::take(&mut self.shape_starts);
        starts.clear();
        for c in cells {
            starts.push(text.len());
            text.push_str(c.text);
        }
        let loaded = self.fonts.face(choice.face);
        let upem = loaded.units_per_em.max(1) as f32;
        let mut buffer = self.buzz_buffer.take().unwrap_or_else(UnicodeBuffer::new);
        buffer.push_str(&text);
        buffer.guess_segment_properties();
        buffer.set_direction(Direction::LeftToRight);
        let off = |tag: &[u8; 4]| {
            rustybuzz::Feature::new(rustybuzz::ttf_parser::Tag::from_bytes(tag), 0, ..)
        };
        let no_ligatures = [off(b"liga"), off(b"clig"), off(b"calt")];
        let features: &[rustybuzz::Feature] = if self.ligatures { &[] } else { &no_ligatures };
        let shaped = rustybuzz::shape(&loaded.buzz, features, buffer);
        let k = self.layout.font_px as f32 / upem;
        let infos = shaped.glyph_infos();
        let positions = shaped.glyph_positions();
        for (info, pos) in infos.iter().zip(positions) {
            let cell = cell_for_byte(&starts, info.cluster as usize);
            let key = self.key(choice, info.glyph_id);
            let Some((rect, m)) = self.glyph(key) else {
                continue;
            };
            out.push(PlacedGlyph {
                cell: (first_cell + cell) as u16,
                rect,
                left: m.left + (pos.x_offset as f32 * k).round() as i32,
                top: m.top + (pos.y_offset as f32 * k).round() as i32,
                color: m.color,
            });
        }
        self.buzz_buffer = Some(shaped.clear());
        self.shape_text = text;
        self.shape_starts = starts;
    }
}

impl GlyphSource for TextEngine {
    fn begin_frame(&mut self) {
        self.atlas.begin_frame();
        self.cleared_this_frame = false;
    }

    fn overflowed(&mut self) -> bool {
        std::mem::take(&mut self.overflowed)
    }

    fn epoch(&self) -> u64 {
        self.atlas.epoch()
    }

    fn procedural(&mut self, ch: char) -> Option<Rect> {
        let key = GlyphKey {
            face: u32::MAX,
            glyph: ch as u32,
            px: 0,
            flags: FLAG_PROCEDURAL,
        };
        if let Some(r) = self.atlas.get(&key) {
            return Some(r);
        }
        let (w, h) = (self.layout.width, self.layout.height);
        let mask = procedural::rasterize(ch, w, h)?;
        let mut rgba = Vec::with_capacity(mask.len() * 4);
        for &a in &mask {
            rgba.extend_from_slice(&[255, 255, 255, a]);
        }
        self.pack(key, w as u16, h as u16, &rgba)
    }

    fn shape_run(&mut self, style: FontStyle, cells: &[TextCell<'_>], out: &mut Vec<PlacedGlyph>) {
        let mut choices = std::mem::take(&mut self.shape_choices);
        choices.clear();
        for c in cells {
            let ch = c.text.chars().next().unwrap_or(' ');
            let choice = self
                .fonts
                .choose(ch, style)
                .or_else(|| self.fonts.primary_choice(style));
            choices.push(choice);
        }
        let mut i = 0;
        while i < cells.len() {
            let mut j = i + 1;
            while j < cells.len() && choices[j] == choices[i] {
                j += 1;
            }
            if let Some(choice) = choices[i] {
                self.shape_segment(choice, &cells[i..j], i, out);
            }
            i = j;
        }
        self.shape_choices = choices;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts::BUNDLED_FONT;
    use crate::metrics::{layout, FontMetrics, Scale};

    const REGULAR: FontStyle = FontStyle {
        bold: false,
        italic: false,
    };

    fn engine() -> TextEngine {
        let fm = FontMetrics::from_font_data(BUNDLED_FONT, 0).unwrap();
        TextEngine::new(FontBook::bundled(), layout(&fm, 14.0, Scale(1.0)), 512)
    }

    fn cells<'a>(texts: &[&'a str]) -> Vec<TextCell<'a>> {
        texts
            .iter()
            .map(|t| TextCell { text: *t, cols: 1 })
            .collect()
    }

    fn ink(e: &TextEngine, r: Rect) -> u64 {
        let (aw, _) = e.atlas().size();
        let px = e.atlas().pixels();
        let mut sum = 0u64;
        for y in r.y..r.y + r.h {
            for x in r.x..r.x + r.w {
                sum += px[(y as usize * aw as usize + x as usize) * 4 + 3] as u64;
            }
        }
        sum
    }

    #[test]
    fn a_letter_shapes_to_one_glyph_with_ink_near_the_baseline() {
        let mut e = engine();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&["H"]), &mut out);
        assert_eq!(out.len(), 1);
        let g = out[0];
        assert_eq!(g.cell, 0);
        assert!(!g.color);
        assert!(g.rect.w > 0 && g.rect.h > 0);
        assert!(ink(&e, g.rect) > 0);
        let l = *e.layout();
        // Cap height: the glyph's top is above the baseline and below the cell top.
        assert!(
            g.top > 0 && (g.top as u32) < l.baseline + 1,
            "top {}",
            g.top
        );
        assert!(g.left >= 0 && (g.left as u32) < l.width);
    }

    #[test]
    fn each_cell_gets_its_own_glyph_in_order() {
        let mut e = engine();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&["a", "b", "c"]), &mut out);
        assert_eq!(
            out.iter().map(|g| g.cell).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn spaces_produce_no_glyphs() {
        let mut e = engine();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&[" ", "a", " "]), &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].cell, 1);
    }

    #[test]
    fn ligatures_change_what_is_drawn() {
        // JetBrains Mono forms ligatures with `calt`. Depending on how the font
        // builds them, glyphs are substituted per cell or a spacer/wide-glyph
        // pair is used; either way shaping a pair together differs from shaping
        // each character alone.
        let mut e = engine();
        let mut changed = Vec::new();
        for pair in ["->", "=>", "==", "!=", ">=", "<=", "::", "//", "<-", "|>"] {
            let chars: Vec<String> = pair.chars().map(|c| c.to_string()).collect();
            let refs: Vec<&str> = chars.iter().map(|s| s.as_str()).collect();
            let mut together = Vec::new();
            e.shape_run(REGULAR, &cells(&refs), &mut together);
            let mut apart = Vec::new();
            for (i, r) in refs.iter().enumerate() {
                let mut one = Vec::new();
                e.shape_run(REGULAR, &cells(&[*r]), &mut one);
                apart.extend(one.into_iter().map(|mut g| {
                    g.cell = i as u16;
                    g
                }));
            }
            if together != apart {
                changed.push(pair);
            }
        }
        assert!(
            !changed.is_empty(),
            "no ligature substitution observed in any pair"
        );
    }

    #[test]
    fn with_ligatures_off_a_pair_shapes_like_its_parts() {
        let mut e = engine();
        e.set_ligatures(false);
        for pair in ["->", "=>", "==", "!=", ">=", "<=", "::", "//", "<-", "|>"] {
            let chars: Vec<String> = pair.chars().map(|c| c.to_string()).collect();
            let refs: Vec<&str> = chars.iter().map(|s| s.as_str()).collect();
            let mut together = Vec::new();
            e.shape_run(REGULAR, &cells(&refs), &mut together);
            let mut apart = Vec::new();
            for (i, r) in refs.iter().enumerate() {
                let mut one = Vec::new();
                e.shape_run(REGULAR, &cells(&[*r]), &mut one);
                apart.extend(one.into_iter().map(|mut g| {
                    g.cell = i as u16;
                    g
                }));
            }
            assert_eq!(together, apart, "{pair}");
        }
    }

    #[test]
    fn a_full_atlas_clears_once_per_frame_then_leaves_glyphs_blank() {
        let fm = FontMetrics::from_font_data(BUNDLED_FONT, 0).unwrap();
        let l = layout(&fm, 14.0, Scale(1.0));
        let mut e = TextEngine::new(FontBook::bundled(), l, 32);
        e.begin_frame();
        let before = e.epoch();
        let letters: Vec<String> = ('a'..='z').map(|c| c.to_string()).collect();
        let refs: Vec<&str> = letters.iter().map(|s| s.as_str()).collect();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&refs), &mut out);
        assert!(e.epoch() > before, "the atlas was cleared");
        let after = e.epoch();
        assert!(out.len() < 26, "the rest are blank, not wrong");
        let mut again_same_frame = Vec::new();
        e.shape_run(REGULAR, &cells(&refs), &mut again_same_frame);
        assert_eq!(e.epoch(), after, "no second clear within the frame");
        assert!(e.overflowed(), "overflow is reported");
        assert!(!e.overflowed(), "and then reset");
        // A new frame may clear again.
        e.begin_frame();
        let mut again = Vec::new();
        e.shape_run(REGULAR, &cells(&refs), &mut again);
        assert!(e.epoch() > after, "a new frame may clear again");
    }

    #[test]
    fn a_glyph_that_can_never_fit_is_blank_and_does_not_thrash_the_atlas() {
        let fm = FontMetrics::from_font_data(BUNDLED_FONT, 0).unwrap();
        let l = layout(&fm, 14.0, Scale(1.0));
        let mut e = TextEngine::new(FontBook::bundled(), l, 8);
        let before = e.epoch();
        for _ in 0..3 {
            e.begin_frame();
            let mut out = Vec::new();
            e.shape_run(REGULAR, &cells(&["H", "W"]), &mut out);
            assert!(out.is_empty());
        }
        assert_eq!(e.epoch(), before, "no clear for a glyph that cannot fit");
        assert!(!e.overflowed());
    }

    #[test]
    fn a_combining_cluster_draws_all_its_glyphs_from_one_cell() {
        let mut e = engine();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&["e\u{301}", "x"]), &mut out);
        assert!(out.len() >= 2, "base, mark and the next cell");
        let first_cell: Vec<_> = out.iter().filter(|g| g.cell == 0).collect();
        assert!(!first_cell.is_empty());
        assert!(out.iter().any(|g| g.cell == 1));
        assert!(out.iter().all(|g| g.cell <= 1));
    }

    #[test]
    fn a_wide_cell_is_still_one_cell_of_input() {
        let mut e = engine();
        let wide = [
            TextCell { text: "a", cols: 2 },
            TextCell { text: "b", cols: 1 },
        ];
        let mut out = Vec::new();
        e.shape_run(REGULAR, &wide, &mut out);
        assert_eq!(out.iter().map(|g| g.cell).collect::<Vec<_>>(), vec![0, 1]);
    }

    #[test]
    fn synthetic_bold_has_more_ink_and_synthetic_italic_is_a_different_glyph() {
        let mut e = engine();
        let (mut reg, mut bold, mut italic) = (Vec::new(), Vec::new(), Vec::new());
        e.shape_run(REGULAR, &cells(&["l"]), &mut reg);
        e.shape_run(
            FontStyle {
                bold: true,
                italic: false,
            },
            &cells(&["l"]),
            &mut bold,
        );
        e.shape_run(
            FontStyle {
                bold: false,
                italic: true,
            },
            &cells(&["l"]),
            &mut italic,
        );
        assert!(ink(&e, bold[0].rect) > ink(&e, reg[0].rect));
        assert_ne!(italic[0].rect, reg[0].rect);
    }

    #[test]
    fn shaping_the_same_text_again_uploads_nothing() {
        let mut e = engine();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&["h", "i"]), &mut out);
        assert!(!e.atlas_mut().take_dirty().is_empty());
        let mut again = Vec::new();
        e.shape_run(REGULAR, &cells(&["h", "i"]), &mut again);
        assert_eq!(out, again);
        assert!(e.atlas_mut().take_dirty().is_empty(), "no new texels");
    }

    #[test]
    fn a_missing_glyph_still_draws_the_primary_faces_box() {
        let mut e = engine();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&["\u{10FFF0}"]), &mut out);
        assert!(
            out.len() <= 1,
            "at most the primary face's missing-glyph box"
        );
    }

    #[test]
    fn procedural_glyphs_are_exactly_one_cell() {
        let mut e = engine();
        let l = *e.layout();
        let r = e.procedural('█').unwrap();
        assert_eq!((r.w as u32, r.h as u32), (l.width, l.height));
        assert_eq!(ink(&e, r), 255 * (l.width * l.height) as u64);
        assert_eq!(e.procedural('a'), None);
        assert_eq!(e.procedural('█'), Some(r), "cached");
    }

    #[test]
    fn a_new_layout_clears_the_atlas_and_bumps_the_epoch() {
        let mut e = engine();
        let mut out = Vec::new();
        e.shape_run(REGULAR, &cells(&["a"]), &mut out);
        let before = e.epoch();
        let mut l = *e.layout();
        l.font_px += 2;
        e.set_layout(l);
        assert!(e.epoch() > before);
    }

    #[test]
    fn bytes_map_to_the_cell_they_start_in() {
        let starts = [0, 1, 4, 5];
        assert_eq!(cell_for_byte(&starts, 0), 0);
        assert_eq!(cell_for_byte(&starts, 1), 1);
        assert_eq!(cell_for_byte(&starts, 3), 1);
        assert_eq!(cell_for_byte(&starts, 4), 2);
        assert_eq!(cell_for_byte(&starts, 99), 3);
    }

    #[test]
    fn resampling_keeps_solid_colour_and_transparency() {
        // 4x4 opaque red -> 2x2 red.
        let src: Vec<u8> = (0..16).flat_map(|_| [255, 0, 0, 255]).collect();
        let out = resample_rgba(&src, 4, 4, 2, 2);
        assert_eq!(out.len(), 16);
        for px in out.chunks(4) {
            assert_eq!(px, [255, 0, 0, 255]);
        }
        // Half transparent-black, half opaque white: edges are not darkened.
        let mut src = vec![0u8; 4 * 1 * 4];
        for x in 2..4 {
            src[x * 4..x * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
        let out = resample_rgba(&src, 4, 1, 2, 1);
        assert_eq!(&out[0..4], [0, 0, 0, 0]);
        assert_eq!(&out[4..8], [255, 255, 255, 255]);
        let blend = resample_rgba(&src, 4, 1, 1, 1);
        assert_eq!(&blend[0..3], [255, 255, 255], "premultiplied average");
        assert_eq!(blend[3], 127);
    }
}
