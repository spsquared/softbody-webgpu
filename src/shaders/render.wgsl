override grid_size: f32;
override particle_radius: f32;

const billboard_points: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 2.0),
    vec2<f32>(-sqrt(3.0), -1.0),
    vec2<f32>(sqrt(3.0), -1.0),
);

const clip_offset: vec2<f32> = vec2<f32>(- 0.5, - 0.5);
fn to_clip_space(pos: vec2<f32>) -> vec4<f32> {
    return vec4<f32>(pos / grid_size, 0.0, 1.0);
}

struct Particle {
    @location(0) position: vec2<f32>
}

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

@vertex
fn vertex_particle_main(vertex: ParticleVertexIn) -> ParticleVertexOut {
    var out: ParticleVertexOut;
    out.clip_position = to_clip_space(vertex.position + billboard_points[vertex.vertex_index] * particle_radius);
    return out;
}

@fragment
fn fragment_particle_main(frag: ParticleFragIn) -> @location(0) vec4<f32> {
    let thing = particle_radius;
    // return vec4<f32>(frag.clip_position);
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}

@group(0) @binding(1)
var<storage, read> particles: array<Particle>;

struct BeamVertexIn {
    @builtin(vertex_index) vertex_index: u32,
    @location(0) particle_pair: vec2<u32>,
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
    let b = grid_size;
    // if (vertex.vertex_index == 1u) {
    //     out.clip_position = to_clip_space(particles[vertex.particle_pair.x].position);
    // }
    // else {
    //     out.clip_position = to_clip_space(particles[vertex.particle_pair.y].position);
    // }
    // out.clip_position = vec4<f32>(f32(vertex.vertex_index), f32(vertex.vertex_index * vertex.vertex_index), 10.0, 10.0);
    return out;
}

@fragment
fn fragment_beam_main(frag: BeamFragIn) -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}