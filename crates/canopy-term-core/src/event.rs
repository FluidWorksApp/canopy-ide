//! Things the program said that are not part of the picture: plain data, no
//! dependencies, so the session and window layers can carry them without an
//! emulator.
//!
//! `Screen` queues these as it parses ([`Screen::take_events`]); a session
//! passes them on; the application layer decides what, if anything, to do. The
//! core never acts on them: in particular it never touches a clipboard.
//!
//! [`Screen::take_events`]: crate::Screen::take_events

/// Most decoded bytes of an OSC 52 clipboard payload. A longer request is
/// dropped whole, never truncated: half a clipboard is worse than none.
pub const MAX_CLIPBOARD_TEXT: usize = 64 * 1024;

/// Most events a `Screen` (or a session) holds for its owner; the oldest are
/// dropped past this, so an owner that never drains cannot make it grow.
pub const MAX_PENDING_EVENTS: usize = 1024;

/// Which clipboard an OSC 52 request names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipboardTarget {
    /// The system clipboard (`c`, or no selection given).
    Clipboard,
    /// The primary selection (`p` or `s`) where the platform has one.
    Selection,
}

/// What a `Screen` does with OSC 52 requests. Off by default: a program that
/// prints an escape sequence must not be able to overwrite the user's
/// clipboard unless the application layer has decided to allow it.
///
/// There is deliberately no policy that answers a clipboard *read* (`OSC 52 ;
/// c ; ?`): replying would hand the clipboard to any program that can print to
/// the terminal, including output from a file or a remote host. Reads are
/// never answered; the request is only reported as
/// [`Event::ClipboardReadDenied`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ClipboardPolicy {
    /// Set requests are discarded (the default).
    #[default]
    Off,
    /// Set requests become [`Event::ClipboardSet`]. The application must still
    /// decide per event (focused pane, user consent, rate) and writes the
    /// clipboard itself.
    Set,
}

/// An OSC 133 semantic prompt mark (shell integration).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SemanticMark {
    /// `A`: the prompt starts here.
    PromptStart,
    /// `B`: the prompt ended; the user's command starts here.
    CommandStart,
    /// `C`: the command was sent; its output starts here.
    OutputStart,
    /// `D`: the command finished, with its exit code when the shell gave one.
    CommandFinished(Option<i32>),
}

/// Something the program asked for or announced.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Event {
    /// OSC 52 set request, only under [`ClipboardPolicy::Set`]. `text` is
    /// decoded, valid UTF-8 and at most [`MAX_CLIPBOARD_TEXT`] bytes.
    ClipboardSet {
        target: ClipboardTarget,
        text: String,
    },
    /// OSC 52 read request (`?`). Never answered; reported so a UI can tell the
    /// user a program tried.
    ClipboardReadDenied { target: ClipboardTarget },
    /// An OSC 133 mark, at the row the cursor was on. `line` is a number that
    /// does not change as the row scrolls (see `Screen::marks`). Not reported
    /// on the alternate screen.
    Mark { kind: SemanticMark, line: u64 },
}
