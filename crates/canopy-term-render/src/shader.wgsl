// One pipeline, one draw call: every instance is a textured rectangle.
// Solid rectangles sample the atlas's white block; glyph masks are white with
// coverage in alpha and are tinted by the instance colour; colour bitmaps
// (emoji) are drawn as-is. Sampling is textureLoad on integer texel
// coordinates: no filtering, so pixels land exactly where the CPU reference
// (reference.rs) says they do.

struct Globals {
    viewport: vec2<f32>,
    pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var atlas: texture_2d<f32>;

struct Instance {
    @location(0) pos: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) uv: vec4<u32>,
    @location(3) color: u32,
    @location(4) flags: u32,
};

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) src: vec2<f32>,
    @location(1) @interpolate(flat) color: vec4<f32>,
    @location(2) @interpolate(flat) flags: u32,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, inst: Instance) -> VsOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );
    let c = corners[vi];
    let px = inst.pos + c * inst.size;
    let ndc = vec2<f32>(
        px.x / globals.viewport.x * 2.0 - 1.0,
        1.0 - px.y / globals.viewport.y * 2.0,
    );
    var out: VsOut;
    out.clip = vec4<f32>(ndc, 0.0, 1.0);
    out.src = vec2<f32>(f32(inst.uv.x), f32(inst.uv.y))
        + c * vec2<f32>(f32(inst.uv.z), f32(inst.uv.w));
    out.color = vec4<f32>(
        f32(inst.color & 0xffu),
        f32((inst.color >> 8u) & 0xffu),
        f32((inst.color >> 16u) & 0xffu),
        f32((inst.color >> 24u) & 0xffu),
    ) / 255.0;
    out.flags = inst.flags;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    let t = textureLoad(atlas, vec2<i32>(floor(in.src)), 0);
    var rgb = in.color.rgb;
    if ((in.flags & 1u) != 0u) {
        rgb = t.rgb;
    }
    let a = t.a * in.color.a;
    // Premultiplied alpha output; the pipeline blends One / OneMinusSrcAlpha.
    return vec4<f32>(rgb * a, a);
}
