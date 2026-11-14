//! A deterministic synthetic byte stream that resembles what a busy terminal
//! sees: prose, coloured output, cursor addressing, erases, scrolling, wide and
//! combining characters. Synthetic only; no real data.

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const WORDS: &[&str] = &[
    "alpha",
    "beta",
    "gamma",
    "delta",
    "build",
    "test",
    "error",
    "warning",
    "ok",
    "compile",
    "link",
    "fn",
    "let",
    "match",
    "return",
    "src/main.rs",
    "Cargo.toml",
    "0x1f",
    "12345",
];

/// At least `min_bytes` of mixed output, ending on a complete sequence.
pub fn synthetic_stream(min_bytes: usize) -> Vec<u8> {
    let mut rng = Lcg(0x5eed);
    let mut out = Vec::with_capacity(min_bytes + 4096);
    while out.len() < min_bytes {
        match rng.below(10) {
            0..=3 => {
                // Plain prose line.
                for _ in 0..(3 + rng.below(12)) {
                    out.extend_from_slice(WORDS[rng.below(WORDS.len() as u64) as usize].as_bytes());
                    out.push(b' ');
                }
                out.extend_from_slice(b"\r\n");
            }
            4 | 5 => {
                // Coloured segments, 16/256/truecolour.
                for _ in 0..(2 + rng.below(5)) {
                    match rng.below(3) {
                        0 => {
                            out.extend_from_slice(format!("\x1b[{}m", 30 + rng.below(8)).as_bytes())
                        }
                        1 => out.extend_from_slice(
                            format!("\x1b[1;38;5;{}m", rng.below(256)).as_bytes(),
                        ),
                        _ => out.extend_from_slice(
                            format!(
                                "\x1b[38;2;{};{};{}m\x1b[48;5;{}m",
                                rng.below(256),
                                rng.below(256),
                                rng.below(256),
                                rng.below(256)
                            )
                            .as_bytes(),
                        ),
                    }
                    out.extend_from_slice(WORDS[rng.below(WORDS.len() as u64) as usize].as_bytes());
                    out.extend_from_slice(b"\x1b[0m ");
                }
                out.extend_from_slice(b"\r\n");
            }
            6 => {
                // Cursor addressing and erase, like a status line or TUI.
                out.extend_from_slice(
                    format!("\x1b[{};{}H\x1b[2K", 1 + rng.below(24), 1 + rng.below(60)).as_bytes(),
                );
                out.extend_from_slice(b"progress ");
                out.extend_from_slice(format!("{}%", rng.below(100)).as_bytes());
            }
            7 => {
                // Wide and combining characters.
                out.extend_from_slice(
                    "日本語のテキスト e\u{301} a\u{308} \u{1F600}\r\n".as_bytes(),
                );
            }
            8 => {
                // Scroll region and line operations.
                out.extend_from_slice(b"\x1b[5;20r\x1b[20;1H\n\n\x1b[r\x1b[3L\x1b[2M");
            }
            _ => {
                out.extend_from_slice(b"\x1b[?25l\x1b[H\x1b[J\x1b[?25h");
            }
        }
    }
    out
}
