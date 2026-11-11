//! Mouse reports, table-driven against xterm ctlseqs "Mouse Tracking".

mod common;

use canopy_term_input::*;
use common::*;

fn modes(mouse: MouseMode, mouse_encoding: MouseEncoding) -> Modes {
    Modes {
        mouse,
        mouse_encoding,
        ..Modes::default()
    }
}

fn press(b: MouseButton, col: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Press(b),
        col,
        row,
        mods: Mods::NONE,
    }
}

fn release(b: MouseButton, col: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Release(b),
        ..press(b, col, row)
    }
}

fn motion(held: Option<MouseButton>, col: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind: MouseEventKind::Motion(held),
        col,
        row,
        mods: Mods::NONE,
    }
}

fn with(ev: MouseEvent, mods: Mods) -> MouseEvent {
    MouseEvent { mods, ..ev }
}

fn enc(ev: MouseEvent, m: Modes) -> Vec<u8> {
    let mut out = Vec::new();
    let wrote = encode_mouse(&ev, m, &mut out);
    assert_eq!(wrote, !out.is_empty());
    out
}

fn check(m: Modes, table: &[(MouseEvent, &[u8])]) {
    for (i, (ev, want)) in table.iter().enumerate() {
        assert_eq!(
            show(&enc(*ev, m)),
            show(want),
            "row {i}: {ev:?} under {m:?}"
        );
    }
}

use canopy_term_input::MouseButton::*;

#[test]
fn off_reports_nothing() {
    for enc_mode in [
        MouseEncoding::Default,
        MouseEncoding::Utf8,
        MouseEncoding::Sgr,
    ] {
        let m = modes(MouseMode::Off, enc_mode);
        for ev in [
            press(Left, 0, 0),
            release(Left, 0, 0),
            press(WheelUp, 0, 0),
            motion(None, 0, 0),
            motion(Some(Left), 0, 0),
        ] {
            assert!(enc(ev, m).is_empty(), "{ev:?}");
        }
    }
}

#[test]
fn x10_presses_only_no_modifiers() {
    let m = modes(MouseMode::Press, MouseEncoding::Default);
    check(
        m,
        &[
            // Cb is button-1 (+32), Cx/Cy are 1-based (+32).
            (press(Left, 0, 0), &b"\x1b[M !!"[..]),
            (press(Middle, 1, 2), &b"\x1b[M!\"#"[..]),
            (press(Right, 9, 4), &b"\x1b[M\"*%"[..]),
            (
                with(press(Left, 0, 0), CTRL | SHIFT | ALT),
                &b"\x1b[M !!"[..],
            ),
            (release(Left, 0, 0), &b""[..]),
            (press(WheelUp, 0, 0), &b""[..]),
            (press(Back, 0, 0), &b""[..]),
            (motion(Some(Left), 1, 1), &b""[..]),
            (motion(None, 1, 1), &b""[..]),
        ],
    );
    let sgr = modes(MouseMode::Press, MouseEncoding::Sgr);
    check(
        sgr,
        &[
            (with(press(Right, 9, 4), CTRL), &b"\x1b[<2;10;5M"[..]),
            (release(Right, 9, 4), &b""[..]),
        ],
    );
}

#[test]
fn normal_tracking() {
    let m = modes(MouseMode::Normal, MouseEncoding::Default);
    check(
        m,
        &[
            (press(Left, 0, 0), &b"\x1b[M !!"[..]),
            (press(Middle, 0, 0), &b"\x1b[M!!!"[..]),
            (press(Right, 0, 0), &b"\x1b[M\"!!"[..]),
            // Release is 3, whichever button.
            (release(Left, 0, 0), &b"\x1b[M#!!"[..]),
            (release(Right, 0, 0), &b"\x1b[M#!!"[..]),
            (release(Back, 0, 0), &b"\x1b[M#!!"[..]),
            // Modifiers: shift 4, meta 8, control 16.
            (with(press(Left, 0, 0), SHIFT), &b"\x1b[M$!!"[..]),
            (with(press(Left, 0, 0), ALT), &b"\x1b[M(!!"[..]),
            (with(press(Left, 0, 0), META), &b"\x1b[M(!!"[..]),
            (with(press(Left, 0, 0), CTRL), &b"\x1b[M0!!"[..]),
            (with(press(Left, 0, 0), SHIFT | CTRL), &b"\x1b[M4!!"[..]),
            (with(release(Left, 0, 0), CTRL), &b"\x1b[M3!!"[..]),
            // Super and locks are not reported.
            (with(press(Left, 0, 0), SUPER | CAPS), &b"\x1b[M !!"[..]),
            // Wheel: 64 + 0/1/2/3, no release.
            (press(WheelUp, 0, 0), &b"\x1b[M`!!"[..]),
            (press(WheelDown, 0, 0), &b"\x1b[Ma!!"[..]),
            (press(WheelLeft, 0, 0), &b"\x1b[Mb!!"[..]),
            (press(WheelRight, 0, 0), &b"\x1b[Mc!!"[..]),
            (with(press(WheelDown, 0, 0), CTRL), &b"\x1b[Mq!!"[..]),
            (release(WheelUp, 0, 0), &b""[..]),
            // Buttons 8-11: 128 + 0..3 (+32 = 0xA0..0xA3 raw in this encoding).
            (press(Back, 0, 0), &b"\x1b[M\xa0!!"[..]),
            (press(Forward, 0, 0), &b"\x1b[M\xa1!!"[..]),
            (press(Button10, 0, 0), &b"\x1b[M\xa2!!"[..]),
            (press(Button11, 0, 0), &b"\x1b[M\xa3!!"[..]),
            // No motion in 1000.
            (motion(Some(Left), 3, 3), &b""[..]),
            (motion(None, 3, 3), &b""[..]),
        ],
    );
}

#[test]
fn button_event_tracking() {
    let m = modes(MouseMode::Drag, MouseEncoding::Default);
    check(
        m,
        &[
            // ctlseqs: motion with button 1 down is CSI M @ CxCy.
            (motion(Some(Left), 0, 0), &b"\x1b[M@!!"[..]),
            // ...and with button 3 down, CSI M B CxCy.
            (motion(Some(Right), 0, 0), &b"\x1b[MB!!"[..]),
            (with(motion(Some(Left), 0, 0), SHIFT), &b"\x1b[MD!!"[..]),
            (motion(None, 0, 0), &b""[..]),
            (motion(Some(WheelUp), 0, 0), &b""[..]),
            (press(Left, 0, 0), &b"\x1b[M !!"[..]),
            (release(Left, 0, 0), &b"\x1b[M#!!"[..]),
        ],
    );
}

#[test]
fn any_event_tracking() {
    let m = modes(MouseMode::Any, MouseEncoding::Default);
    check(
        m,
        &[
            // No button: 3 + 32 motion.
            (motion(None, 0, 0), &b"\x1b[MC!!"[..]),
            (with(motion(None, 0, 0), CTRL), &b"\x1b[MS!!"[..]),
            (motion(Some(Left), 0, 0), &b"\x1b[M@!!"[..]),
            (motion(Some(Middle), 4, 5), &b"\x1b[MA%&"[..]),
            (press(WheelUp, 0, 0), &b"\x1b[M`!!"[..]),
        ],
    );
}

#[test]
fn legacy_coordinate_limit_is_223() {
    let m = modes(MouseMode::Normal, MouseEncoding::Default);
    assert_eq!(LEGACY_COORD_LIMIT, 223);
    // 0-based 222 is 1-based 223: byte 255.
    assert_eq!(enc(press(Left, 222, 222), m), b"\x1b[M \xff\xff");
    // One past: cannot be expressed, dropped.
    assert!(enc(press(Left, 223, 0), m).is_empty());
    assert!(enc(press(Left, 0, 223), m).is_empty());
    assert!(enc(release(Left, 500, 0), m).is_empty());
    assert!(enc(press(Left, u16::MAX, u16::MAX), m).is_empty());
}

#[test]
fn utf8_encoding() {
    let m = modes(MouseMode::Any, MouseEncoding::Utf8);
    assert_eq!(UTF8_COORD_LIMIT, 2015);
    // Below 95 identical to the default encoding.
    assert_eq!(enc(press(Left, 0, 0), m), b"\x1b[M !!");
    assert_eq!(enc(press(Left, 94, 0), m), b"\x1b[M \x7f!");
    // 1-based 96 -> 128 -> U+0080 -> C2 80.
    assert_eq!(enc(press(Left, 95, 0), m), b"\x1b[M \xc2\x80!");
    // Limit: 2015 -> 2047 -> U+07FF -> DF BF.
    assert_eq!(enc(press(Left, 2014, 2014), m), b"\x1b[M \xdf\xbf\xdf\xbf");
    assert!(enc(press(Left, 2015, 0), m).is_empty());
    // Cb is UTF-8 encoded too: button 8 is 128+32 = 160 -> C2 A0.
    assert_eq!(enc(press(Back, 0, 0), m), b"\x1b[M\xc2\xa0!!");
    assert_eq!(enc(release(Back, 0, 0), m), b"\x1b[M#!!");
    assert_eq!(enc(motion(None, 0, 0), m), b"\x1b[MC!!");
    // Valid UTF-8 throughout.
    let out = enc(press(Forward, 1000, 1500), m);
    assert!(std::str::from_utf8(&out).is_ok());
}

#[test]
fn sgr_encoding() {
    let m = modes(MouseMode::Any, MouseEncoding::Sgr);
    check(
        m,
        &[
            (press(Left, 9, 4), &b"\x1b[<0;10;5M"[..]),
            // Release keeps the button and uses `m`.
            (release(Left, 9, 4), &b"\x1b[<0;10;5m"[..]),
            (release(Right, 0, 0), &b"\x1b[<2;1;1m"[..]),
            (release(Back, 0, 0), &b"\x1b[<128;1;1m"[..]),
            (with(release(Middle, 0, 0), SHIFT), &b"\x1b[<5;1;1m"[..]),
            (press(WheelUp, 0, 0), &b"\x1b[<64;1;1M"[..]),
            (with(press(WheelDown, 0, 0), CTRL), &b"\x1b[<81;1;1M"[..]),
            (press(WheelRight, 0, 0), &b"\x1b[<67;1;1M"[..]),
            (release(WheelDown, 0, 0), &b""[..]),
            (motion(None, 0, 0), &b"\x1b[<35;1;1M"[..]),
            (motion(Some(Left), 2, 3), &b"\x1b[<32;3;4M"[..]),
            (
                with(motion(Some(Right), 0, 0), SHIFT | ALT | CTRL),
                &b"\x1b[<62;1;1M"[..],
            ),
            (press(Button11, 0, 0), &b"\x1b[<131;1;1M"[..]),
            // No coordinate limit.
            (press(Left, 223, 0), &b"\x1b[<0;224;1M"[..]),
            (press(Left, 65534, 65534), &b"\x1b[<0;65535;65535M"[..]),
            (press(Left, u16::MAX, 0), &b"\x1b[<0;65536;1M"[..]),
        ],
    );
}

#[test]
fn mode_matrix_press_release_motion() {
    // Which kinds each tracking mode reports, under each encoding.
    let encs = [
        MouseEncoding::Default,
        MouseEncoding::Utf8,
        MouseEncoding::Sgr,
    ];
    let rows: [(MouseMode, [bool; 5]); 5] = [
        // press, release, wheel, drag motion, bare motion
        (MouseMode::Off, [false, false, false, false, false]),
        (MouseMode::Press, [true, false, false, false, false]),
        (MouseMode::Normal, [true, true, true, false, false]),
        (MouseMode::Drag, [true, true, true, true, false]),
        (MouseMode::Any, [true, true, true, true, true]),
    ];
    for e in encs {
        for (mode, wants) in rows {
            let m = modes(mode, e);
            let evs = [
                press(Left, 1, 1),
                release(Left, 1, 1),
                press(WheelUp, 1, 1),
                motion(Some(Left), 1, 1),
                motion(None, 1, 1),
            ];
            for (ev, want) in evs.into_iter().zip(wants) {
                assert_eq!(!enc(ev, m).is_empty(), want, "{ev:?} under {mode:?}/{e:?}");
            }
        }
    }
}

#[test]
fn encode_mouse_appends() {
    let m = modes(MouseMode::Normal, MouseEncoding::Sgr);
    let mut out = b"x".to_vec();
    assert!(encode_mouse(&press(Left, 0, 0), m, &mut out));
    assert_eq!(out, b"x\x1b[<0;1;1M");
}
