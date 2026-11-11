//! Font selection: the primary family for a style, and fallback faces for
//! characters it lacks (CJK, emoji, symbols).
//!
//! Built on `fontdb` (MIT) for discovery. The bundled test font (JetBrains
//! Mono, SIL OFL 1.1; licence text in `fonts/`) is always available so tests
//! never depend on what the machine has installed; system fonts are loaded only
//! when asked.

use std::collections::HashMap;
use std::sync::Arc;

use crate::glyphs::FontStyle;

pub const BUNDLED_FONT: &[u8] = include_bytes!("../fonts/JetBrainsMono-Regular.ttf");
pub const BUNDLED_FAMILY: &str = "JetBrains Mono";

/// What the fallback chooser needs to know about a face, separated from fontdb
/// so the policy is testable with stubs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub covers: bool,
    pub monospaced: bool,
    pub bold: bool,
    pub italic: bool,
}

/// Picks the best covering candidate: matching the requested weight and slant
/// matters most (a wrong-weight fallback looks like a bug), then monospaced.
/// Ties go to the earliest candidate.
pub fn pick_fallback(candidates: &[Candidate], want: FontStyle) -> Option<usize> {
    let mut best: Option<(u32, usize)> = None;
    for (i, c) in candidates.iter().enumerate() {
        if !c.covers {
            continue;
        }
        let score = (c.bold == want.bold) as u32 * 4
            + (c.italic == want.italic) as u32 * 2
            + c.monospaced as u32;
        if best.map_or(true, |(s, _)| score > s) {
            best = Some((score, i));
        }
    }
    best.map(|(_, i)| i)
}

/// A face whose bytes are held for shaping and rasterising.
pub struct LoadedFace {
    pub data: Arc<Vec<u8>>,
    pub index: u32,
    pub units_per_em: u16,
}

/// A face and which styles must be faked because the face lacks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FaceChoice {
    /// Index into `FontBook::face`.
    pub face: u32,
    pub synth_bold: bool,
    pub synth_italic: bool,
}

pub struct FontBook {
    db: fontdb::Database,
    primary: String,
    loaded: Vec<LoadedFace>,
    by_id: HashMap<fontdb::ID, u32>,
    cache: HashMap<(char, FontStyle), Option<FaceChoice>>,
}

fn is_bold(w: fontdb::Weight) -> bool {
    w.0 >= 600
}

impl FontBook {
    /// Only the bundled font.
    pub fn bundled() -> Self {
        let mut db = fontdb::Database::new();
        db.load_font_data(BUNDLED_FONT.to_vec());
        FontBook {
            db,
            primary: BUNDLED_FAMILY.to_string(),
            loaded: Vec::new(),
            by_id: HashMap::new(),
            cache: HashMap::new(),
        }
    }

    /// An empty book whose primary family is `family` (fill it with
    /// `add_font_data` / `load_system_fonts`).
    pub fn with_primary(family: &str) -> Self {
        FontBook {
            db: fontdb::Database::new(),
            primary: family.to_string(),
            loaded: Vec::new(),
            by_id: HashMap::new(),
            cache: HashMap::new(),
        }
    }

    pub fn add_font_data(&mut self, data: Vec<u8>) {
        self.db.load_font_data(data);
        self.cache.clear();
    }

    /// Loads the machine's fonts. Not used by tests: results differ per machine.
    pub fn load_system_fonts(&mut self) {
        self.db.load_system_fonts();
        self.cache.clear();
    }

    pub fn face(&self, index: u32) -> &LoadedFace {
        &self.loaded[index as usize]
    }

    fn load(&mut self, id: fontdb::ID) -> Option<u32> {
        if let Some(&i) = self.by_id.get(&id) {
            return Some(i);
        }
        let (data, index, upem) = self.db.with_face_data(id, |data, index| {
            let upem = rustybuzz::ttf_parser::Face::parse(data, index)
                .map(|f| f.units_per_em())
                .unwrap_or(1000);
            (data.to_vec(), index, upem)
        })?;
        self.loaded.push(LoadedFace {
            data: Arc::new(data),
            index,
            units_per_em: upem,
        });
        let i = (self.loaded.len() - 1) as u32;
        self.by_id.insert(id, i);
        Some(i)
    }

    fn covers(&self, id: fontdb::ID, ch: char) -> bool {
        self.db
            .with_face_data(id, |data, index| {
                rustybuzz::ttf_parser::Face::parse(data, index)
                    .map(|f| f.glyph_index(ch).is_some())
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    fn primary_id(&self, style: FontStyle) -> Option<fontdb::ID> {
        let families = [fontdb::Family::Name(&self.primary)];
        let found = self.db.query(&fontdb::Query {
            families: &families,
            weight: if style.bold {
                fontdb::Weight::BOLD
            } else {
                fontdb::Weight::NORMAL
            },
            style: if style.italic {
                fontdb::Style::Italic
            } else {
                fontdb::Style::Normal
            },
            ..Default::default()
        });
        // A misspelt family still draws: use whatever face is loaded first.
        found.or_else(|| self.db.faces().next().map(|f| f.id))
    }

    fn choice_for(&mut self, id: fontdb::ID, want: FontStyle) -> Option<FaceChoice> {
        let (bold, italic) = {
            let info = self.db.face(id)?;
            (is_bold(info.weight), info.style != fontdb::Style::Normal)
        };
        Some(FaceChoice {
            face: self.load(id)?,
            synth_bold: want.bold && !bold,
            synth_italic: want.italic && !italic,
        })
    }

    /// The face to draw `ch` in for `style`: the primary family when it has the
    /// glyph, otherwise the best fallback. `None` when no face has it (the caller
    /// then draws the primary face's missing-glyph box).
    pub fn choose(&mut self, ch: char, style: FontStyle) -> Option<FaceChoice> {
        if let Some(hit) = self.cache.get(&(ch, style)) {
            return *hit;
        }
        let primary = self.primary_id(style);
        let blank = ch.is_whitespace() || ch.is_control();
        let result = match primary {
            Some(id) if blank || self.covers(id, ch) => self.choice_for(id, style),
            _ => {
                let ids: Vec<fontdb::ID> = self.db.faces().map(|f| f.id).collect();
                let candidates: Vec<Candidate> = ids
                    .iter()
                    .map(|&id| {
                        let info = self.db.face(id).expect("listed face");
                        Candidate {
                            covers: self.covers(id, ch),
                            monospaced: info.monospaced,
                            bold: is_bold(info.weight),
                            italic: info.style != fontdb::Style::Normal,
                        }
                    })
                    .collect();
                match pick_fallback(&candidates, style) {
                    Some(i) => self.choice_for(ids[i], style),
                    None => None,
                }
            }
        };
        self.cache.insert((ch, style), result);
        result
    }

    /// The primary face, whether or not it has `ch`; used for missing glyphs.
    pub fn primary_choice(&mut self, style: FontStyle) -> Option<FaceChoice> {
        let id = self.primary_id(style)?;
        self.choice_for(id, style)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(covers: bool, monospaced: bool, bold: bool, italic: bool) -> Candidate {
        Candidate {
            covers,
            monospaced,
            bold,
            italic,
        }
    }

    const REGULAR: FontStyle = FontStyle {
        bold: false,
        italic: false,
    };
    const BOLD: FontStyle = FontStyle {
        bold: true,
        italic: false,
    };

    #[test]
    fn fallback_skips_faces_without_the_glyph() {
        let c = [
            cand(false, true, false, false),
            cand(true, false, false, false),
        ];
        assert_eq!(pick_fallback(&c, REGULAR), Some(1));
        assert_eq!(
            pick_fallback(&[cand(false, true, false, false)], REGULAR),
            None
        );
        assert_eq!(pick_fallback(&[], REGULAR), None);
    }

    #[test]
    fn fallback_prefers_the_matching_weight_over_monospaced() {
        let c = [
            cand(true, true, false, false), // mono regular
            cand(true, false, true, false), // proportional bold
        ];
        assert_eq!(pick_fallback(&c, BOLD), Some(1));
        assert_eq!(pick_fallback(&c, REGULAR), Some(0));
    }

    #[test]
    fn fallback_prefers_monospaced_among_equal_styles_and_then_the_first() {
        let c = [
            cand(true, false, false, false),
            cand(true, true, false, false),
            cand(true, true, false, false),
        ];
        assert_eq!(pick_fallback(&c, REGULAR), Some(1));
    }

    #[test]
    fn italic_matters_after_weight() {
        let c = [
            cand(true, true, false, false),
            cand(true, false, false, true),
        ];
        let want = FontStyle {
            bold: false,
            italic: true,
        };
        assert_eq!(pick_fallback(&c, want), Some(1));
    }

    #[test]
    fn the_bundled_font_serves_ascii_and_fakes_missing_styles() {
        let mut book = FontBook::bundled();
        let reg = book.choose('a', REGULAR).expect("bundled font has 'a'");
        assert!(!reg.synth_bold && !reg.synth_italic);
        // Only a regular face is bundled, so bold and italic are synthesised.
        let bold = book.choose('a', BOLD).unwrap();
        assert!(bold.synth_bold && !bold.synth_italic);
        assert_eq!(bold.face, reg.face, "same face, faked weight");
        let it = book
            .choose(
                'a',
                FontStyle {
                    bold: false,
                    italic: true,
                },
            )
            .unwrap();
        assert!(it.synth_italic);
        assert_eq!(book.face(reg.face).units_per_em, 1000);
    }

    #[test]
    fn a_character_no_face_has_is_reported_not_invented() {
        let mut book = FontBook::bundled();
        // Private-use code point the bundled font does not map.
        assert_eq!(book.choose('\u{10FFF0}', REGULAR), None);
        assert!(book.primary_choice(REGULAR).is_some());
    }

    #[test]
    fn whitespace_and_controls_use_the_primary_face() {
        let mut book = FontBook::bundled();
        assert!(book.choose(' ', REGULAR).is_some());
        assert!(book.choose('\0', REGULAR).is_some());
    }

    #[test]
    fn results_are_cached() {
        let mut book = FontBook::bundled();
        let a = book.choose('x', REGULAR);
        let b = book.choose('x', REGULAR);
        assert_eq!(a, b);
    }
}
