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
pub mod input_bridge;

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use accesskit::{Action, ActionData, ActionRequest};
use canopy_term_core::frame::{Frame, Modes};
use canopy_term_render::builder::{QuadBuilder, RenderState};
use canopy_term_render::color::Theme;
use canopy_term_render::fonts::{FontBook, BUNDLED_FONT};
use canopy_term_render::geometry::Selection as RenderSelection;
use canopy_term_render::metrics::{layout, CellLayout, FontMetrics, Scale};
use canopy_term_render::renderer::Renderer;
use canopy_term_render::text::TextEngine;
use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use winit::event::{ElementState, Ime, KeyEvent, MouseButton, StartCause, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState};
use winit::window::{Window, WindowId};

pub use gpu::choose_format;
pub use input_bridge::{BasicInput, InputBridge};

use crate::a11y::A11yTree;
use crate::blink::CursorBlink;
use crate::compose::Composer;
use crate::grid::{cell_at, grid_size, CellPx, FontZoom, PxRect};
use crate::ime::{cursor_area, preedit_cols, ImeAction, ImeEvent, ImeGate};
use crate::selection::{selection_text, Selection};
use crate::shortcuts::{shortcut, Mods, Platform, Shortcut};
use crate::source::FrameSource;

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
pub fn run<S, I>(mut source: S, input: I, config: WindowConfig) -> Result<(), Error>
where
    S: FrameSource + 'static,
    I: InputBridge + 'static,
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
    let mut app = App::new(source, input, config, proxy);
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

struct App<S, I> {
    source: S,
    input: I,
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
    selection: Option<Selection>,
    drag_anchor: Option<(u16, u16)>,
    pointer: Option<(f64, f64)>,
    mods: ModifiersState,
    focused: bool,
    ime_area: Option<PxRect>,
    /// The surface must be presented even if no row changed (resize, expose).
    needs_present: bool,
}

impl<S: FrameSource, I: InputBridge> App<S, I> {
    fn new(source: S, input: I, config: WindowConfig, proxy: EventLoopProxy<UserEvent>) -> Self {
        let now = Instant::now();
        let mut blink = CursorBlink::new(now);
        blink.enabled = config.cursor_blink;
        App {
            source,
            input,
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
            selection: None,
            drag_anchor: None,
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
        let size = window.inner_size();
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

    fn modes(&self) -> Modes {
        self.frame.as_ref().map(|f| f.modes).unwrap_or_default()
    }

    fn write(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.source.write(bytes);
        self.blink.reset(Instant::now());
        self.pull();
        self.request_redraw();
    }

    /// Takes the newest frame from the source, relative to what was drawn.
    fn pull(&mut self) {
        let since = self
            .view
            .as_ref()
            .and_then(|v| v.builder.last_seq())
            .unwrap_or(0);
        if let Some(frame) = self.source.frame_since(since) {
            let old_title = self.frame.as_ref().and_then(|f| f.title.clone());
            if frame.title != old_title {
                if let Some(v) = &self.view {
                    let title = frame.title.as_deref().unwrap_or(&self.config.title);
                    v.window.set_title(title);
                }
            }
            self.frame = Some(frame);
            self.blink.reset(Instant::now());
            self.request_redraw();
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
            self.drag_anchor = None;
        }
        let modes = self.modes();
        if let Some(bytes) = self.input.focus(focused, &modes) {
            self.write(&bytes);
        }
        self.request_redraw();
    }

    fn on_key(&mut self, event: KeyEvent) {
        let pressed = event.state == ElementState::Pressed;
        if pressed {
            let key = match &event.logical_key {
                Key::Character(s) => s.as_str(),
                _ => "",
            };
            if let Some(sc) = shortcut(key, mods_of(self.mods), Platform::current()) {
                self.run_shortcut(sc);
                return;
            }
            if !self.ime.forward_key(event.text.as_deref()) {
                return;
            }
        } else if self.ime.composing() {
            return;
        }
        let modes = self.modes();
        if let Some(bytes) = self.input.key(&event, self.mods, &modes) {
            if !bytes.is_empty() {
                self.selection = None;
                self.write(&bytes);
            }
        }
    }

    fn run_shortcut(&mut self, sc: Shortcut) {
        match sc {
            Shortcut::Copy => {
                let text = match (&self.frame, &self.selection) {
                    (Some(f), Some(s)) => selection_text(f, s),
                    _ => return,
                };
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
                    let modes = self.modes();
                    let bytes = self.input.paste(&text, &modes);
                    self.write(&bytes);
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
                self.request_redraw();
            }
            ImeAction::Send(text) => {
                let modes = self.modes();
                let bytes = self.input.text(&text, &modes);
                self.ime_area = None;
                self.write(&bytes);
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

    fn on_pointer_moved(&mut self, pos: PhysicalPosition<f64>) {
        self.pointer = Some((pos.x, pos.y));
        let (Some(anchor), Some(v)) = (self.drag_anchor, &self.view) else {
            return;
        };
        let Some(cell) = cell_at((pos.x, pos.y), cell_px(&v.layout), self.grid) else {
            return;
        };
        let sel = Some(Selection {
            start: anchor,
            end: cell,
            block: self.mods.alt_key(),
        });
        if sel != self.selection {
            self.selection = sel;
            self.request_redraw();
        }
    }

    fn on_mouse_button(&mut self, state: ElementState, button: MouseButton) {
        if button != MouseButton::Left {
            return;
        }
        match state {
            ElementState::Pressed => {
                let (Some(pos), Some(v)) = (self.pointer, &self.view) else {
                    return;
                };
                self.drag_anchor = cell_at(pos, cell_px(&v.layout), self.grid);
                if self.selection.take().is_some() {
                    self.request_redraw();
                }
            }
            ElementState::Released => {
                self.drag_anchor = None;
                // A click without a drag selects nothing.
                if self.selection.is_some_and(|s| s.start == s.end) {
                    self.selection = None;
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
                let cell = cell_px(&v.layout);
                let a11y = &mut self.a11y;
                let sel = self.selection;
                v.adapter
                    .update_if_active(|| a11y.full(frame, cell, sel.as_ref()));
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
                self.selection = if a == f {
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
        let state = RenderState {
            selection: self.selection.map(to_render),
            cursor_on: self.blink.visible(now),
            focused: self.focused,
        };
        let report = {
            let composed = self.composer.view(frame, self.ime.preedit());
            v.builder.build(&composed, &state, &mut v.engine)
        };
        self.composer.drawn(report.held);
        if report.held {
            // Synchronized output: the program is mid-update. Nothing is
            // presented or announced until it finishes.
            return;
        }

        // Screen reader tree: only while one is listening, from the program's
        // frame (the composition is the input method's to announce).
        if self.a11y_active {
            if let Some(update) =
                self.a11y
                    .update(frame, cell_px(&v.layout), self.selection.as_ref())
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
                    self.needs_present = true;
                }
            }
        }
        self.update_ime_area();
    }
}

impl<S: FrameSource, I: InputBridge> ApplicationHandler<UserEvent> for App<S, I> {
    fn new_events(&mut self, _el: &ActiveEventLoop, cause: StartCause) {
        if let StartCause::ResumeTimeReached { .. } = cause {
            // A blink phase ended.
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
        match self.blink.next_change(Instant::now()) {
            Some(t) => el.set_control_flow(ControlFlow::WaitUntil(t)),
            None => el.set_control_flow(ControlFlow::Wait),
        }
    }
}
