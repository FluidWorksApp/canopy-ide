//! Prints, for the glyphs Claude Code and similar TUIs use, which face the
//! renderer would draw each in on this machine: the font book is built exactly
//! as the window builds it (bundled font, then the system fonts, then the
//! coverage index), and `choose` is the same call the text engine makes.
//!
//! A plain `main` (not libtest) so the lines reach the CI log. It never fails:
//! `NONE` is a reported answer, not an error.

use canopy_term_render::fonts::FontBook;
use canopy_term_render::glyphs::FontStyle;
use canopy_term_render::procedural::is_procedural;
use std::io::Write;

const REGULAR: FontStyle = FontStyle {
    bold: false,
    italic: false,
};
const BOLD: FontStyle = FontStyle {
    bold: true,
    italic: false,
};

const GLYPHS: &[(char, &str)] = &[
    ('\u{23F4}', "BLACK MEDIUM LEFT-POINTING TRIANGLE"),
    ('\u{23F5}', "BLACK MEDIUM RIGHT-POINTING TRIANGLE"),
    ('\u{23F6}', "BLACK MEDIUM UP-POINTING TRIANGLE"),
    ('\u{23F7}', "BLACK MEDIUM DOWN-POINTING TRIANGLE"),
    ('\u{23F8}', "DOUBLE VERTICAL BAR"),
    ('\u{23FA}', "BLACK CIRCLE FOR RECORD"),
    ('\u{26A0}', "WARNING SIGN"),
    (
        '\u{276F}',
        "HEAVY RIGHT-POINTING ANGLE QUOTATION MARK ORNAMENT",
    ),
    ('\u{2733}', "EIGHT SPOKED ASTERISK"),
    ('\u{273B}', "TEARDROP-SPOKED ASTERISK"),
    ('\u{00B7}', "MIDDLE DOT"),
    ('\u{2014}', "EM DASH"),
    ('\u{2026}', "HORIZONTAL ELLIPSIS"),
    ('\u{2022}', "BULLET"),
    ('\u{25CF}', "BLACK CIRCLE"),
    ('\u{2713}', "CHECK MARK"),
    ('\u{2717}', "BALLOT X"),
    ('\u{2192}', "RIGHTWARDS ARROW"),
    ('\u{2580}', "UPPER HALF BLOCK"),
    ('\u{2584}', "LOWER HALF BLOCK"),
    ('\u{2588}', "FULL BLOCK"),
    ('\u{258C}', "LEFT HALF BLOCK"),
    ('\u{2590}', "RIGHT HALF BLOCK"),
    ('\u{2596}', "QUADRANT LOWER LEFT"),
    (
        '\u{259F}',
        "QUADRANT UPPER RIGHT AND LOWER LEFT AND LOWER RIGHT",
    ),
];

fn main() {
    let mut out = std::io::stdout();
    let mut book = FontBook::bundled();
    book.load_system_fonts();
    book.index_fallbacks();
    let _ = writeln!(
        out,
        "FONT_PROBE os={} faces={}",
        std::env::consts::OS,
        book.face_count()
    );
    for &(ch, name) in GLYPHS {
        let pick = |book: &mut FontBook, style| match book.choose(ch, style) {
            Some(c) => book.face(c.face).family.clone(),
            None => "NONE".to_string(),
        };
        let reg = pick(&mut book, REGULAR);
        let bold = pick(&mut book, BOLD);
        let covering = book.covering_faces(ch);
        let mut fams: Vec<String> = covering.iter().map(|c| c.0.clone()).collect();
        fams.sort();
        fams.dedup();
        let shown = fams.len().min(12);
        let _ =
            writeln!(
            out,
            "FONT_PROBE os={} U+{:04X} {:<10} drawn={} regular={:?} bold={:?} covering={} [{}{}]",
            std::env::consts::OS,
            ch as u32,
            ch,
            if is_procedural(ch) { "procedural" } else { "font" },
            reg,
            bold,
            fams.len(),
            fams[..shown].join(", "),
            if fams.len() > shown { ", ..." } else { "" }
        );
        let _ = name;
    }
    let _ = out.flush();
}
