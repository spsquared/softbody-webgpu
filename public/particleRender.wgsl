override grid_size: u32;
override particle_radius: f32;

const billboard_points: array<vec2<f32>, 4> = array<vec2<f32>, 4>(vec2<f32>(- 1.0, - 1.0), vec2<f32>(1.0, - 1.0), vec2<f32>(- 1.0, 1.0), vec2<f32>(1.0, 1.0));

struct Particle {
    @location(0) position: vec2<f32>
}

@group(0) @binding(0)
var<storage, read> particles: array<Particle>;

struct ParticleVertexIn {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) position: vec2<f32>
}

struct ParticleVertexOut {
    @builtin(position) clip_position: vec4<f32>
}

struct ParticleFragIn {
    @builtin(position) clip_position: vec4<f32>
}

const clip_offset: vec2<f32> = vec2<f32>(- 0.5, - 0.5);
fn to_clip_space(pos: vec2<f32>) -> vec4<f32> {
    return vec4<f32>(pos.xy / f32(grid_size) - clip_offset, 0.0, 1.0);
}

@vertex
fn vertex_particle_main(vertex: ParticleVertexIn) -> ParticleVertexOut {
    var out: ParticleVertexOut;
    out.clip_position = to_clip_space(vertex.position + billboard_points[vertex.vertex_index]);
    return out;
}

@fragment
fn frag_particle_main(frag: ParticleFragIn) -> @location(0) vec4<f32> {
    return vec4<f32>(frag.clip_position);
}

struct BeamVertexIn {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) particle_A: u32,
    @location(1) particle_B: u32
}

struct BeamVertexOut {
    @builtin(position) clip_position: vec4<f32>
}

struct BeamFragIn {
    @builtin(position) clip_position: vec4<f32>
}

@vertex
fn vertex_beam_main(vertex: BeamVertexIn) -> BeamVertexOut {
    var out: BeamVertexOut;
    if (vertex.vertex_index == 1u) {
        out.clip_position = to_clip_space(particles[vertex.particle_B].position);
    } else {
        out.clip_position = to_clip_space(particles[vertex.particle_A].position);
    }
    return out;
}

@fragment
fn frag_beam_main(frag: BeamFragIn) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}