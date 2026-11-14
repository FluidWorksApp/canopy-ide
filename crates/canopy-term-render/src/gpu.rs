//! The wgpu layer. Everything that needs a device lives here; the layers above
//! (metrics, atlas, shaping, quad building) never touch it.

/// A device with no window: what an offscreen render or a CI probe uses.
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
}

/// One line describing an adapter.
pub fn describe(info: &wgpu::AdapterInfo) -> String {
    format!(
        "backend={:?} type={:?} name={:?} driver={:?} driver_info={:?}",
        info.backend, info.device_type, info.name, info.driver, info.driver_info
    )
}

fn instance() -> wgpu::Instance {
    wgpu::Instance::new(&wgpu::InstanceDescriptor::default())
}

/// Creates a headless device: the default adapter first, then a fallback
/// (software) adapter. `None` when neither yields a usable device, or when
/// `CANOPY_TERM_NO_GPU` is set.
pub fn headless_context() -> Option<GpuContext> {
    if std::env::var_os("CANOPY_TERM_NO_GPU").is_some() {
        return None;
    }
    let instance = instance();
    for force_fallback_adapter in [false, true] {
        let options = wgpu::RequestAdapterOptions {
            force_fallback_adapter,
            ..Default::default()
        };
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&options)) else {
            continue;
        };
        let info = adapter.get_info();
        let desc = wgpu::DeviceDescriptor {
            label: Some("canopy-term-render headless"),
            ..Default::default()
        };
        if let Ok((device, queue)) = pollster::block_on(adapter.request_device(&desc)) {
            return Some(GpuContext {
                device,
                queue,
                info,
            });
        }
    }
    None
}

/// What the probe found, as log lines, and whether a device can be created.
pub struct ProbeReport {
    pub lines: Vec<String>,
    pub usable: bool,
}

/// Enumerates every adapter on every backend, tries to open a device on each,
/// and also tries the default and the forced-fallback request. Never panics and
/// never fails: "no adapter" is a valid answer.
pub fn probe() -> ProbeReport {
    let mut lines = Vec::new();
    lines.push(format!(
        "compiled backends: {:?}",
        wgpu::Instance::enabled_backend_features()
    ));
    let instance = instance();
    let adapters = instance.enumerate_adapters(wgpu::Backends::all());
    lines.push(format!("enumerate_adapters: {} found", adapters.len()));
    let mut usable = false;
    for adapter in &adapters {
        let info = adapter.get_info();
        let desc = wgpu::DeviceDescriptor::default();
        let device = match pollster::block_on(adapter.request_device(&desc)) {
            Ok(_) => {
                usable = true;
                "device=ok".to_string()
            }
            Err(e) => format!("device=ERR({e})"),
        };
        lines.push(format!("  {} {}", describe(&info), device));
    }
    for force_fallback_adapter in [false, true] {
        let options = wgpu::RequestAdapterOptions {
            force_fallback_adapter,
            ..Default::default()
        };
        match pollster::block_on(instance.request_adapter(&options)) {
            Ok(a) => lines.push(format!(
                "request_adapter(force_fallback={force_fallback_adapter}): {}",
                describe(&a.get_info())
            )),
            Err(e) => lines.push(format!(
                "request_adapter(force_fallback={force_fallback_adapter}): none ({e})"
            )),
        }
    }
    ProbeReport { lines, usable }
}
