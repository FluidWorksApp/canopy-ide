//! Font selection: the primary family for a style, and fallback faces for
//! characters it lacks (CJK, emoji, symbols).
//!
//! Built on `fontdb` (MIT) for discovery. The bundled test font (JetBrains
//! Mono, SIL OFL 1.1; licence text in `fonts/`) is always available so tests
//! never depend on what the machine has installed; system fonts are loaded only
//! when asked.

use crate::glyphs::FontStyle;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

type SharedBytes = Arc<dyn AsRef<[u8]> + Send + Sync>;

/// A `static`, so every use is the same bytes at the same address.
pub static BUNDLED_FONT: &[u8] = include_bytes!("../fonts/JetBrainsMono-Regular.ttf");
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

/// The codepoints a face maps, as sorted, non-overlapping inclusive ranges, so
/// "does this face have U+XXXX" is a binary search instead of a font parse.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Coverage {
    ranges: Vec<(u32, u32)>,
}

impl Coverage {
    pub fn from_codepoints(mut cps: Vec<u32>) -> Coverage {
        cps.sort_unstable();
        cps.dedup();
        let mut ranges: Vec<(u32, u32)> = Vec::new();
        for c in cps {
            match ranges.last_mut() {
                Some(last) if last.1.saturating_add(1) == c => last.1 = c,
                _ => ranges.push((c, c)),
            }
        }
        Coverage { ranges }
    }

    /// Reads the Unicode `cmap` subtables of one face. A face that cannot be
    /// parsed covers nothing.
    pub fn from_face(data: &[u8], index: u32) -> Coverage {
        let Ok(face) = rustybuzz::ttf_parser::Face::parse(data, index) else {
            return Coverage::default();
        };
        let Some(cmap) = face.tables().cmap else {
            return Coverage::default();
        };
        let mut cps = Vec::new();
        for sub in cmap.subtables {
            if sub.is_unicode() {
                sub.codepoints(|c| cps.push(c));
            }
        }
        // Keep exactly what the parser would draw, so the index never
        // disagrees with `glyph_index` (ranges can include unmapped slots).
        cps.retain(|&c| char::from_u32(c).is_some_and(|ch| face.glyph_index(ch).is_some()));
        Coverage::from_codepoints(cps)
    }

    pub fn contains(&self, ch: char) -> bool {
        let c = ch as u32;
        self.ranges
            .binary_search_by(|&(lo, hi)| {
                if hi < c {
                    std::cmp::Ordering::Less
                } else if lo > c {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    }
}

/// Keeps `shared` alive for the rest of the process and returns its bytes as
/// `'static`, once per distinct byte range however many books or faces use it.
///
/// This is what lets a parsed shaping face be `'static` and built once instead
/// of once per shaped run, without copying the font: system fonts are memory
/// mapped (by fontdb) and the mapping is shared by every face of the file, so
/// the cost is address space and page cache, not heap. Only the small `Arc`
/// handle is leaked; the mapping lives as long as the process, bounded by the
/// font files actually used.
fn pin(shared: &SharedBytes) -> &'static [u8] {
    let inner: &(dyn AsRef<[u8]> + Send + Sync) = &**shared;
    let bytes: &[u8] = inner.as_ref();
    let key = (bytes.as_ptr() as usize, bytes.len());
    let mut table = pinned();
    if let Some(&pinned) = table.by_range.get(&key) {
        return pinned;
    }
    let handle: &'static SharedBytes = Box::leak(Box::new(shared.clone()));
    let inner: &'static (dyn AsRef<[u8]> + Send + Sync) = &**handle;
    let pinned: &'static [u8] = inner.as_ref();
    table.by_range.insert(key, pinned);
    pinned
}

/// Pinned font bytes for the whole process: by byte range (in-memory fonts)
/// and by file path (so a second book loading the same system font reuses the
/// first mapping instead of mapping and pinning the file again).
#[derive(Default)]
struct Pinned {
    by_range: HashMap<(usize, usize), &'static [u8]>,
    by_path: HashMap<PathBuf, &'static [u8]>,
}

fn pinned() -> MutexGuard<'static, Pinned> {
    static PINNED: OnceLock<Mutex<Pinned>> = OnceLock::new();
    PINNED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// A face whose bytes are held for shaping and rasterising (see `pin`).
pub struct LoadedFace {
    pub data: &'static [u8],
    pub index: u32,
    pub units_per_em: u16,
    pub buzz: rustybuzz::Face<'static>,
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
    coverage: HashMap<fontdb::ID, Coverage>,
    primary_ids: HashMap<FontStyle, Option<fontdb::ID>>,
}

fn is_bold(w: fontdb::Weight) -> bool {
    w.0 >= 600
}

impl FontBook {
    /// Only the bundled font.
    pub fn bundled() -> Self {
        let mut db = fontdb::Database::new();
        // The static bytes themselves, not a copy.
        db.load_font_source(fontdb::Source::Binary(Arc::new(BUNDLED_FONT)));
        FontBook {
            db,
            primary: BUNDLED_FAMILY.to_string(),
            loaded: Vec::new(),
            by_id: HashMap::new(),
            cache: HashMap::new(),
            coverage: HashMap::new(),
            primary_ids: HashMap::new(),
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
            coverage: HashMap::new(),
            primary_ids: HashMap::new(),
        }
    }

    pub fn add_font_data(&mut self, data: Vec<u8>) {
        self.db.load_font_data(data);
        self.invalidate();
    }

    fn invalidate(&mut self) {
        self.cache.clear();
        self.primary_ids.clear();
    }

    /// Loads the machine's fonts. Not used by tests: results differ per machine.
    pub fn load_system_fonts(&mut self) {
        self.db.load_system_fonts();
        self.invalidate();
    }

    /// Reads every face's character coverage now. Fallback lookups need it, and
    /// otherwise build it face by face the first time a character is missing
    /// from the primary font. Call this at startup, off the frame path (the
    /// book is plain data and can be moved to a worker thread and back), so no
    /// frame pays for it.
    pub fn index_fallbacks(&mut self) {
        let ids: Vec<fontdb::ID> = self.db.faces().map(|f| f.id).collect();
        for id in ids {
            self.coverage_of(id);
        }
    }

    fn coverage_of(&mut self, id: fontdb::ID) -> &Coverage {
        if !self.coverage.contains_key(&id) {
            let cov = self
                .db
                .with_face_data(id, Coverage::from_face)
                .unwrap_or_default();
            self.coverage.insert(id, cov);
        }
        &self.coverage[&id]
    }

    pub fn face(&self, index: u32) -> &LoadedFace {
        &self.loaded[index as usize]
    }

    fn load(&mut self, id: fontdb::ID) -> Option<u32> {
        if let Some(&i) = self.by_id.get(&id) {
            return Some(i);
        }
        let (index, path) = {
            let info = self.db.face(id)?;
            let path = match &info.source {
                fontdb::Source::File(p) | fontdb::Source::SharedFile(p, _) => Some(p.clone()),
                fontdb::Source::Binary(_) => None,
            };
            (info.index, path)
        };
        let known = path.as_ref().and_then(|p| pinned().by_path.get(p).copied());
        let data = match known {
            Some(data) => data,
            None => {
                // SAFETY: fontdb maps the font file read-only. As with any
                // mapped file, another process truncating or rewriting an
                // installed font while the app runs could fault; installed
                // fonts are not rewritten in place in practice, and every text
                // stack that maps fonts accepts this.
                let (shared, _) = unsafe { self.db.make_shared_face_data(id)? };
                let data = pin(&shared);
                if let Some(p) = path {
                    pinned().by_path.insert(p, data);
                }
                data
            }
        };
        let upem = rustybuzz::ttf_parser::Face::parse(data, index)
            .map(|f| f.units_per_em())
            .unwrap_or(1000);
        let buzz = rustybuzz::Face::from_slice(data, index)?;
        self.loaded.push(LoadedFace {
            data,
            index,
            units_per_em: upem,
            buzz,
        });
        let i = (self.loaded.len() - 1) as u32;
        self.by_id.insert(id, i);
        Some(i)
    }

    fn covers(&mut self, id: fontdb::ID, ch: char) -> bool {
        self.coverage_of(id).contains(ch)
    }

    fn primary_id(&mut self, style: FontStyle) -> Option<fontdb::ID> {
        if let Some(&id) = self.primary_ids.get(&style) {
            return id;
        }
        let id = self.query_primary(style);
        self.primary_ids.insert(style, id);
        id
    }

    fn query_primary(&self, style: FontStyle) -> Option<fontdb::ID> {
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
                // Coverage is a binary search per face; nothing is parsed here
                // once the index exists (see `index_fallbacks`).
                let faces: Vec<(fontdb::ID, bool, bool, bool)> = self
                    .db
                    .faces()
                    .map(|f| {
                        (
                            f.id,
                            f.monospaced,
                            is_bold(f.weight),
                            f.style != fontdb::Style::Normal,
                        )
                    })
                    .collect();
                let candidates: Vec<Candidate> = faces
                    .iter()
                    .map(|&(id, monospaced, bold, italic)| Candidate {
                        covers: self.covers(id, ch),
                        monospaced,
                        bold,
                        italic,
                    })
                    .collect();
                match pick_fallback(&candidates, style) {
                    Some(i) => self.choice_for(faces[i].0, style),
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
    fn coverage_merges_runs_and_answers_by_binary_search() {
        let c = Coverage::from_codepoints(vec![5, 3, 4, 4, 10, 11, 20]);
        assert_eq!(c.ranges, vec![(3, 5), (10, 11), (20, 20)]);
        for (ch, want) in [
            (2u32, false),
            (3, true),
            (5, true),
            (6, false),
            (11, true),
            (12, false),
            (20, true),
            (21, false),
        ] {
            assert_eq!(c.contains(char::from_u32(ch).unwrap()), want, "{ch}");
        }
        assert!(!Coverage::default().contains('a'));
    }

    #[test]
    fn the_coverage_index_agrees_with_the_font_parser() {
        let cov = Coverage::from_face(BUNDLED_FONT, 0);
        let face = rustybuzz::ttf_parser::Face::parse(BUNDLED_FONT, 0).unwrap();
        for cp in (0x20u32..0x3000).chain(0xE000..0xE100) {
            let Some(ch) = char::from_u32(cp) else {
                continue;
            };
            assert_eq!(
                cov.contains(ch),
                face.glyph_index(ch).is_some(),
                "U+{cp:04X}"
            );
        }
        assert!(cov.contains('a') && !cov.contains('\u{10FFF0}'));
    }

    #[test]
    fn indexing_covers_every_face_once() {
        let mut book = FontBook::bundled();
        assert!(book.coverage.is_empty());
        book.index_fallbacks();
        assert_eq!(book.coverage.len(), 1);
        book.index_fallbacks();
        assert_eq!(book.coverage.len(), 1);
        // A miss uses the index and still answers.
        assert_eq!(book.choose('\u{10FFF0}', REGULAR), None);
    }

    #[test]
    fn font_bytes_are_shared_not_copied_per_book_or_face() {
        let mut a = FontBook::bundled();
        let mut b = FontBook::bundled();
        let fa = a.choose('a', REGULAR).unwrap().face;
        let fb = b.choose('a', BOLD).unwrap().face;
        let (da, db) = (a.face(fa).data, b.face(fb).data);
        assert_eq!(
            da.as_ptr(),
            BUNDLED_FONT.as_ptr(),
            "the bundled bytes themselves"
        );
        assert_eq!(db.as_ptr(), da.as_ptr(), "one copy across books");
        assert_eq!(da.len(), BUNDLED_FONT.len());
    }

    #[test]
    fn a_font_file_is_mapped_once_for_every_book() {
        // The bundled font written to a temporary file stands in for a system
        // font, so the memory-mapped path runs on CI.
        let path = std::env::temp_dir().join(format!(
            "canopy-term-render-test-{}.ttf",
            std::process::id()
        ));
        std::fs::write(&path, BUNDLED_FONT).unwrap();
        let mut a = FontBook::with_primary(BUNDLED_FAMILY);
        a.db.load_font_file(&path).unwrap();
        let mut b = FontBook::with_primary(BUNDLED_FAMILY);
        b.db.load_font_file(&path).unwrap();
        let fa = a.choose('a', REGULAR).expect("face from the file").face;
        let fb = b.choose('a', REGULAR).expect("face from the file").face;
        let (da, db) = (a.face(fa).data, b.face(fb).data);
        assert!(da == BUNDLED_FONT, "the mapping holds the file's bytes");
        assert_ne!(da.as_ptr(), BUNDLED_FONT.as_ptr(), "mapped, not the static");
        assert_eq!(
            db.as_ptr(),
            da.as_ptr(),
            "the second book reuses the mapping"
        );
        // The mapping stays valid even though the file goes away (or, on
        // Windows, cannot be removed while mapped).
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_font_book_can_move_to_a_worker_thread() {
        fn is_send<T: Send>() {}
        is_send::<FontBook>();
        let mut book = FontBook::bundled();
        let book = std::thread::spawn(move || {
            book.index_fallbacks();
            book
        })
        .join()
        .unwrap();
        assert_eq!(book.coverage.len(), 1);
    }

    #[test]
    fn results_are_cached() {
        let mut book = FontBook::bundled();
        let a = book.choose('x', REGULAR);
        let b = book.choose('x', REGULAR);
        assert_eq!(a, b);
    }
}
