//! What a snapshot carries beyond the visible grid, and that a restored screen
//! continues identically: tab stops, G0 to G3 character sets and shift state,
//! palette and colour overrides, underline styles and colours, hyperlinks
//! (including an open one and one under a pending wrap), prompt row marks and
//! the cursor's prompt state.
//!
//! Every case has the same shape (`round_trip`): feed `input`, snapshot,
//! restore into a fresh screen, require the same frame, marks and links and a
//! byte-identical second snapshot, then feed `extra` to both and require the
//! same again. The second step is what a plain round trip cannot show: a
//! restored screen that is missing a tab stop, a character set, a pen colour or
//! a prompt state looks right until the next bytes arrive. Each case also
//! asserts the live behaviour it relies on, so it cannot pass by exercising
//! nothing. Synthetic input only.

use canopy_term_core::frame::{Attrs, Color, Damage, Frame, UnderlineStyle};
use canopy_term_core::ghostty::RowMark;
use canopy_term_core::Screen;

fn norm(mut f: Frame) -> Frame {
    f.seq = 0;
    f.damage = Damage::default();
    f
}

fn marks(s: &Screen) -> Vec<RowMark> {
    (0..s.rows()).map(|r| s.row_mark(r)).collect()
}

fn links(s: &Screen) -> Vec<Option<String>> {
    let mut v = Vec::new();
    for r in 0..s.rows() {
        for c in 0..s.cols() {
            v.push(s.hyperlink_at(r, c));
        }
    }
    v
}

fn row_text(s: &Screen, r: u16) -> String {
    let f = s.frame();
    let mut t = String::new();
    for c in 0..f.cols {
        let cell = f.cell(r, c).unwrap();
        if !cell.attrs.has(Attrs::WIDE_TAIL) {
            t.push_str(&f.text(cell));
        }
    }
    t.trim_end().to_string()
}

fn assert_same(live: &Screen, restored: &Screen, what: &str) {
    assert_eq!(
        norm(live.frame()),
        norm(restored.frame()),
        "{what}: frames differ"
    );
    assert_eq!(marks(live), marks(restored), "{what}: prompt marks differ");
    assert_eq!(links(live), links(restored), "{what}: hyperlinks differ");
}

/// Feeds `input`, restores a snapshot into a fresh screen, then feeds `extra`
/// to both. Returns the live and restored screens after `extra`.
fn round_trip(cols: u16, rows: u16, input: &str, extra: &str, what: &str) -> (Screen, Screen) {
    let mut live = Screen::new(cols, rows);
    live.advance(input.as_bytes());
    let snap = live.snapshot();
    let mut restored = Screen::restore(cols, rows, &snap);
    assert_same(&live, &restored, &format!("{what}: after restore"));
    assert_eq!(
        String::from_utf8_lossy(&restored.snapshot()),
        String::from_utf8_lossy(&snap),
        "{what}: a snapshot of the restored screen is the same bytes"
    );
    live.advance(extra.as_bytes());
    restored.advance(extra.as_bytes());
    assert_same(&live, &restored, &format!("{what}: after more output"));
    (live, restored)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

// ---------------------------------------------------------------------------
// Underline styles and colours
// ---------------------------------------------------------------------------

#[test]
fn underline_styles_and_colours_survive_and_the_pen_keeps_them() {
    let styles = [
        ("4", UnderlineStyle::Single),
        ("4:2", UnderlineStyle::Double),
        ("21", UnderlineStyle::Double),
        ("4:3", UnderlineStyle::Curly),
        ("4:4", UnderlineStyle::Dotted),
        ("4:5", UnderlineStyle::Dashed),
    ];
    for (sgr, style) in styles {
        let input = format!(
            "\x1b[{sgr}mabc\x1b[0m\
             \x1b[{sgr};58;5;196mdef\x1b[0m\
             \x1b[1;{sgr};58;2;10;20;30mghi\x1b[0m plain\
             \x1b[{sgr};58;2;1;2;3m"
        );
        // The pen carries the style and colour into whatever prints next.
        let extra = "\x1b[3;1Hpen";
        let (live, restored) = round_trip(20, 4, &input, extra, sgr);
        let f = live.frame();
        let cell = |c| *f.cell(0, c).unwrap();
        assert_eq!(cell(0).underline, style, "{sgr}: shape");
        assert!(cell(0).attrs.has(Attrs::UNDERLINE));
        assert_eq!(cell(0).underline_color, Color::Default);
        assert_eq!(cell(3).underline_color, Color::Indexed(196), "{sgr}");
        assert_eq!(cell(6).underline_color, Color::Rgb(10, 20, 30), "{sgr}");
        assert_eq!(cell(10).underline, UnderlineStyle::None, "plain text");
        let g = restored.frame();
        let pen = g.cell(2, 0).unwrap();
        assert_eq!(pen.ch, 'p');
        assert_eq!(pen.underline, style, "{sgr}: the pen's shape");
        assert_eq!(
            pen.underline_color,
            Color::Rgb(1, 2, 3),
            "{sgr}: the pen's colour"
        );
    }
}

#[test]
fn an_underline_colour_set_without_an_underline_waits_for_one() {
    let (live, restored) = round_trip(
        12,
        2,
        "\x1b[58;2;9;8;7mx",
        "\x1b[4:3my",
        "colour then shape",
    );
    for s in [&live, &restored] {
        let f = s.frame();
        let x = f.cell(0, 0).unwrap();
        assert_eq!(
            (x.underline, x.underline_color),
            (UnderlineStyle::None, Color::Rgb(9, 8, 7))
        );
        let y = f.cell(0, 1).unwrap();
        assert_eq!(
            (y.underline, y.underline_color),
            (UnderlineStyle::Curly, Color::Rgb(9, 8, 7))
        );
    }
}

// ---------------------------------------------------------------------------
// Tab stops
// ---------------------------------------------------------------------------

#[test]
fn custom_tab_stops_survive_and_decide_where_the_next_tab_lands() {
    // Clear every stop, then set two: columns 6 and 13 (one-based).
    let input = "\x1b[3g\x1b[1;6H\x1bH\x1b[1;13H\x1bH\x1b[1;1H";
    let (live, restored) = round_trip(30, 3, input, "\tA\tB\tC\r\n\tD", "two stops");
    for s in [&live, &restored] {
        let f = s.frame();
        let at = |r, c| f.cell(r, c).unwrap().ch;
        assert_eq!(at(0, 5), 'A');
        assert_eq!(at(0, 12), 'B');
        assert_eq!(at(0, 29), 'C', "no stop left: the last column");
        assert_eq!(at(1, 5), 'D');
    }
}

#[test]
fn cleared_tab_stops_stay_cleared() {
    let (live, restored) = round_trip(20, 2, "ab\x1b[3g", "\tX", "no stops");
    for s in [&live, &restored] {
        assert_eq!(s.frame().cell(0, 19).unwrap().ch, 'X');
    }
}

#[test]
fn the_default_tab_stops_are_what_a_fresh_screen_has() {
    let (live, restored) = round_trip(40, 2, "ab", "\tX\tY", "default stops");
    for s in [&live, &restored] {
        let f = s.frame();
        assert_eq!(f.cell(0, 8).unwrap().ch, 'X');
        assert_eq!(f.cell(0, 16).unwrap().ch, 'Y');
    }
}

#[test]
fn a_single_cleared_stop_is_carried() {
    // Clear the stop at column 9 (one-based) only.
    let input = "\x1b[1;9H\x1b[0g\x1b[1;1H";
    let (live, restored) = round_trip(40, 2, input, "\tX", "one stop cleared");
    for s in [&live, &restored] {
        assert_eq!(
            s.frame().cell(0, 16).unwrap().ch,
            'X',
            "skips the cleared stop"
        );
    }
}

// ---------------------------------------------------------------------------
// Character sets and shift state
// ---------------------------------------------------------------------------

#[test]
fn g0_line_drawing_survives_and_translates_what_comes_next() {
    let (live, restored) = round_trip(10, 2, "\x1b(0", "lqkx", "g0 dec special");
    for s in [&live, &restored] {
        assert_eq!(row_text(s, 0), "┌─┐│");
    }
}

#[test]
fn text_printed_under_a_character_set_is_not_translated_a_second_time() {
    let (live, restored) = round_trip(10, 3, "\x1b(0lqk\r\nx\x1b(Bx", "\x1b[3;1Hq", "printed");
    for s in [&live, &restored] {
        assert_eq!(row_text(s, 0), "┌─┐");
        assert_eq!(row_text(s, 1), "│x");
        assert_eq!(row_text(s, 2), "q", "back in ASCII");
    }
}

#[test]
fn a_shifted_g1_and_the_shift_back_both_continue() {
    // G1 is line drawing and shifted in: `q` draws a line until the shift out.
    let (live, restored) = round_trip(10, 2, "\x1b)0\x0e", "q\x0fq", "so and si");
    for s in [&live, &restored] {
        assert_eq!(row_text(s, 0), "─q");
    }
    // The same designation, not shifted in.
    let (live, restored) = round_trip(10, 2, "\x1b)0", "q\x0eq", "g1 not shifted");
    for s in [&live, &restored] {
        assert_eq!(row_text(s, 0), "q─");
    }
}

#[test]
fn a_locking_shift_of_g2_continues() {
    let (live, restored) = round_trip(10, 2, "\x1b*0\x1bn", "q", "ls2");
    for s in [&live, &restored] {
        assert_eq!(row_text(s, 0), "─");
    }
}

#[test]
fn the_british_set_survives() {
    let (live, restored) = round_trip(10, 2, "\x1b(A", "#", "british");
    for s in [&live, &restored] {
        assert_eq!(row_text(s, 0), "£");
    }
}

#[test]
fn a_screen_with_default_sets_writes_no_set_or_shift() {
    let mut s = Screen::new(10, 2);
    s.advance(b"plain");
    let snap = s.snapshot();
    assert!(!snap.contains(&0x0e), "no shift out");
    for d in ["\x1b(", "\x1b)", "\x1b*", "\x1b+", "\x1bn", "\x1bo"] {
        assert!(!contains(&snap, d.as_bytes()), "no {d:?}");
    }
}

// ---------------------------------------------------------------------------
// Palette and colour overrides
// ---------------------------------------------------------------------------

#[test]
fn palette_and_colour_overrides_survive_and_answer_queries_the_same() {
    let input = "\x1b]4;1;rgb:12/34/56\x1b\\\x1b]4;200;rgb:aa/bb/cc\x07\
                 \x1b]10;rgb:11/22/33\x07\x1b]11;rgb:44/55/66\x07\x1b]12;rgb:77/88/99\x07";
    let mut live = Screen::new(20, 3);
    live.advance(input.as_bytes());
    let snap = live.snapshot();
    let mut restored = Screen::restore(20, 3, &snap);
    assert_eq!(
        String::from_utf8_lossy(&restored.snapshot()),
        String::from_utf8_lossy(&snap),
        "a snapshot of the restored screen is the same bytes"
    );
    let query = "\x1b]4;1;?\x1b\\\x1b]4;200;?\x1b\\\x1b]4;2;?\x1b\\\
                 \x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07";
    live.advance(query.as_bytes());
    restored.advance(query.as_bytes());
    let (a, b) = (live.take_replies(), restored.take_replies());
    assert!(
        !a.is_empty(),
        "the engine answers palette and colour queries"
    );
    assert!(
        contains(&a, b"1212/3434/5656"),
        "{}",
        String::from_utf8_lossy(&a)
    );
    assert_eq!(
        String::from_utf8_lossy(&a),
        String::from_utf8_lossy(&b),
        "the restored screen answers exactly as the live one"
    );
}

#[test]
fn only_what_the_program_changed_is_written_as_colours() {
    let mut s = Screen::new(20, 3);
    s.advance(b"hello");
    let snap = s.snapshot();
    for osc in ["\x1b]4;", "\x1b]10;", "\x1b]11;", "\x1b]12;"] {
        assert!(!contains(&snap, osc.as_bytes()), "no {osc:?} for defaults");
    }
    s.advance(b"\x1b]4;5;rgb:01/02/03\x07");
    let snap = s.snapshot();
    assert!(contains(&snap, b"\x1b]4;5;rgb:01/02/03\x1b\\"));
    assert!(
        !contains(&snap, b"\x1b]4;6;"),
        "one entry changed, one written"
    );
    // Resetting it takes it out again.
    s.advance(b"\x1b]104;5\x07");
    assert!(!contains(&s.snapshot(), b"\x1b]4;"));
}

// ---------------------------------------------------------------------------
// Hyperlinks
// ---------------------------------------------------------------------------

#[test]
fn an_open_link_keeps_linking_the_text_printed_after_a_restore() {
    let url = "http://open.example/x";
    let input = format!("\x1b]8;;{url}\x07abc");
    let (live, restored) = round_trip(20, 3, &input, "def\x1b]8;;\x07g", "open link");
    for s in [&live, &restored] {
        for c in 0..6 {
            assert_eq!(s.hyperlink_at(0, c).as_deref(), Some(url), "col {c}");
        }
        assert_eq!(s.hyperlink_at(0, 6), None, "closed before g");
    }
}

#[test]
fn a_closed_link_does_not_leak_into_later_text() {
    let input = "\x1b]8;;http://closed.example/\x07abc\x1b]8;;\x07";
    let (live, restored) = round_trip(20, 3, input, "def", "closed link");
    for s in [&live, &restored] {
        assert_eq!(
            s.hyperlink_at(0, 2).as_deref(),
            Some("http://closed.example/")
        );
        assert_eq!(s.hyperlink_at(0, 3), None);
    }
}

#[test]
fn a_link_on_the_last_column_under_a_pending_wrap_is_kept() {
    let url = "http://edge.example/";
    let input = format!("\x1b]8;;{url}\x07abcde\x1b]8;;\x07");
    let (live, restored) = round_trip(5, 3, &input, "f", "pending wrap link");
    for s in [&live, &restored] {
        assert_eq!(s.hyperlink_at(0, 4).as_deref(), Some(url));
        assert_eq!(s.hyperlink_at(1, 0), None, "the wrapped f is not linked");
        assert_eq!(row_text(s, 1), "f");
    }
}

// ---------------------------------------------------------------------------
// Prompt marks (OSC 133)
// ---------------------------------------------------------------------------

/// A shell session: prompt, input, output, a second prompt.
const SESSION: &str = "\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\
                       \x1b]133;C\x07out one\r\nout two\r\n\
                       \x1b]133;D;0\x07\x1b]133;A\x07$ ";

#[test]
fn prompt_row_marks_survive_and_the_prompt_state_continues() {
    let (live, restored) = round_trip(20, 8, SESSION, "\x1b]133;B\x07next\r\nmore", "session");
    assert_eq!(
        live.row_mark(0),
        RowMark::Prompt,
        "the engine marked the prompt"
    );
    assert_eq!(restored.row_mark(0), RowMark::Prompt);
    assert!(
        marks(&live).contains(&RowMark::Prompt),
        "{:?}",
        marks(&live)
    );
}

#[test]
fn a_cursor_left_in_a_prompt_marks_the_next_lines_as_continuations() {
    // Still in the prompt (no `B` yet): line feeds mark continuation rows.
    let (live, restored) = round_trip(
        20,
        6,
        "out\r\n\x1b]133;A\x07$ ",
        "\r\nsecond\r\nthird",
        "prompt state",
    );
    assert_eq!(live.row_mark(1), RowMark::Prompt);
    assert_eq!(live.row_mark(2), RowMark::PromptContinuation);
    assert_eq!(restored.row_mark(2), RowMark::PromptContinuation);
    assert_eq!(restored.row_mark(3), RowMark::PromptContinuation);
}

#[test]
fn a_cursor_left_in_input_marks_the_next_line_too() {
    let (live, restored) = round_trip(
        20,
        6,
        "\x1b]133;A\x07$ \x1b]133;B\x07ls",
        "\r\nsecond",
        "input state",
    );
    assert_eq!(live.row_mark(1), RowMark::PromptContinuation);
    assert_eq!(restored.row_mark(1), RowMark::PromptContinuation);
}

#[test]
fn input_that_ends_at_the_end_of_the_line_does_not() {
    let (live, restored) = round_trip(
        20,
        6,
        "\x1b]133;A\x07$ \x1b]133;I\x07ls",
        "\r\nsecond\r\nthird",
        "input to end of line",
    );
    assert_eq!(live.row_mark(1), RowMark::None);
    assert_eq!(restored.row_mark(1), RowMark::None);
}

#[test]
fn output_state_marks_nothing_after_a_restore() {
    let (live, restored) = round_trip(
        20,
        6,
        "\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07out",
        "\r\nmore\r\nlines",
        "output state",
    );
    assert_eq!(live.row_mark(0), RowMark::Prompt);
    assert!(marks(&restored)[2..].iter().all(|m| *m == RowMark::None));
}

#[test]
fn a_prompt_state_with_the_cursor_on_an_unmarked_row_is_written_from_a_marked_one() {
    // The prompt row is blank and the cursor is somewhere else.
    let (live, restored) = round_trip(
        20,
        6,
        "\x1b]133;A\x07\x1b[3;1H",
        "x\r\ny",
        "blank prompt row",
    );
    assert_eq!(live.row_mark(0), RowMark::Prompt);
    assert_eq!(live.row_mark(1), RowMark::None);
    assert_eq!(restored.row_mark(0), RowMark::Prompt);
    assert_eq!(live.row_mark(3), RowMark::PromptContinuation);
    assert_eq!(restored.row_mark(3), RowMark::PromptContinuation);
}

#[test]
fn a_wrapped_prompt_keeps_its_marks_and_its_wrap() {
    // A prompt longer than the row: row 0 is the prompt, row 1 its continuation.
    let (live, restored) = round_trip(
        10,
        4,
        "\x1b]133;A\x07$ 0123456789abc",
        "\x1b]133;B\x07",
        "wrapped prompt",
    );
    assert_eq!(live.row_mark(0), RowMark::Prompt);
    assert_eq!(live.row_mark(1), RowMark::PromptContinuation);
    assert_eq!(restored.row_mark(1), RowMark::PromptContinuation);
    assert_eq!(row_text(&restored, 0), "$ 01234567");
    assert_eq!(row_text(&restored, 1), "89abc");
}

#[test]
fn a_screen_without_marks_writes_none() {
    let mut s = Screen::new(10, 3);
    s.advance(b"plain\r\ntext");
    assert!(!contains(&s.snapshot(), b"\x1b]133;"));
}

#[test]
fn restoring_prompt_marks_raises_no_events() {
    let mut live = Screen::new(20, 6);
    live.advance(SESSION.as_bytes());
    let mut restored = Screen::restore(20, 6, &live.snapshot());
    assert!(restored.take_events().is_empty());
    assert!(restored.take_replies().is_empty());
}

// ---------------------------------------------------------------------------
// Everything at once, on both screens
// ---------------------------------------------------------------------------

#[test]
fn a_busy_screen_round_trips_and_continues_on_the_primary_and_alternate_screens() {
    let busy = "\x1b]4;3;rgb:10/20/30\x07\x1b[3g\x1b[1;5H\x1bH\x1b[1;1H\
                \x1b(0lqk\x1b(B\x1b)0\
                \x1b]133;A\x07\x1b[4:3;58;2;5;6;7m$ \x1b[0m\x1b]133;B\x07\
                \x1b]8;;http://busy.example/\x07link\x1b]8;;\x07 tail";
    let (live, _) = round_trip(
        30,
        6,
        busy,
        "\x1b[2;1H\tA\x0eq\x0f\r\nnext\x1b]4;3;?\x07",
        "primary",
    );
    let f = live.frame();
    assert_eq!(f.cell(1, 4).unwrap().ch, 'A', "the custom tab stop");
    assert_eq!(f.cell(1, 5).unwrap().ch, '─', "G1 shifted in");
    assert_eq!(f.cell(0, 0).unwrap().ch, '┌', "printed under line drawing");
    let on_alt = format!("{busy}\x1b[?1049h\x1b[2J\x1b[Halt\x1b[3g\x1b[1;7H\x1bH\x1b[1;1H");
    round_trip(30, 6, &on_alt, "\tZ\r\nmore", "alternate screen");
}
