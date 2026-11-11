//! The wgpu renderer: draws a `QuadBuilder`'s instance buffer in one draw call
//! into any texture view, and uploads only what changed (rebuilt rows'
//! instances, new atlas rectangles). It owns no window.
//!
//! Window integration point (not in this crate yet): a `winit` window owns a
//! `wgpu::Surface`; on `RedrawRequested` the app calls
//! `QuadBuilder::build` -> `Renderer::sync` -> `Renderer::render` with the
//! surface texture's view, then presents. See DESIGN.md for frame pacing
//! (present on damage only).

use std::hash::Hash;

use crate::atlas::Atlas;
use crate::builder::{BuildReport, QuadBuilder};
use crate::color::Rgb;
use crate::instance::Instance;

/// The WGSL source, also validated on machines with no GPU by a unit test.
pub const SHADER_SOURCE: &str = include_str!("shader.wgsl");

const INSTANCE_ATTRIBUTES: [wgpu::VertexAttribute; 5] = wgpu::vertex_attr_array![
    0 => Float32x2,
    1 => Float32x2,
    2 => Uint16x4,
    3 => Uint32,
    4 => Uint32,
];

/// Bytes written to the GPU by one `sync`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UploadStats {
    pub instance_bytes: usize,
    pub atlas_bytes: usize,
    /// The instance buffer was recreated (the grid grew).
    pub reallocated: bool,
}

/// Draws the builder's instance buffer in one draw call. Holds no window: it
/// renders to any `TextureView` of the format it was created with.
pub struct Renderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    atlas_texture: wgpu::Texture,
    atlas_width: u32,
    instance_buffer: wgpu::Buffer,
    instance_capacity: usize,
    /// The first `sync` uploads the whole atlas: a renderer created after glyphs
    /// were packed has not seen the earlier dirty rectangles.
    atlas_primed: bool,
}

impl Renderer {
    /// `format` should be a non-sRGB format (e.g. `Rgba8Unorm`): the shader
    /// writes the theme's sRGB-encoded bytes as they are.
    pub fn new(
        device: wgpu::Device,
        queue: wgpu::Queue,
        format: wgpu::TextureFormat,
        atlas_size: (u32, u32),
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("term shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SOURCE.into()),
        });
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("term bind group layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("term pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let premultiplied = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        };
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("term pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Instance>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &INSTANCE_ATTRIBUTES,
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState {
                        color: premultiplied,
                        alpha: premultiplied,
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("term globals"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let atlas_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("term atlas"),
            size: wgpu::Extent3d {
                width: atlas_size.0,
                height: atlas_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let atlas_view = atlas_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("term bind group"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&atlas_view),
                },
            ],
        });
        let instance_buffer = make_instance_buffer(&device, 1);
        Renderer {
            device,
            queue,
            pipeline,
            bind_group,
            uniform,
            atlas_texture,
            atlas_width: atlas_size.0,
            instance_buffer,
            instance_capacity: 1,
            atlas_primed: false,
        }
    }

    /// Sends what changed to the GPU: the rebuilt rows' instances and only the
    /// atlas rectangles written since the last call. The instance buffer is
    /// recreated (and fully rewritten) only when the grid grew.
    pub fn sync<K: Hash + Eq + Copy>(
        &mut self,
        builder: &QuadBuilder,
        report: &BuildReport,
        atlas: &mut Atlas<K>,
    ) -> UploadStats {
        let mut stats = UploadStats::default();
        let instances = builder.instances();
        let item = std::mem::size_of::<Instance>();
        if instances.len() > self.instance_capacity {
            self.instance_buffer = make_instance_buffer(&self.device, instances.len());
            self.instance_capacity = instances.len();
            self.queue
                .write_buffer(&self.instance_buffer, 0, bytemuck::cast_slice(instances));
            stats.instance_bytes = instances.len() * item;
            stats.reallocated = true;
        } else {
            for r in &report.uploads {
                self.queue.write_buffer(
                    &self.instance_buffer,
                    (r.start * item) as u64,
                    bytemuck::cast_slice(&instances[r.start..r.start + r.len]),
                );
                stats.instance_bytes += r.len * item;
            }
        }

        let (aw, _) = atlas.size();
        debug_assert_eq!(aw as u32, self.atlas_width);
        let mut dirty = atlas.take_dirty();
        if !self.atlas_primed {
            let (_, ah) = atlas.size();
            dirty = vec![crate::atlas::Rect {
                x: 0,
                y: 0,
                w: aw,
                h: ah,
            }];
            self.atlas_primed = true;
        }
        let pixels = atlas.pixels();
        for r in &dirty {
            let offset = (r.y as usize * aw as usize + r.x as usize) * 4;
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.atlas_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: r.x as u32,
                        y: r.y as u32,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &pixels[offset..],
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(aw as u32 * 4),
                    rows_per_image: None,
                },
                wgpu::Extent3d {
                    width: r.w as u32,
                    height: r.h as u32,
                    depth_or_array_layers: 1,
                },
            );
            stats.atlas_bytes += r.w as usize * r.h as usize * 4;
        }
        stats
    }

    /// Clears `target` to `clear` and draws every instance with one draw call.
    pub fn render(
        &self,
        target: &wgpu::TextureView,
        viewport: (u32, u32),
        clear: Rgb,
        instance_count: u32,
    ) {
        let globals = [viewport.0 as f32, viewport.1 as f32, 0.0f32, 0.0f32];
        self.queue
            .write_buffer(&self.uniform, 0, bytemuck::cast_slice(&globals));
        let c = |v: u8| v as f64 / 255.0;
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("term frame"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("term pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: c(clear[0]),
                            g: c(clear[1]),
                            b: c(clear[2]),
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.set_vertex_buffer(0, self.instance_buffer.slice(..));
            pass.draw(0..6, 0..instance_count.min(self.instance_capacity as u32));
        }
        self.queue.submit([encoder.finish()]);
    }
}

fn make_instance_buffer(device: &wgpu::Device, instances: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("term instances"),
        size: (instances.max(1) * std::mem::size_of::<Instance>()) as u64,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

/// An offscreen RGBA8 render target that can be read back.
pub struct Offscreen {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
}

pub const OFFSCREEN_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

impl Offscreen {
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("term offscreen"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: OFFSCREEN_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Offscreen {
            texture,
            view,
            width,
            height,
        }
    }

    /// Copies the target to the CPU as tightly packed RGBA8 (the GPU's 256-byte
    /// row padding is removed).
    pub fn read_rgba(&self, device: &wgpu::Device, queue: &wgpu::Queue) -> Vec<u8> {
        let unpadded = self.width * 4;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded = unpadded.div_ceil(align) * align;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("term readback"),
            size: (padded * self.height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("term readback"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        let _ = device.poll(wgpu::PollType::Wait);
        rx.recv().expect("map callback ran").expect("map succeeded");
        let data = slice.get_mapped_range();
        let mut out = Vec::with_capacity((unpadded * self.height) as usize);
        for row in 0..self.height as usize {
            let start = row * padded as usize;
            out.extend_from_slice(&data[start..start + unpadded as usize]);
        }
        drop(data);
        buffer.unmap();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shader_parses_and_validates_without_a_gpu() {
        let module = naga::front::wgsl::parse_str(SHADER_SOURCE).expect("WGSL parses");
        let mut validator = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        );
        validator.validate(&module).expect("WGSL validates");
        let entries: Vec<&str> = module
            .entry_points
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(entries, vec!["vs_main", "fs_main"]);
    }

    #[test]
    fn instance_stride_matches_the_vertex_attributes() {
        assert_eq!(INSTANCE_ATTRIBUTES[2].offset, 16);
        assert_eq!(INSTANCE_ATTRIBUTES[3].offset, 24);
        assert_eq!(
            INSTANCE_ATTRIBUTES[4].offset + 4,
            std::mem::size_of::<Instance>() as u64
        );
    }
}
