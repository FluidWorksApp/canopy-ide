//! The whole app path with no PTY host: the window, a `Session`, and a toy
//! "program" behind an in-memory link. For checking the window and its input
//! on a machine (or an OS) where the host is not available.
//!
//! `cargo run --example memory_demo`
//!
//! The program echoes what you type, handles backspace, answers `help`, `size`,
//! `wide`, `colors` and `exit`, and prints its window size after every resize
//! it is told about. It runs nothing.

use std::thread;
use std::time::Duration;

use canopy_term_app::app::{session_config, window_config};
use canopy_term_app::args::{parse, Parsed};
use canopy_term_session::{MemoryLink, MemoryPeer, Session};
use canopy_term_window::window;

const PROMPT: &str = "\x1b[32m$\x1b[0m ";

fn reply(peer: &MemoryPeer, line: &str) -> bool {
    match line.trim() {
        "" => {}
        "help" => peer.send_output(
            b"commands: help, size, wide, colors, exit\r\n\
              Typing, paste (bracketed), IME and the mouse go through the real session.\r\n",
        ),
        "size" => {
            let (cols, rows) = peer.resizes().last().copied().unwrap_or((0, 0));
            peer.send_output(format!("the window told the link {cols}x{rows}\r\n").as_bytes());
        }
        "wide" => peer.send_output(
            "\u{65e5}\u{672c}\u{8a9e} \u{1f600} e\u{301} box: \u{250c}\u{2500}\u{2510}\r\n"
                .as_bytes(),
        ),
        "colors" => {
            let mut s = String::new();
            for n in 0..8 {
                s.push_str(&format!("\x1b[4{n}m  \x1b[0m"));
            }
            s.push_str("\r\n");
            peer.send_output(s.as_bytes());
        }
        "exit" => return false,
        other => peer.send_output(format!("unknown: {other}\r\n").as_bytes()),
    }
    true
}

fn program(peer: MemoryPeer) {
    peer.send_replay(b"canopy-term-app memory demo (no PTY host). Type help.\r\n");
    peer.end_replay();
    peer.send_output(PROMPT.as_bytes());
    let mut line = String::new();
    loop {
        // A demo: polling every few milliseconds is fine here, and this thread
        // is the stand-in for a program, not part of the app path.
        thread::sleep(Duration::from_millis(5));
        let typed = peer.take_written();
        if typed.is_empty() {
            continue;
        }
        for ch in String::from_utf8_lossy(&typed).chars() {
            match ch {
                '\r' | '\n' => {
                    peer.send_output(b"\r\n");
                    let more = reply(&peer, &line);
                    line.clear();
                    if !more {
                        peer.close();
                        return;
                    }
                    peer.send_output(PROMPT.as_bytes());
                }
                '\u{7f}' | '\u{8}' => {
                    if line.pop().is_some() {
                        peer.send_output(b"\x08 \x08");
                    }
                }
                c if c.is_control() => {}
                c => {
                    line.push(c);
                    let mut buf = [0u8; 4];
                    peer.send_output(c.encode_utf8(&mut buf).as_bytes());
                }
            }
        }
    }
}

fn main() {
    let options = match parse(std::env::args().skip(1)) {
        Ok(Parsed::Run(o)) => *o,
        Ok(_) => return,
        Err(e) => {
            eprintln!("memory_demo: {e}");
            std::process::exit(2);
        }
    };
    let (link, peer) = MemoryLink::pair();
    thread::spawn(move || program(peer));
    let session = Session::new(link, session_config(options.cols, options.rows));
    if let Err(e) = window::run(
        session,
        window_config(&options, &canopy_term_app::config::resolve(None, &options)),
    ) {
        eprintln!("memory_demo: {e}");
        std::process::exit(1);
    }
}
