//! The interface between the quad builder and whatever turns text into atlas
//! glyphs. The builder only knows this trait, so it is testable with a stub and
//! no fonts; `text::TextEngine` is the real implementation.

use crate::atlas::Rect;

/// The two style bits that pick a font face. Other attributes (colour,
/// underline, ...) never change which glyph is drawn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct FontStyle {
    pub bold: bool,
    pub italic: bool,
}

/// One grid cell's text as the shaper sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextCell<'a> {
    /// The full text of the cell: one scalar, or a whole grapheme cluster.
    pub text: &'a str,
    /// Grid columns the cell covers: 2 for the head of a wide character, else 1.
    pub cols: u8,
}

/// A glyph ready to draw: where it is in the atlas and how it sits on the grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlacedGlyph {
    /// Index of the cell (within the run passed to `shape_run`) it starts at.
    pub cell: u16,
    pub rect: Rect,
    /// Pixels from the left edge of the starting cell to the bitmap's left.
    pub left: i32,
    /// Pixels from the baseline up to the bitmap's top (positive is up).
    pub top: i32,
    /// RGBA colour bitmap (emoji): drawn as-is instead of tinted by the cell's
    /// foreground.
    pub color: bool,
}

pub trait GlyphSource {
    /// Starts a frame: glyphs requested from now on must stay valid until the
    /// next call.
    fn begin_frame(&mut self);

    /// Changes whenever a previously returned atlas rectangle may have been
    /// overwritten. A cache of built instances is stale after a change.
    fn epoch(&self) -> u64;

    /// A code-drawn glyph (box drawing, blocks, Powerline) covering exactly one
    /// cell: its bitmap is `cell width x cell height` and is drawn at the cell
    /// origin.
    fn procedural(&mut self, ch: char) -> Option<Rect>;

    /// Shapes a run of cells sharing one style and appends the glyphs to `out`.
    /// Blank glyphs (spaces) are omitted.
    fn shape_run(&mut self, style: FontStyle, cells: &[TextCell<'_>], out: &mut Vec<PlacedGlyph>);
}
