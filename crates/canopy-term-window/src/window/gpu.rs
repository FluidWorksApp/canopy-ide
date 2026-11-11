//! The window's wgpu surface: device, format choice, configure on resize.

use std::sync::Arc;

use winit::window::Window;

/// Picks the surface format and the view format the renderer draws through.
/// The renderer wants a non-sRGB target (it writes the theme's sRGB bytes as
/// they are), so an 8-bit UNORM format is preferred; a surface that only offers
/// sRGB gets a non-sRGB view of it.
pub fn choose_format(
    formats: &[wgpu::TextureFormat],
) -> Option<(wgpu::TextureFormat, wgpu::TextureFormat)> {
    use wgpu::TextureFormat as F;
    if let Some(f) = formats
        .iter()
        .copied()
        .find(|f| matches!(f, F::Bgra8Unorm | F::Rgba8Unorm))
    {
        return Some((f, f));
    }
    let f = *formats.first()?;
    Some((f, f.remove_srgb_suffix()))
}

pub struct SurfaceState {
    pub surface: wgpu::Surface<'static>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub config: wgpu::SurfaceConfiguration,
    /// The format the renderer's pipeline targets.
    pub view_format: wgpu::TextureFormat,
    configured: bool,
}

impl SurfaceState {
    pub fn new(window: Arc<Window>, width: u32, height: u32) -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let surface = instance
            .create_surface(window)
            .map_err(|e| format!("create surface: {e}"))?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            ..Default::default()
        }))
        .map_err(|e| format!("no GPU adapter for this window: {e}"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("canopy-term-window"),
            ..Default::default()
        }))
        .map_err(|e| format!("request device: {e}"))?;
        let caps = surface.get_capabilities(&adapter);
        let (format, view_format) =
            choose_format(&caps.formats).ok_or("the surface supports no formats")?;
        let alpha_mode = caps
            .alpha_modes
            .first()
            .copied()
            .unwrap_or(wgpu::CompositeAlphaMode::Auto);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            // Vsync: a burst of output cannot spin the GPU.
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: if view_format != format {
                vec![view_format]
            } else {
                Vec::new()
            },
        };
        let mut state = SurfaceState {
            surface,
            device,
            queue,
            config,
            view_format,
            configured: false,
        };
        state.resize(width, height);
        Ok(state)
    }

    /// A zero size (minimised on Windows) leaves the surface unconfigured and
    /// nothing is drawn until it has a size again.
    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            self.configured = false;
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.configured = true;
    }

    pub fn configured(&self) -> bool {
        self.configured
    }

    /// After `Lost` or `Outdated`.
    pub fn reconfigure(&mut self) {
        if self.configured {
            self.surface.configure(&self.device, &self.config);
        }
    }

    pub fn size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::TextureFormat as F;

    #[test]
    fn a_unorm_format_is_preferred_and_srgb_only_surfaces_get_a_unorm_view() {
        assert_eq!(
            choose_format(&[F::Bgra8UnormSrgb, F::Bgra8Unorm]),
            Some((F::Bgra8Unorm, F::Bgra8Unorm))
        );
        assert_eq!(
            choose_format(&[F::Bgra8UnormSrgb]),
            Some((F::Bgra8UnormSrgb, F::Bgra8Unorm))
        );
        assert_eq!(
            choose_format(&[F::Rgba16Float]),
            Some((F::Rgba16Float, F::Rgba16Float))
        );
        assert_eq!(choose_format(&[]), None);
    }
}
