#![no_main]

use canopy_term_core::frame::Frame;
use canopy_term_core::Screen;
use libfuzzer_sys::fuzz_target;

fn same(a: &Frame, b: &Frame) -> bool {
    a.cols == b.cols
        && a.rows == b.rows
        && a.cells == b.cells
        && a.clusters == b.clusters
        && a.cursor == b.cursor
        && a.modes == b.modes
        && a.alt_screen == b.alt_screen
        && a.title == b.title
}

fuzz_target!(|data: &[u8]| {
    if data.len() < 4 {
        return;
    }
    let cols = u16::from(data[0]) % 200 + 1;
    let rows = u16::from(data[1]) % 60 + 1;
    let chunk = usize::from(data[2]) % 64 + 1;
    let scrollback = usize::from(data[3]) % 128;
    let stream = &data[4..];

    let mut whole = Screen::with_scrollback(cols, rows, scrollback);
    whole.advance(stream);
    let mut split = Screen::with_scrollback(cols, rows, scrollback);
    for piece in stream.chunks(chunk) {
        split.advance(piece);
    }

    let f = whole.frame();
    assert_eq!(f.cells.len(), f.cols as usize * f.rows as usize);
    assert!(f.cursor.row < f.rows && f.cursor.col < f.cols);
    assert!(f
        .cells
        .iter()
        .all(|c| (c.cluster as usize) < f.clusters.len()));
    assert!(same(&f, &split.frame()), "chunking changed the screen");
    assert!(whole.scrollback_len() <= scrollback);

    let snap = whole.snapshot();
    let restored = Screen::restore(whole.cols(), whole.rows(), &snap);
    assert_eq!(restored.snapshot(), snap, "snapshot is not stable");
});
