override grid_size: f32;
override particle_radius: f32;

const billboard_points: array<vec2<f32>, 3> = array<vec2<f32>, 3>(vec2<f32>(0.0, 2.0), vec2<f32>(- sqrt(3.0), - 1.0), vec2<f32>(sqrt(3.0), - 1.0),);

const clip_offset: vec2<f32> = vec2<f32>(- 1.0, - 1.0);
fn to_clip_space(pos: vec2<f32>) -> vec4<f32> {
    return vec4<f32>(2 * pos / grid_size + clip_offset, 0.0, 1.0);
}

struct Particle {
    p: vec2<f32>,
    v: vec2<f32>,
    a: vec2<f32>
}

struct ParticleVertexIn {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) position: vec2<f32>
}

struct ParticleVertexOut {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) position: vec2<f32>,
    @location(1) center: vec2<f32>
}

struct ParticleFragIn {
    @location(0) position: vec2<f32>,
    @location(1) center: vec2<f32>
}

@vertex
fn vertex_particle_main(vertex: ParticleVertexIn) -> ParticleVertexOut {
    var out: ParticleVertexOut;
    out.center = vertex.position;
    out.position = vertex.position + billboard_points[vertex.vertex_index] * particle_radius;
    out.clip_position = to_clip_space(out.position);
    return out;
}

const particle_color: vec4<f32> = vec4<f32>(0.0, 0.7, 1.0, 1.0) * 0.3;
const particle_outline: vec4<f32> = vec4<f32>(1.0, 1.0, 1.0, 1.0) * 1.0;
@fragment
fn fragment_particle_main(frag: ParticleFragIn) -> @location(0) vec4<f32> {
    if (distance(frag.position, frag.center) < particle_radius * 0.8) {
        return particle_color;
    }
    if (distance(frag.position, frag.center) < particle_radius) {
        return particle_outline;
    }
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

@group(0) @binding(1)
var<storage, read> particles: array<Particle>;

struct BeamVertexIn {
    @builtin(vertex_index) vertex_index: u32,
    // @location(0) particle_a: u32,
    // @location(1) particle_b: u32
    @location(0) particle_pair: u32,
    @location(1) target_length: f32
}

struct BeamVertexOut {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) stress_color: vec4<f32>
}

struct BeamFragIn {
    @location(0) stress_color: vec4<f32>
}

@vertex
fn vertex_beam_main(vertex: BeamVertexIn) -> BeamVertexOut {
    var out: BeamVertexOut;
    let b = grid_size;
    // pair is two u16, but wgsl doesn't have u16 type
    out.clip_position = to_clip_space(particles[extractBits(vertex.particle_pair, vertex.vertex_index * 16, 16)].p);
    out.stress_color = vec4<f32>(1.0, 1.0, 1.0, 1.0);
    return out;
}

@fragment
fn fragment_beam_main(frag: BeamFragIn) -> @location(0) vec4<f32> {
    return frag.stress_color;
}