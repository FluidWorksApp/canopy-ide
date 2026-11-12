//! The native window: a winit event loop driving the renderer on a wgpu
//! surface, with IME, clipboard, zoom, cursor blink and an AccessKit adapter.
//!
//! The logic lives in the window-free modules (`grid`, `a11y`, `ime`,
//! `compose`, `blink`, `selection`, `shortcuts`); this module only routes winit
//! events to them and to the renderer. Frame pacing follows the renderer's
//! design: no render loop, a redraw only when something visible changed
//! (a new frame, a blink tick, selection, focus, resize), present with vsync,
//! nothing presented during synchronized output.

mod gpu;
pub mod keymap;

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use accesskit::{Action, ActionData, ActionRequest};
use canopy_term_core::frame::{Frame, Modes};
use canopy_term_core::Row;
use canopy_term_input as input;
use canopy_term_render::builder::{QuadBuilder, RenderState};
use canopy_term_render::color::Theme;
use canopy_term_render::fonts::{FontBook, BUNDLED_FONT};
use canopy_term_render::geometry::Selection as RenderSelection;
use canopy_term_render::metrics::{layout, CellLayout, FontMetrics, Scale};
use canopy_term_render::renderer::Renderer;
use canopy_term_render::text::TextEngine;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{
    ElementState, Ime, KeyEvent, MouseButton, MouseScrollDelta, StartCause, WindowEvent,
};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowId};

pub use canopy_term_session::{FrameSource, Waker};
pub use gpu::choose_format;

use keymap::{map_key, mods_from, mouse_button, reports_mouse, wheel_steps, KeyParts};

use crate::a11y::{A11yTree, UiExtras};
use crate::blink::CursorBlink;
use crate::compose::Composer;
use crate::grid::{cell_at, grid_size, CellPx, FontZoom, PxRect};
use crate::ime::{cursor_area, preedit_cols, ImeAction, ImeEvent, ImeGate};
use crate::lines::{self, AbsSelection, ClickTracker, Granularity, Lines, SelectionDrag};
use crate::overlay::draw_badge;
use crate::selection::Selection;
use crate::shortcuts::{shortcut_with_selection, Mods, Platform, Shortcut};
use crate::viewport::{
    edge_scroll, history_span, indicator_text, row_from_frame, scroll_command, scrolled_view,
    wheel_action, ScrollCmd, ScrollKey, Viewport, WheelAction,
};

/// Atlas edge in pixels: room for a screen of glyphs at large zoom on HiDPI.
const ATLAS_SIZE: u16 = 2048;

/// Events delivered to the loop from other threads.
#[derive(Debug)]
pub enum UserEvent {
    /// The frame source has a new frame.
    Wake,
    AccessKit(accesskit_winit::Event),
}

impl From<accesskit_winit::Event> for UserEvent {
    fn from(e: accesskit_winit::Event) -> Self {
        UserEvent::AccessKit(e)
    }
}

#[derive(Clone, Debug)]
pub struct WindowConfig {
    pub title: String,
    /// Font size in logical pixels (times the display scale = physical).
    pub font_px: f32,
    /// Grid size the window opens at.
    pub initial_grid: (u16, u16),
    pub theme: Theme,
    /// Load the machine's fonts as fallbacks (CJK, emoji) after the bundled one.
    pub system_fonts: bool,
    /// Off: the cursor never blinks (also the right setting under reduced motion).
    pub cursor_blink: bool,
}

impl Default for WindowConfig {
    fn default() -> Self {
        WindowConfig {
            title: "Canopy Terminal".to_string(),
            font_px: 14.0,
            initial_grid: (100, 30),
            theme: Theme::default(),
            system_fonts: true,
            cursor_blink: true,
        }
    }
}

#[derive(Debug)]
pub enum Error {
    EventLoop(winit::error::EventLoopError),
    Window(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::EventLoop(e) => write!(f, "event loop: {e}"),
            Error::Window(e) => write!(f, "window: {e}"),
        }
    }
}

impl std::error::Error for Error {}

/// Opens the window and runs until it is closed or the source closes. Must be
/// called on the main thread (macOS requires it).
pub fn run<S>(mut source: S, config: WindowConfig) -> Result<(), Error>
where
    S: FrameSource + 'static,
{
    let event_loop = EventLoop::<UserEvent>::with_user_event()
        .build()
        .map_err(Error::EventLoop)?;
    let proxy = event_loop.create_proxy();
    let wake = Mutex::new(proxy.clone());
    source.set_waker(Arc::new(move || {
        if let Ok(p) = wake.lock() {
            let _ = p.send_event(UserEvent::Wake);
        }
    }));
    let mut app = App::new(source, config, proxy);
    event_loop.run_app(&mut app).map_err(Error::EventLoop)?;
    match app.fatal.take() {
        Some(e) => Err(Error::Window(e)),
        None => Ok(()),
    }
}

fn cell_px(l: &CellLayout) -> CellPx {
    CellPx {
        width: l.width,
        height: l.height,
    }
}

fn mods_of(m: ModifiersState) -> Mods {
    Mods {
        shift: m.shift_key(),
        ctrl: m.control_key(),
        alt: m.alt_key(),
        logo: m.super_key(),
    }
}

fn to_render(s: Selection) -> RenderSelection {
    RenderSelection {
        start: s.start,
        end: s.end,
        block: s.block,
    }
}

fn ime_event(ime: Ime) -> ImeEvent {
    match ime {
        Ime::Enabled => ImeEvent::Enabled,
        Ime::Preedit(text, caret) => ImeEvent::Preedit(text, caret),
        Ime::Commit(text) => ImeEvent::Commit(text),
        Ime::Disabled => ImeEvent::Disabled,
    }
}

/// Line access for copy and word selection: scrollback from the source, then
/// the live screen from the frame being shown.
struct SourceLines<'a, S: FrameSource> {
    source: &'a S,
    live: &'a Frame,
    /// Lines of scrollback.
    total: usize,
}

impl<S: FrameSource> Lines for SourceLines<'_, S> {
    fn total(&self) -> usize {
        self.total + self.live.rows as usize
    }

    fn fetch(&self, start: usize, count: usize) -> Vec<Row> {
        let mut out = Vec::new();
        if start < self.total {
            let n = count.min(self.total - start);
            out = self.source.scrollback_rows(start, n);
            // A short answer (history trimmed meanwhile) keeps lines aligned.
            out.resize(n, Row::default());
        }
        let from = start.max(self.total) - self.total;
        let to = start
            .saturating_add(count)
            .saturating_sub(self.total)
            .min(self.live.rows as usize);
        for r in from..to {
            out.push(row_from_frame(self.live, r as u16));
        }
        out
    }
}

/// The scrolled view of `live`, or `None` when the view is live (or on the
/// alternate screen, which has no scrollback).
fn scrolled_frame<S: FrameSource>(
    source: &S,
    viewport: &Viewport,
    total: usize,
    live: &Frame,
) -> Option<Frame> {
    if viewport.is_live() || live.alt_screen {
        return None;
    }
    let (first, count) = history_span(total, viewport.offset(), live.rows);
    let history = source.scrollback_rows(first, count);
    Some(scrolled_view(live, &history, total, viewport.offset()))
}

/// What the accessibility tree says besides the screen.
fn extras_for(viewport: &Viewport, total: usize) -> UiExtras {
    UiExtras {
        scrollback: (!viewport.is_live()).then(|| (viewport.offset(), total)),
    }
}

/// A modifier or lock key on its own: it types nothing, so it does not return
/// the view to the live screen.
fn is_modifier_key(key: &Key) -> bool {
    matches!(
        key,
        Key::Named(
            NamedKey::Shift
                | NamedKey::Control
                | NamedKey::Alt
                | NamedKey::AltGraph
                | NamedKey::Super
                | NamedKey::Meta
                | NamedKey::Hyper
                | NamedKey::CapsLock
                | NamedKey::NumLock
                | NamedKey::ScrollLock
                | NamedKey::Fn
                | NamedKey::FnLock
                | NamedKey::Symbol
                | NamedKey::SymbolLock
        )
    )
}

/// Everything that exists only once the window does.
struct View {
    window: Arc<Window>,
    gpu: gpu::SurfaceState,
    renderer: Renderer,
    builder: QuadBuilder,
    engine: TextEngine,
    metrics: FontMetrics,
    layout: CellLayout,
    adapter: accesskit_winit::Adapter,
    clipboard: Option<arboard::Clipboard>,
}

/// winit's key without modifiers ("1" for Shift+1), where winit provides it.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn unmodified_key(e: &KeyEvent) -> Key {
    use winit::platform::modifier_supplement::KeyEventExtModifierSupplement;
    e.key_without_modifiers()
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn unmodified_key(e: &KeyEvent) -> Key {
    e.logical_key.clone()
}

struct App<S> {
    source: S,
    config: WindowConfig,
    proxy: EventLoopProxy<UserEvent>,
    view: Option<View>,
    fatal: Option<String>,
    exit: bool,

    frame: Option<Frame>,
    grid: (u16, u16),
    font: FontZoom,
    blink: CursorBlink,
    ime: ImeGate,
    composer: Composer,
    a11y: A11yTree,
    /// A screen reader asked for the tree and has not gone away.
    a11y_active: bool,
    /// The selection, in absolute lines so it survives scrolling.
    sel: Option<AbsSelection>,
    /// A mouse selection in progress (press seen, release not yet).
    drag: Option<SelectionDrag>,
    clicks: ClickTracker,
    /// Where the view sits in the scrollback, and the history length last
    /// seen (0 on the alternate screen).
    viewport: Viewport,
    history_len: usize,
    alt_seen: bool,
    /// The last frame drawn was a scrolled view (so the next live frame must
    /// be redrawn in full).
    scrolled_drawn: bool,
    pointer: Option<(f64, f64)>,
    mods: ModifiersState,
    focused: bool,
    ime_area: Option<PxRect>,
    /// The surface must be presented even if no row changed (resize, expose).
    needs_present: bool,
    /// The title the window shows, to spot a change without cloning the
    /// frame's.
    title_shown: Option<String>,
    /// Mouse reporting: the button held (for motion reports), the last cell
    /// reported, and the wheel's fractional steps.
    mouse_held: Option<input::MouseButton>,
    mouse_cell: Option<(u16, u16)>,
    wheel_acc: f64,
}

impl<S: FrameSource> App<S> {
    fn new(source: S, config: WindowConfig, proxy: EventLoopProxy<UserEvent>) -> Self {
        let now = Instant::now();
        let mut blink = CursorBlink::new(now);
        blink.enabled = config.cursor_blink;
        App {
            source,
            title_shown: None,
            mouse_held: None,
            mouse_cell: None,
            wheel_acc: 0.0,
            font: FontZoom::new(config.font_px),
            config,
            proxy,
            view: None,
            fatal: None,
            exit: false,
            frame: None,
            grid: (0, 0),
            blink,
            ime: ImeGate::new(),
            composer: Composer::default(),
            a11y: A11yTree::new(),
            a11y_active: false,
            sel: None,
            drag: None,
            clicks: ClickTracker::default(),
            viewport: Viewport::default(),
            history_len: 0,
            alt_seen: false,
            scrolled_drawn: false,
            pointer: None,
            mods: ModifiersState::empty(),
            focused: true,
            ime_area: None,
            needs_present: true,
        }
    }

    fn create_view(&mut self, el: &ActiveEventLoop) -> Result<View, String> {
        let metrics = FontMetrics::from_font_data(BUNDLED_FONT, 0)
            .ok_or("the bundled font has no metrics")?;
        let logical = layout(&metrics, self.font.px, Scale(1.0));
        let (cols, rows) = self.config.initial_grid;
        let attrs = Window::default_attributes()
            .with_title(self.config.title.clone())
            // AccessKit's adapter must exist before the window is first shown.
            .with_visible(false)
            .with_inner_size(LogicalSize::new(
                logical.width as f64 * cols.max(1) as f64,
                logical.height as f64 * rows.max(1) as f64,
            ));
        let window = Arc::new(el.create_window(attrs).map_err(|e| e.to_string())?);
        let adapter =
            accesskit_winit::Adapter::with_event_loop_proxy(el, &window, self.proxy.clone());
        let cell_layout = layout(&metrics, self.font.px, Scale(window.scale_factor() as f32));
        // The logical size above used the 1x cell. Cells are whole physical
        // pixels, so at 2x a cell can be 17 px, not 2 x 8: size the window from
        // the real cell so it opens at the requested grid. A platform that
        // applies this later sends `Resized`.
        let wanted = PhysicalSize::new(
            cell_layout.width * cols.max(1) as u32,
            cell_layout.height * rows.max(1) as u32,
        );
        let size = window
            .request_inner_size(wanted)
            .unwrap_or_else(|| window.inner_size());
        let gpu = gpu::SurfaceState::new(window.clone(), size.width, size.height)?;
        let renderer = Renderer::new(
            gpu.device.clone(),
            gpu.queue.clone(),
            gpu.view_format,
            (ATLAS_SIZE as u32, ATLAS_SIZE as u32),
        );
        let mut fonts = FontBook::bundled();
        if self.config.system_fonts {
            fonts.load_system_fonts();
        }
        let engine = TextEngine::new(fonts, cell_layout, ATLAS_SIZE);
        let builder = QuadBuilder::new(cell_layout, self.config.theme);
        let clipboard = arboard::Clipboard::new().ok();
        window.set_ime_allowed(true);
        window.set_visible(true);
        Ok(View {
            window,
            gpu,
            renderer,
            builder,
            engine,
            metrics,
            layout: cell_layout,
            adapter,
            clipboard,
        })
    }

    fn request_redraw(&self) {
        if let Some(v) = &self.view {
            v.window.request_redraw();
        }
    }

    /// The absolute line shown on the top screen row.
    fn top_line(&self) -> usize {
        self.viewport.abs_line(0, self.history_len)
    }

    /// Back to the live screen (input was sent, or a composition began).
    fn snap_to_bottom(&mut self) {
        if self.viewport.to_bottom() {
            self.clicks.reset();
            self.request_redraw();
        }
    }

    /// After a new frame: the history length, the viewport that follows it,
    /// and the reset an alternate-screen switch needs (no scrollback there, and
    /// a selection of the other screen's text means nothing).
    fn track_history(&mut self, alt: bool) {
        let prev = self.history_len;
        self.history_len = if alt { 0 } else { self.source.scrollback_len() };
        if alt != self.alt_seen {
            self.alt_seen = alt;
            self.sel = None;
            self.drag = None;
            self.clicks.reset();
            self.viewport.to_bottom();
        }
        self.viewport.follow(prev, self.history_len);
    }

    /// The program's current modes, from the source: they can be newer than
    /// the last frame drawn.
    fn modes(&self) -> Modes {
        self.source.modes()
    }

    /// After the source took input: restart the blink, and pull at once so
    /// the echo shows without waiting for a wake. Returns `sent`.
    fn input_sent(&mut self, sent: bool) -> bool {
        if sent {
            self.blink.reset(Instant::now());
            self.pull();
            self.request_redraw();
        }
        sent
    }

    /// Takes the newest frame from the source, relative to what was drawn.
    fn pull(&mut self) {
        let since = self
            .view
            .as_ref()
            .and_then(|v| v.builder.last_seq())
            .unwrap_or(0);
        // Into the frame already held, so a steady window allocates nothing
        // per frame.
        let had = self.frame.is_some();
        let mut frame = self.frame.take().unwrap_or_default();
        let got = self.source.frame_into(since, &mut frame);
        if got {
            self.track_history(frame.alt_screen);
            if frame.title != self.title_shown {
                self.title_shown.clone_from(&frame.title);
                if let Some(v) = &self.view {
                    let title = frame.title.as_deref().unwrap_or(&self.config.title);
                    v.window.set_title(title);
                }
            }
            self.blink.reset(Instant::now());
            self.request_redraw();
        }
        if got || had {
            self.frame = Some(frame);
        }
        if self.source.closed() {
            self.exit = true;
        }
    }

    /// Recomputes the grid from the surface and cell size; tells the source
    /// when it changed.
    fn update_grid(&mut self) {
        let Some(v) = &self.view else {
            return;
        };
        let size = v.window.inner_size();
        if size.width == 0 || size.height == 0 {
            return;
        }
        let grid = grid_size((size.width, size.height), cell_px(&v.layout));
        if grid != self.grid {
            self.grid = grid;
            // Reflow moves text between lines: a selection or click count no
            // longer points at what it did.
            self.sel = None;
            self.drag = None;
            self.clicks.reset();
            self.source.resize(grid.0, grid.1);
            self.pull();
        }
    }

    /// The font size or display scale changed: new cell layout everywhere.
    fn apply_layout(&mut self) {
        let Some(v) = self.view.as_mut() else {
            return;
        };
        let scale = v.window.scale_factor() as f32;
        let l = layout(&v.metrics, self.font.px, Scale(scale));
        v.layout = l;
        v.builder.set_layout(l);
        v.engine.set_layout(l);
        self.needs_present = true;
        self.ime_area = None;
        self.update_grid();
        self.request_redraw();
    }

    fn on_resize(&mut self, size: PhysicalSize<u32>) {
        if let Some(v) = self.view.as_mut() {
            v.gpu.resize(size.width, size.height);
        }
        self.needs_present = true;
        self.update_grid();
        self.request_redraw();
    }

    fn on_focus(&mut self, focused: bool) {
        let now = Instant::now();
        self.focused = focused;
        self.blink.set_focused(focused, now);
        if !focused {
            self.ime.focus_lost();
            self.drag = None;
        }
        let sent = self.source.focus(focused);
        self.input_sent(sent);
        self.request_redraw();
    }

    fn on_key(&mut self, event: KeyEvent) {
        let pressed = event.state == ElementState::Pressed;
        if pressed {
            let key = match &event.logical_key {
                Key::Character(s) => s.as_str(),
                _ => "",
            };
            let platform = Platform::current();
            if let Some(sc) =
                shortcut_with_selection(key, mods_of(self.mods), platform, self.sel.is_some())
            {
                // Plain Ctrl+C that copied is spent: the next one interrupts.
                let spent =
                    sc == Shortcut::Copy && platform == Platform::Other && !self.mods.shift_key();
                self.run_shortcut(sc);
                if spent {
                    self.sel = None;
                    self.request_redraw();
                }
                return;
            }
            if !self.ime.forward_key(event.text.as_deref()) {
                return;
            }
            if self.scroll_key(&event.logical_key) {
                return;
            }
        } else if self.ime.composing() {
            return;
        }
        let unmodified = unmodified_key(&event);
        let parts = KeyParts {
            logical: &event.logical_key,
            unmodified: &unmodified,
            location: event.location,
            state: event.state,
            repeat: event.repeat,
            text: event.text.as_deref(),
            mods: self.mods,
        };
        let mapped = map_key(&parts, Platform::current());
        let text = parts.text;
        let sent = match mapped {
            Some(ev) => self.source.key(&ev),
            // Dead or unidentified keys: whatever text the platform produced.
            None if pressed => text.is_some_and(|t| self.source.text(t)),
            None => false,
        };
        let wrote = self.input_sent(sent);
        if wrote && pressed {
            if self.sel.take().is_some() {
                self.request_redraw();
            }
            // Typing returns to the live screen; a bare modifier press does not.
            if !is_modifier_key(&event.logical_key) {
                self.snap_to_bottom();
            }
        }
    }

    /// Shift+PageUp and friends move the view through history instead of
    /// reaching the program (see `viewport::scroll_command`). True if the key
    /// was taken.
    fn scroll_key(&mut self, logical: &Key) -> bool {
        let Key::Named(named) = logical else {
            return false;
        };
        let key = match named {
            NamedKey::PageUp => ScrollKey::PageUp,
            NamedKey::PageDown => ScrollKey::PageDown,
            NamedKey::Home => ScrollKey::Home,
            NamedKey::End => ScrollKey::End,
            _ => return false,
        };
        let m = self.mods;
        let other = m.control_key() || m.alt_key() || m.super_key();
        let alt_screen = self.frame.as_ref().is_some_and(|f| f.alt_screen);
        let Some(cmd) = scroll_command(
            key,
            m.shift_key(),
            other,
            alt_screen,
            !self.viewport.is_live(),
        ) else {
            return false;
        };
        let rows = self.frame.as_ref().map_or(self.grid.1, |f| f.rows);
        let total = self.history_len;
        let moved = match cmd {
            ScrollCmd::PageUp => self.viewport.page(true, rows, total),
            ScrollCmd::PageDown => self.viewport.page(false, rows, total),
            ScrollCmd::Top => self.viewport.to_top(total),
            ScrollCmd::Bottom => self.viewport.to_bottom(),
        };
        if moved {
            self.clicks.reset();
            self.request_redraw();
        }
        true
    }

    fn run_shortcut(&mut self, sc: Shortcut) {
        match sc {
            Shortcut::Copy => {
                let text = match (&self.frame, self.sel) {
                    (Some(f), Some(s)) => {
                        let src = SourceLines {
                            source: &self.source,
                            live: f,
                            total: self.history_len,
                        };
                        lines::selection_text(&s, &src)
                    }
                    _ => return,
                };
                if text.is_empty() {
                    return;
                }
                if let Some(cb) = self.view.as_mut().and_then(|v| v.clipboard.as_mut()) {
                    let _ = cb.set_text(text);
                }
            }
            Shortcut::Paste => {
                let text = self
                    .view
                    .as_mut()
                    .and_then(|v| v.clipboard.as_mut())
                    .and_then(|cb| cb.get_text().ok());
                if let Some(text) = text {
                    let sent = self.source.paste(&text);
                    if self.input_sent(sent) {
                        self.snap_to_bottom();
                    }
                }
            }
            Shortcut::ZoomIn => {
                if self.font.zoom_in() {
                    self.apply_layout();
                }
            }
            Shortcut::ZoomOut => {
                if self.font.zoom_out() {
                    self.apply_layout();
                }
            }
            Shortcut::ZoomReset => {
                if self.font.reset() {
                    self.apply_layout();
                }
            }
        }
    }

    fn on_ime(&mut self, ime: Ime) {
        match self.ime.on_event(ime_event(ime)) {
            ImeAction::None => {}
            ImeAction::Redraw => {
                self.ime_area = None;
                // The composition is drawn at the live cursor.
                if self.ime.composing() {
                    self.snap_to_bottom();
                }
                self.request_redraw();
            }
            ImeAction::Send(text) => {
                self.ime_area = None;
                let sent = self.source.text(&text);
                if self.input_sent(sent) {
                    self.snap_to_bottom();
                }
            }
        }
        self.update_ime_area();
    }

    /// Keeps the IME candidate window on the cursor (or the composition).
    fn update_ime_area(&mut self) {
        let (Some(v), Some(f)) = (&self.view, &self.frame) else {
            return;
        };
        let cols = self.ime.preedit().map_or(0, preedit_cols);
        let area = cursor_area(
            (f.cursor.row, f.cursor.col),
            cols,
            cell_px(&v.layout),
            f.cols,
        );
        if self.ime_area != Some(area) {
            v.window.set_ime_cursor_area(
                PhysicalPosition::new(area.x, area.y),
                PhysicalSize::new(area.w, area.h),
            );
            self.ime_area = Some(area);
        }
    }

    fn pointer_cell(&self) -> Option<(u16, u16)> {
        let (pos, v) = (self.pointer?, self.view.as_ref()?);
        cell_at(pos, cell_px(&v.layout), self.grid)
    }

    /// Reports a mouse event to the program at the pointer's cell.
    fn report_mouse(&mut self, kind: input::MouseEventKind) -> bool {
        let Some((row, col)) = self.pointer_cell() else {
            return false;
        };
        let ev = input::MouseEvent {
            kind,
            col,
            row,
            mods: mods_from(self.mods),
        };
        self.mouse_cell = Some((row, col));
        let sent = self.source.mouse(&ev);
        self.input_sent(sent)
    }

    fn on_pointer_moved(&mut self, pos: PhysicalPosition<f64>) {
        self.pointer = Some((pos.x, pos.y));
        if self.drag.is_none() && reports_mouse(&self.modes(), self.mods) {
            let cell = self.pointer_cell();
            if cell.is_some() && cell != self.mouse_cell {
                self.report_mouse(input::MouseEventKind::Motion(self.mouse_held));
            }
            return;
        }
        let (Some(drag), Some(px)) = (self.drag, self.view.as_ref().map(|v| cell_px(&v.layout)))
        else {
            return;
        };
        let Some(cell) = cell_at((pos.x, pos.y), px, self.grid) else {
            return;
        };
        // Dragging past the top or bottom edge scrolls through history.
        let height = (self.grid.1 as u32 * px.height) as f64;
        let edge = edge_scroll(pos.y, height, px.height);
        let scrolled = edge != 0 && self.viewport.scroll_by(edge, self.history_len);
        let Some(frame) = self.frame.as_ref() else {
            return;
        };
        let at = (self.top_line() + cell.0 as usize, cell.1);
        let src = SourceLines {
            source: &self.source,
            live: frame,
            total: self.history_len,
        };
        let sel = Some(drag.selection_to(&src, at, self.mods.alt_key()));
        if sel != self.sel {
            self.sel = sel;
            self.request_redraw();
        } else if scrolled {
            self.request_redraw();
        }
    }

    fn on_mouse_button(&mut self, state: ElementState, button: MouseButton) {
        // The program asked for the mouse (and Shift is not held): report it.
        // A release is reported for a press that was, even if Shift came down
        // in between.
        let reporting = self.drag.is_none()
            && (reports_mouse(&self.modes(), self.mods)
                || (state == ElementState::Released && self.mouse_held.is_some()));
        if reporting {
            if let Some(b) = mouse_button(button) {
                let kind = match state {
                    ElementState::Pressed => {
                        self.mouse_held = Some(b);
                        input::MouseEventKind::Press(b)
                    }
                    ElementState::Released => {
                        if self.mouse_held == Some(b) {
                            self.mouse_held = None;
                        }
                        input::MouseEventKind::Release(b)
                    }
                };
                self.report_mouse(kind);
            }
            return;
        }
        if button != MouseButton::Left {
            return;
        }
        match state {
            ElementState::Pressed => {
                let (Some(pos), Some(px)) =
                    (self.pointer, self.view.as_ref().map(|v| cell_px(&v.layout)))
                else {
                    return;
                };
                let Some(cell) = cell_at(pos, px, self.grid) else {
                    return;
                };
                // One click starts a cell selection, two select the word, three
                // the line; dragging extends by that unit.
                let count = self.clicks.register(Instant::now(), cell);
                let gran = Granularity::for_clicks(count);
                let at = (self.top_line() + cell.0 as usize, cell.1);
                let Some(frame) = self.frame.as_ref() else {
                    return;
                };
                let src = SourceLines {
                    source: &self.source,
                    live: frame,
                    total: self.history_len,
                };
                let drag = SelectionDrag::new(gran, &src, at);
                let sel = match gran {
                    Granularity::Cell => None,
                    _ => Some(drag.selection(self.mods.alt_key())),
                };
                self.drag = Some(drag);
                if sel != self.sel {
                    self.sel = sel;
                    self.request_redraw();
                }
            }
            ElementState::Released => {
                let gran = self.drag.take().map(|d| d.gran);
                // A click without a drag selects nothing.
                if gran == Some(Granularity::Cell) && self.sel.is_some_and(|s| s.anchor == s.head) {
                    self.sel = None;
                    self.request_redraw();
                }
            }
        }
    }

    /// The wheel: to the program when it reports the mouse; otherwise arrow
    /// keys on the alternate screen (no scrollback there) and a scroll through
    /// history on the primary screen. See `viewport::wheel_action`.
    fn on_wheel(&mut self, delta: MouseScrollDelta) {
        let Some(cell_h) = self.view.as_ref().map(|v| v.layout.height) else {
            return;
        };
        let reporting = reports_mouse(&self.modes(), self.mods);
        let steps = wheel_steps(&mut self.wheel_acc, delta, cell_h);
        let alt = self.frame.as_ref().is_some_and(|f| f.alt_screen);
        let line_delta = matches!(delta, MouseScrollDelta::LineDelta(..));
        match wheel_action(alt, reporting, steps, line_delta) {
            WheelAction::None => {}
            WheelAction::Report(n) => {
                let button = if n > 0 {
                    input::MouseButton::WheelUp
                } else {
                    input::MouseButton::WheelDown
                };
                for _ in 0..n.unsigned_abs().min(50) {
                    self.report_mouse(input::MouseEventKind::Press(button));
                }
            }
            WheelAction::Arrows { up, count } => {
                let key = if up { input::Key::Up } else { input::Key::Down };
                let mut sent = false;
                for _ in 0..count {
                    sent |= self.source.key(&input::KeyEvent::new(key));
                }
                self.input_sent(sent);
            }
            WheelAction::Scroll(lines) => {
                if self.viewport.scroll_by(lines, self.history_len) {
                    self.clicks.reset();
                    self.request_redraw();
                }
            }
        }
    }

    fn on_accesskit(&mut self, event: accesskit_winit::WindowEvent) {
        match event {
            accesskit_winit::WindowEvent::InitialTreeRequested => {
                self.a11y_active = true;
                let Some(v) = self.view.as_mut() else {
                    return;
                };
                let blank;
                let frame = match &self.frame {
                    Some(f) => f,
                    None => {
                        blank = Frame::blank(self.grid.0.max(1), self.grid.1.max(1));
                        &blank
                    }
                };
                // What a screen reader reads is what is on screen: the scrolled
                // view when scrolled back.
                let plain = scrolled_frame(&self.source, &self.viewport, self.history_len, frame);
                let shown = plain.as_ref().unwrap_or(frame);
                let top = self.viewport.abs_line(0, self.history_len);
                let sel = self
                    .sel
                    .and_then(|s| s.to_screen(top, shown.rows, shown.cols));
                self.a11y
                    .set_extras(extras_for(&self.viewport, self.history_len));
                let cell = cell_px(&v.layout);
                let a11y = &mut self.a11y;
                v.adapter
                    .update_if_active(|| a11y.full(shown, cell, sel.as_ref()));
            }
            accesskit_winit::WindowEvent::ActionRequested(req) => self.on_action(req),
            accesskit_winit::WindowEvent::AccessibilityDeactivated => {
                self.a11y_active = false;
                self.a11y.deactivate();
            }
        }
    }

    fn on_action(&mut self, req: ActionRequest) {
        match req.action {
            Action::Focus => {
                if let Some(v) = &self.view {
                    v.window.focus_window();
                }
            }
            Action::SetTextSelection => {
                let Some(ActionData::SetTextSelection(ts)) = req.data else {
                    return;
                };
                let (Some(a), Some(f)) = (
                    self.a11y.cell_for(&ts.anchor),
                    self.a11y.cell_for(&ts.focus),
                ) else {
                    return;
                };
                // AccessKit's focus is exclusive; ours is the last selected cell.
                let top = self.top_line();
                let screen = if a == f {
                    None
                } else if a < f {
                    Some(Selection {
                        start: a,
                        end: (f.0, f.1.saturating_sub(1)),
                        block: false,
                    })
                } else {
                    Some(Selection {
                        start: (a.0, a.1.saturating_sub(1)),
                        end: f,
                        block: false,
                    })
                };
                self.sel = screen.map(|s| AbsSelection::from_screen(&s, top));
                self.request_redraw();
            }
            _ => {}
        }
    }

    fn redraw(&mut self) {
        let now = Instant::now();
        let Some(v) = self.view.as_mut() else {
            return;
        };
        let Some(frame) = self.frame.as_ref() else {
            return;
        };
        if !v.gpu.configured() {
            return;
        }
        // The view: the live frame, or history with the live screen below it.
        let plain = scrolled_frame(&self.source, &self.viewport, self.history_len, frame);
        let scrolled = plain.is_some();
        let base: &Frame = plain.as_ref().unwrap_or(frame);
        let top = self.viewport.abs_line(0, self.history_len);
        let screen_sel = self
            .sel
            .and_then(|s| s.to_screen(top, base.rows, base.cols));
        // The drawn copy carries the badge; leaving the scrolled view redraws
        // the live frame in full once, which wipes it.
        let marked: Option<Frame> = if scrolled {
            let mut f = base.clone();
            let text = indicator_text(self.viewport.offset(), self.history_len, f.cols);
            draw_badge(&mut f, &text);
            Some(f)
        } else if self.scrolled_drawn {
            let mut f = frame.clone();
            f.damage.full = true;
            Some(f)
        } else {
            None
        };
        let shown: &Frame = marked.as_ref().unwrap_or(base);
        let state = RenderState {
            selection: screen_sel.map(to_render),
            cursor_on: self.blink.visible(now),
            focused: self.focused,
        };
        let report = {
            let composed = self.composer.view(shown, self.ime.preedit());
            v.builder.build(&composed, &state, &mut v.engine)
        };
        self.composer.drawn(report.held);
        if report.held {
            // Synchronized output: the program is mid-update. Nothing is
            // presented or announced until it finishes.
            return;
        }
        self.scrolled_drawn = scrolled;

        // Screen reader tree: only while one is listening, from the screen
        // as shown without the badge (the badge is a status node, and the
        // composition is the input method's to announce).
        if self.a11y_active {
            self.a11y
                .set_extras(extras_for(&self.viewport, self.history_len));
            if let Some(update) = self
                .a11y
                .update(base, cell_px(&v.layout), screen_sel.as_ref())
            {
                v.adapter.update_if_active(|| update);
            }
        }

        if !report.rows.is_empty() || self.needs_present {
            v.renderer.sync(&v.builder, &report, v.engine.atlas_mut());
            match v.gpu.surface.get_current_texture() {
                Ok(texture) => {
                    let target = texture.texture.create_view(&wgpu::TextureViewDescriptor {
                        format: Some(v.gpu.view_format),
                        ..Default::default()
                    });
                    v.renderer.render(
                        &target,
                        v.gpu.size(),
                        self.config.theme.bg,
                        v.builder.draw_count(),
                    );
                    v.window.pre_present_notify();
                    texture.present();
                    self.needs_present = false;
                }
                Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                    v.gpu.reconfigure();
                    self.needs_present = true;
                    v.window.request_redraw();
                }
                Err(wgpu::SurfaceError::OutOfMemory) => {
                    self.fatal = Some("the GPU is out of memory".to_string());
                    self.exit = true;
                }
                Err(wgpu::SurfaceError::Timeout | wgpu::SurfaceError::Other) => {
                    // Try again on the next frame rather than leave it stale.
                    self.needs_present = true;
                    v.window.request_redraw();
                }
            }
        }
        self.update_ime_area();
    }
}

impl<S: FrameSource> ApplicationHandler<UserEvent> for App<S> {
    fn new_events(&mut self, _el: &ActiveEventLoop, cause: StartCause) {
        if let StartCause::ResumeTimeReached { .. } = cause {
            // A blink phase ended, or the source's deadline passed (the end
            // of a synchronized-output hold, or input to offer the link again).
            self.pull();
            self.request_redraw();
        }
    }

    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.view.is_some() {
            return;
        }
        match self.create_view(el) {
            Ok(view) => {
                self.view = Some(view);
                self.update_grid();
                self.pull();
                self.request_redraw();
            }
            Err(e) => {
                self.fatal = Some(e);
                el.exit();
            }
        }
    }

    fn user_event(&mut self, _el: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Wake => self.pull(),
            UserEvent::AccessKit(e) => {
                let ours = self
                    .view
                    .as_ref()
                    .is_some_and(|v| v.window.id() == e.window_id);
                if ours {
                    self.on_accesskit(e.window_event);
                }
            }
        }
    }

    fn window_event(&mut self, el: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        {
            let Some(v) = self.view.as_mut() else {
                return;
            };
            if v.window.id() != id {
                return;
            }
            v.adapter.process_event(&v.window, &event);
        }
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Resized(size) => self.on_resize(size),
            WindowEvent::ScaleFactorChanged { .. } => self.apply_layout(),
            WindowEvent::Focused(focused) => self.on_focus(focused),
            WindowEvent::ModifiersChanged(m) => self.mods = m.state(),
            WindowEvent::KeyboardInput {
                event,
                is_synthetic,
                ..
            } => {
                // Synthetic presses are keys already held when focus arrived.
                if !is_synthetic {
                    self.on_key(event);
                }
            }
            WindowEvent::Ime(ime) => self.on_ime(ime),
            WindowEvent::CursorMoved { position, .. } => self.on_pointer_moved(position),
            WindowEvent::MouseInput { state, button, .. } => self.on_mouse_button(state, button),
            WindowEvent::MouseWheel { delta, .. } => self.on_wheel(delta),
            WindowEvent::Occluded(false) => {
                self.needs_present = true;
                self.request_redraw();
            }
            WindowEvent::RedrawRequested => self.redraw(),
            _ => {}
        }
    }

    fn about_to_wait(&mut self, el: &ActiveEventLoop) {
        if self.exit {
            el.exit();
            return;
        }
        // The earlier of the next blink phase and the source's deadline; with
        // neither, sleep until an event.
        let next = match (
            self.blink.next_change(Instant::now()),
            self.source.deadline(),
        ) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        match next {
            Some(t) => el.set_control_flow(ControlFlow::WaitUntil(t)),
            None => el.set_control_flow(ControlFlow::Wait),
        }
    }
}
