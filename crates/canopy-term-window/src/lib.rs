//! The native window shell for the terminal: a winit window and event loop, a
//! wgpu surface handed to `canopy-term-render`, DPI and resize to a cell grid,
//! font zoom, IME composition, clipboard, cursor blink, and an AccessKit tree so
//! screen readers can read the screen.
//!
//! The logic is in modules that need no window and are tested on every OS:
//!
//! * [`grid`]: surface pixels and cell size to columns and rows; pointer to
//!   cell; zoom steps.
//! * [`a11y`]: a frame to an AccessKit `TreeUpdate` (one text run per row, the
//!   caret and selection, polite announcements of new output), and minimal
//!   incremental updates.
//! * [`ime`]: composition state, which keys reach the program, and where the
//!   candidate window goes.
//! * [`compose`]: the composition drawn over a copy of the frame.
//! * [`blink`], [`selection`], [`shortcuts`]: cursor blink timing, copied text,
//!   copy/paste/zoom keys.
//! * [`source`]: TEMPORARY frame-source adapter, replaced by
//!   `canopy-term-session`'s `FrameSource` when that crate lands.
//!
//! The `window` feature (on by default) adds [`window::run`], which owns the
//! winit loop, the wgpu surface and the AccessKit adapter, and maps winit key,
//! mouse, paste and focus events onto `canopy-term-input` (`window::keymap`),
//! which does all the encoding.
//!
//! Dependency licences (checked with `cargo metadata` over every platform):
//! all MIT, Apache-2.0, BSD, ISC, Zlib or Unicode, except `clipboard-win` and
//! `error-code` (BSL-1.0, arboard's Windows backend) and `hexf-parse` (CC0-1.0,
//! via naga, already in the renderer). No copyleft.

pub mod a11y;
pub mod blink;
pub mod compose;
pub mod grid;
pub mod ime;
pub mod selection;
pub mod shortcuts;
pub mod source;

#[cfg(feature = "window")]
pub mod window;

pub use canopy_term_core::frame;
