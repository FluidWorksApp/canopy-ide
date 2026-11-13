//! Native half of the parity check: prints `<file> <digest>` for each stream,
//! fed in 4 KiB chunks to an 80x24 terminal with 10 000 lines of scrollback.
//! `js/parity.mjs` does the same with the wasm build and compares.

use canopy_term_wasm::Terminal;

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let mut t = Terminal::new(80, 24, 10_000);
        for chunk in bytes.chunks(4096) {
            t.advance(chunk);
            t.take_replies();
        }
        println!("{path} {}", t.digest());
    }
}
