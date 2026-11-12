//! Font metrics to the integer cell layout every other module draws against.
//!
//! Rounding rules (the single place they live):
//! * Font size is logical pixels times the HiDPI scale, giving physical pixels.
//! * Cell width and height are rounded to whole physical pixels, never below 1.
//!   Every cell origin is therefore `col * width`, `row * height`: integers, so
//!   neighbouring cells tile with no seams and no subpixel positioning.
//! * Glyphs are rasterised at the physical size and blitted at integer offsets
//!   (the rasteriser's own bearings), so there is no subpixel glyph positioning.
//! * Decoration positions and thicknesses are rounded to whole pixels with a
//!   1 pixel minimum, and clamped to stay inside the cell.

use crate::CellMetrics;

/// Raw numbers read from a font, in font units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontMetrics {
    pub units_per_em: u16,
    pub ascent: i16,
    /// Negative below the baseline, as fonts store it.
    pub descent: i16,
    pub line_gap: i16,
    /// Advance of a typical glyph; monospace fonts have one advance.
    pub advance: u16,
    /// Position is the offset of the line's top from the baseline (negative is
    /// below), as in the `post` table.
    pub underline_position: i16,
    pub underline_thickness: i16,
    pub strike_position: i16,
    pub strike_thickness: i16,
}

impl FontMetrics {
    /// Reads metrics from font bytes. The advance is that of `0` (falling back
    /// to `M`).
    pub fn from_font_data(data: &[u8], index: u32) -> Option<Self> {
        let face = rustybuzz::ttf_parser::Face::parse(data, index).ok()?;
        let upem = face.units_per_em();
        let advance = ['0', 'M', ' ']
            .iter()
            .filter_map(|c| face.glyph_index(*c))
            .filter_map(|g| face.glyph_hor_advance(g))
            .next()?;
        let underline = face.underline_metrics();
        let strike = face.strikeout_metrics();
        let thin = (upem / 14).max(1) as i16;
        Some(FontMetrics {
            units_per_em: upem,
            ascent: face.ascender(),
            descent: face.descender(),
            line_gap: face.line_gap(),
            advance,
            underline_position: underline.map_or(-(upem as i16) / 10, |m| m.position),
            underline_thickness: underline.map_or(thin, |m| m.thickness),
            strike_position: strike.map_or((upem as i16) / 4, |m| m.position),
            strike_thickness: strike.map_or(thin, |m| m.thickness),
        })
    }
}

/// HiDPI scale: physical pixels per logical pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Scale(pub f32);

impl Scale {
    pub fn to_physical(self, logical: f32) -> f32 {
        logical * self.0
    }
    /// Rounds a physical coordinate to the pixel grid (halves round up).
    pub fn snap(v: f32) -> i32 {
        (v + 0.5).floor() as i32
    }
}

/// The integer layout of one cell in physical pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellLayout {
    pub width: u32,
    pub height: u32,
    /// Distance from the cell top to the baseline.
    pub baseline: u32,
    pub underline_top: u32,
    pub underline_thickness: u32,
    pub strike_top: u32,
    pub strike_thickness: u32,
    /// Physical font size in pixels (what the rasteriser is asked for).
    pub font_px: u32,
}

impl CellLayout {
    pub fn metrics(&self) -> CellMetrics {
        CellMetrics {
            width: self.width as f32,
            height: self.height as f32,
        }
    }
}

/// Derives the cell layout. `logical_px` is the font size in logical pixels.
pub fn layout(fm: &FontMetrics, logical_px: f32, scale: Scale) -> CellLayout {
    layout_with(fm, logical_px, scale, 1.0)
}

/// [`layout`] with a line-height multiplier: the cell height is the font's own
/// line (ascent, descent and gap) times `line_height`, rounded to whole pixels,
/// and the baseline moves down by half of what was added (up by half of what was
/// removed) so the text stays centred in the taller or shorter cell. `1.0` is
/// exactly [`layout`]; a non-finite or non-positive multiplier counts as `1.0`.
pub fn layout_with(
    fm: &FontMetrics,
    logical_px: f32,
    scale: Scale,
    line_height: f32,
) -> CellLayout {
    // Physical size first, rounded: the cell and the glyph raster agree on it.
    let px = scale.to_physical(logical_px).round().max(1.0);
    let k = px / fm.units_per_em as f32;
    let round = |v: f32| Scale::snap(v).max(0) as u32;
    let width = round(fm.advance as f32 * k).max(1);
    let ascent = fm.ascent as f32 * k;
    let descent = -(fm.descent as f32) * k;
    let gap = fm.line_gap as f32 * k;
    let natural = ascent + descent + gap;
    let factor = if line_height.is_finite() && line_height > 0.0 {
        line_height
    } else {
        1.0
    };
    let scaled = natural * factor;
    let height = Scale::snap(scaled).max(1) as u32;
    // Half the line gap above the text, half below, and half of the extra (or
    // missing) line height on each side.
    let baseline =
        Scale::snap(gap / 2.0 + ascent + (scaled - natural) / 2.0).clamp(0, height as i32) as u32;

    let thick = |units: i16| round(units as f32 * k).max(1).min(height);
    let underline_thickness = thick(fm.underline_thickness);
    let strike_thickness = thick(fm.strike_thickness);
    // Underline sits below the baseline: top = baseline - position (position <0).
    let underline_top = (baseline as i32 - Scale::snap(fm.underline_position as f32 * k))
        .clamp(0, (height - underline_thickness) as i32) as u32;
    // Strike is centred on `position` above the baseline.
    let strike_top = (baseline as i32
        - Scale::snap(fm.strike_position as f32 * k)
        - (strike_thickness as i32) / 2)
        .clamp(0, (height - strike_thickness) as i32) as u32;

    CellLayout {
        width,
        height,
        baseline,
        underline_top,
        underline_thickness,
        strike_top,
        strike_thickness,
        font_px: px.round().max(1.0) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm() -> FontMetrics {
        // Numbers in the range of a real monospace font at 1000 units per em.
        FontMetrics {
            units_per_em: 1000,
            ascent: 1020,
            descent: -300,
            line_gap: 0,
            advance: 600,
            underline_position: -100,
            underline_thickness: 50,
            strike_position: 300,
            strike_thickness: 50,
        }
    }

    #[test]
    fn cell_size_rounds_to_whole_pixels() {
        let l = layout(&fm(), 14.0, Scale(1.0));
        assert_eq!(l.width, 8); // 8.4
        assert_eq!(l.height, 18); // 18.48
        assert_eq!(l.baseline, 14); // 14.28
        assert_eq!(l.font_px, 14);
    }

    #[test]
    fn hidpi_scales_the_font_not_the_rules() {
        let one = layout(&fm(), 14.0, Scale(1.0));
        let two = layout(&fm(), 14.0, Scale(2.0));
        assert_eq!(two.font_px, 28);
        assert_eq!(two.width, 17); // 16.8
        assert!(two.height >= one.height * 2 - 1 && two.height <= one.height * 2 + 1);
        assert!(two.underline_thickness >= one.underline_thickness);
    }

    #[test]
    fn decorations_stay_inside_the_cell_and_never_vanish() {
        for px in [6.0f32, 9.0, 12.0, 14.0, 20.0, 33.0] {
            for s in [1.0f32, 1.25, 1.5, 2.0, 3.0] {
                let l = layout(&fm(), px, Scale(s));
                assert!(l.underline_thickness >= 1 && l.strike_thickness >= 1);
                assert!(
                    l.underline_top + l.underline_thickness <= l.height,
                    "{px} {s}"
                );
                assert!(l.strike_top + l.strike_thickness <= l.height, "{px} {s}");
                assert!(l.baseline <= l.height);
                assert!(l.strike_top < l.underline_top, "strike is above underline");
            }
        }
    }

    #[test]
    fn fractional_scales_use_the_rounded_physical_size_everywhere() {
        // 13 px at 1.5x is 19.5 physical px; it rounds to 20 and the cell
        // metrics must come from that, the same size the glyphs are drawn at.
        assert_eq!(
            layout(&fm(), 13.0, Scale(1.5)),
            layout(&fm(), 20.0, Scale(1.0))
        );
        assert_eq!(layout(&fm(), 13.0, Scale(1.5)).font_px, 20);
    }

    #[test]
    fn a_line_height_of_one_is_the_plain_layout() {
        for px in [9.0f32, 13.0, 14.0, 22.5] {
            for s in [1.0f32, 1.5, 2.0] {
                assert_eq!(
                    layout_with(&fm(), px, Scale(s), 1.0),
                    layout(&fm(), px, Scale(s))
                );
            }
        }
    }

    #[test]
    fn line_height_scales_the_cell_height_and_centres_the_text() {
        let one = layout(&fm(), 14.0, Scale(1.0));
        assert_eq!((one.height, one.baseline), (18, 14));
        // 18.48 * 1.5 = 27.72: 28 tall; 9.24 added, 4.62 of it above the text.
        let tall = layout_with(&fm(), 14.0, Scale(1.0), 1.5);
        assert_eq!(tall.height, 28);
        assert_eq!(tall.baseline, 19); // 14.28 + 4.62 = 18.9
        assert_eq!(tall.width, one.width, "line height never changes the width");
        assert_eq!(tall.font_px, one.font_px);
        // 18.48 * 0.8 = 14.78: 15 tall, the text moves up by 1.85 (3.70 / 2).
        let tight = layout_with(&fm(), 14.0, Scale(1.0), 0.8);
        assert_eq!(tight.height, 15);
        assert_eq!(tight.baseline, 12); // 14.28 - 1.85 = 12.43
    }

    #[test]
    fn line_height_keeps_decorations_inside_the_cell() {
        for lh in [0.5f32, 0.8, 1.0, 1.2, 2.0, 3.0] {
            for px in [6.0f32, 14.0, 33.0] {
                let l = layout_with(&fm(), px, Scale(1.0), lh);
                assert!(l.baseline <= l.height, "{lh} {px}");
                assert!(l.underline_top + l.underline_thickness <= l.height);
                assert!(l.strike_top + l.strike_thickness <= l.height);
            }
        }
    }

    #[test]
    fn a_nonsense_line_height_counts_as_one() {
        let one = layout(&fm(), 14.0, Scale(1.0));
        for bad in [0.0f32, -1.0, f32::NAN, f32::INFINITY] {
            assert_eq!(layout_with(&fm(), 14.0, Scale(1.0), bad), one);
        }
    }

    #[test]
    fn snap_rounds_halves_up_and_handles_negatives() {
        assert_eq!(Scale::snap(0.5), 1);
        assert_eq!(Scale::snap(0.49), 0);
        assert_eq!(Scale::snap(-0.5), 0);
        assert_eq!(Scale::snap(-0.51), -1);
    }

    #[test]
    fn layout_converts_to_cell_metrics() {
        let l = layout(&fm(), 14.0, Scale(1.0));
        assert_eq!(
            l.metrics(),
            CellMetrics {
                width: 8.0,
                height: 18.0
            }
        );
    }

    #[test]
    fn reads_the_bundled_font() {
        let data = include_bytes!("../fonts/JetBrainsMono-Regular.ttf");
        let m = FontMetrics::from_font_data(data, 0).expect("parses");
        assert_eq!(m.units_per_em, 1000);
        assert_eq!(m.advance, 600);
        let l = layout(&m, 14.0, Scale(1.0));
        assert_eq!(l.width, 8);
        assert!(l.height >= 17 && l.height <= 21);
    }
}
