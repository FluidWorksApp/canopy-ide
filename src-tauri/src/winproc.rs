//! Suppress the console window Windows flashes when a GUI process spawns a
//! console subprocess (git, gh, curl, the shell probes…). Without the
//! `CREATE_NO_WINDOW` creation flag, each spawn pops a black conhost window for
//! its lifetime — and Canopy spawns git constantly, so the desktop flickers.
//!
//! Route every `Command` we build through `.no_console_window()`. It is a no-op
//! on macOS and Linux, so call sites stay platform-agnostic.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Adds `CREATE_NO_WINDOW` on Windows; does nothing elsewhere. Implemented for
/// both the std and tokio `Command` types since we spawn with both.
pub trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
