//! The accessibility tree, IME composition, selection text and link policy
//! against frames from the real engine (libghostty-vt through `Screen`), not
//! hand-built ones. The unit tests in `src/` build their frames by hand; these
//! prove the same code reads what the engine actually produces: wide
//! characters with a tail cell, combining clusters, concealed text, styled
//! underlines and hyperlinks. Synthetic input only.

use accesskit::{Live, NodeId, Role, TreeUpdate};
use canopy_term_core::frame::{Attrs, Frame, UnderlineStyle};
use canopy_term_core::Screen;
use canopy_term_window::a11y::{line_id, line_text, new_output, tree_for, A11yTree, TERMINAL_ID};
use canopy_term_window::compose::overlay_preedit;
use canopy_term_window::grid::CellPx;
use canopy_term_window::ime::{cursor_area, preedit_cols, ImeAction, ImeEvent, ImeGate, Preedit};
use canopy_term_window::links;
use canopy_term_window::selection::{row_text, selection_text, Selection};

const CELL: CellPx = CellPx {
    width: 10,
    height: 20,
};

fn screen(cols: u16, rows: u16, input: &str) -> Screen {
    let mut s = Screen::new(cols, rows);
    s.advance(input.as_bytes());
    s
}

fn node_value(u: &TreeUpdate, id: NodeId) -> Option<String> {
    u.nodes
        .iter()
        .find(|(i, _)| *i == id)
        .and_then(|(_, n)| n.value().map(str::to_string))
}

fn lines(f: &Frame) -> Vec<canopy_term_window::a11y::LineText> {
    (0..f.rows).map(|r| line_text(f, r, 0)).collect()
}

const MIXED: &str = "plain\r\n日本語 e\u{301}x\r\n\x1b[8mhid\x1b[0m end";

#[test]
fn the_tree_reads_wide_characters_clusters_and_concealed_text_from_the_engine() {
    let s = screen(20, 4, MIXED);
    let f = s.frame();
    let u = tree_for(&f, CELL, None);
    assert_eq!(u.focus, TERMINAL_ID);
    let term = &u.nodes.iter().find(|(i, _)| *i == TERMINAL_ID).unwrap().1;
    assert_eq!(term.role(), Role::Terminal);
    assert_eq!(term.children().len(), 4, "one text run per row");
    assert_eq!(node_value(&u, line_id(0)).as_deref(), Some("plain\n"));
    assert_eq!(
        node_value(&u, line_id(1)).as_deref(),
        Some("日本語 e\u{301}x\n"),
        "tails skipped, the cluster whole"
    );
    assert_eq!(
        node_value(&u, line_id(2)).as_deref(),
        Some("    end\n"),
        "concealed cells read as spaces"
    );

    let l = line_text(&f, 1, 0);
    assert_eq!(l.char_index(0), 0);
    assert_eq!(
        l.char_index(1),
        0,
        "a wide character's tail maps to its head"
    );
    assert_eq!(l.char_index(2), 1);
    assert_eq!(l.col_of(3), 6, "the space after the three wide characters");
}

#[test]
fn the_caret_follows_the_engines_cursor_across_wide_characters() {
    let s = screen(20, 3, "日本x\x1b[1;6H");
    let f = s.frame();
    assert_eq!((f.cursor.row, f.cursor.col), (0, 5));
    let u = tree_for(&f, CELL, None);
    let sel = u
        .nodes
        .iter()
        .find(|(i, _)| *i == TERMINAL_ID)
        .unwrap()
        .1
        .text_selection()
        .expect("a caret");
    assert_eq!(sel.anchor, sel.focus);
    assert_eq!(sel.focus.node, line_id(0));
    // 日 本 x, then the caret one cell past the text: the end of the row.
    assert_eq!(sel.focus.character_index, 3);
}

#[test]
fn styled_underlines_do_not_change_what_a_screen_reader_reads() {
    let plain = screen(20, 2, "curly and double");
    let styled = screen(
        20,
        2,
        "\x1b[4:3;58;2;255;0;0mcurly\x1b[0m and \x1b[4:2mdouble\x1b[0m",
    );
    let (a, b) = (plain.frame(), styled.frame());
    assert_eq!(b.cell(0, 0).unwrap().underline, UnderlineStyle::Curly);
    assert!(b.cell(0, 0).unwrap().attrs.has(Attrs::UNDERLINE));
    assert_eq!(line_text(&a, 0, 0), line_text(&b, 0, 0));
    let (ua, ub) = (tree_for(&a, CELL, None), tree_for(&b, CELL, None));
    assert_eq!(node_value(&ua, line_id(0)), node_value(&ub, line_id(0)));
}

#[test]
fn scrolled_in_output_is_announced_from_engine_frames() {
    let mut s = screen(20, 4, "a\r\nb\r\nc\r\n");
    let before = lines(&s.frame());
    s.advance(b"d\r\n");
    let f = s.frame();
    assert_eq!(f.cursor.row, 3);
    assert_eq!(new_output(&before, &lines(&f), f.cursor.row), vec!["d"]);

    // The incremental tree says so too: a polite announcement node appears.
    let mut tree = A11yTree::new();
    let mut s = screen(20, 4, "a\r\nb\r\nc\r\n");
    tree.full(&s.frame(), CELL, None);
    s.advance(b"d\r\n");
    let update = tree.update(&s.frame(), CELL, None).expect("rows changed");
    assert!(
        update
            .nodes
            .iter()
            .any(|(_, n)| n.value() == Some("d") && n.live() == Some(Live::Polite)),
        "the new line is announced"
    );
}

#[test]
fn a_selection_copies_what_the_engine_drew() {
    let s = screen(20, 3, MIXED);
    let f = s.frame();
    let sel = Selection {
        start: (1, 0),
        end: (1, 7),
        block: false,
    };
    assert_eq!(selection_text(&f, &sel), "日本語 e\u{301}");
    assert_eq!(row_text(&f, 2, 0, 7), "    end");
}

#[test]
fn an_ime_composition_draws_over_an_engine_frame_without_touching_it() {
    let s = screen(20, 3, "$ ");
    let f = s.frame();
    assert_eq!((f.cursor.row, f.cursor.col), (0, 2));
    let p = Preedit {
        text: "日本e\u{301}".into(),
        caret: Some((6, 6)),
    };
    let out = overlay_preedit(&f, &p);
    assert_eq!(row_text(&out, 0, 0, 20).trim_end(), "$ 日本e\u{301}");
    for col in 2..=6 {
        assert!(
            out.cell(0, col).unwrap().attrs.has(Attrs::UNDERLINE),
            "col {col} is drawn as composition"
        );
    }
    assert_eq!(out.cursor.col, 6, "the caret is after the second wide char");
    assert!(out.cursor.visible);
    assert!(out.damage.full);
    assert_eq!(
        row_text(&f, 0, 0, 20).trim_end(),
        "$",
        "the input frame is unchanged"
    );

    let area = cursor_area((f.cursor.row, f.cursor.col), preedit_cols(&p), CELL, f.cols);
    assert_eq!((area.x, area.y, area.h), (20, 0, 20));
    assert_eq!(area.w, 50, "two wide characters and a one-column cluster");
}

#[test]
fn a_composition_started_on_the_tail_of_an_engine_wide_character_replaces_it() {
    let s = screen(10, 2, "日本\x1b[1;2H");
    let f = s.frame();
    assert_eq!(f.cursor.col, 1);
    assert!(f.cell(0, 1).unwrap().attrs.has(Attrs::WIDE_TAIL));
    let p = Preedit {
        text: "x".into(),
        caret: Some((1, 1)),
    };
    let out = overlay_preedit(&f, &p);
    assert_eq!(
        out.cell(0, 0).unwrap().ch,
        ' ',
        "the half-covered character is gone"
    );
    assert_eq!(out.cell(0, 1).unwrap().ch, 'x');
}

#[test]
fn ime_events_round_trip_through_the_gate_into_the_screen() {
    let mut gate = ImeGate::new();
    assert_eq!(gate.on_event(ImeEvent::Enabled), ImeAction::None);
    assert_eq!(
        gate.on_event(ImeEvent::Preedit("ni".into(), Some((2, 2)))),
        ImeAction::Redraw
    );
    assert!(gate.composing());
    let committed = match gate.on_event(ImeEvent::Commit("你好".into())) {
        ImeAction::Send(t) => t,
        other => panic!("a commit sends its text, got {other:?}"),
    };
    assert!(!gate.composing());
    // The window sends the text to the program, which echoes it.
    let s = screen(20, 2, &committed);
    let f = s.frame();
    assert_eq!(row_text(&f, 0, 0, 20).trim_end(), "你好");
    assert_eq!(f.cursor.col, 4);
}

#[test]
fn only_safe_links_under_the_pointer_reach_the_opener() {
    let s = screen(
        60,
        3,
        "\x1b]8;;https://example.com/ok\x07web\x1b]8;;\x07 \
         \x1b]8;;file:///etc/passwd\x07file\x1b]8;;\x07 \
         \x1b]8;;javascript:alert(1)\x07js\x1b]8;;\x07",
    );
    let at = |col| {
        let mut opened = Vec::new();
        links::follow(s.hyperlink_at(0, col), |t| {
            opened.push(t.to_string());
            true
        });
        opened
    };
    assert_eq!(at(1), vec!["https://example.com/ok".to_string()]);
    assert!(at(5).is_empty(), "file: is never opened");
    assert!(at(10).is_empty(), "javascript: is never opened");
    assert!(at(15).is_empty(), "no link, nothing to open");
}
