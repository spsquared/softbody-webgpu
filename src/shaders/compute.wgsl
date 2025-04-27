override grid_size: u32;
override particle_radius: f32;
override time_step: f32;

override border_elasticity: f32;
override border_friction: f32;

struct ComputeParams {
    @builtin(global_invocation_id) global_invocation_id: vec3<u32>
}

struct Particle {
    p: vec2<f32>,
    v: vec2<f32>,
    a: vec2<f32>
}

struct Beam {
    particle_pair: u32,
    target_length: f32,
    last_length: f32,
    spring: f32,
    damp: f32
}

struct Metadata {
    particle_v_c: u32,
    particle_i_c: u32,
    particle_f_v: u32,
    particle_b_v: u32,
    particle_f_i: u32,
    beam_v_c: u32,
    beam_i_c: u32,
    beam_f_v: u32,
    beam_b_v: u32,
    beam_f_i: u32,
    max_particles: u32,
    gravity: f32,
    applied_force: vec2<f32>,
    mouse_pos: vec2<f32>,
    mouse_vel: vec2<f32>,
    mouse_active: u32
}

@group(0) @binding(0)
var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1)
var<storage, read_write> beams: array<Beam>;
@group(0) @binding(2)
var<storage, read> mappings: array<u32>;
@group(0) @binding(3)
var<uniform> metadata: Metadata;

// once again wgpu not having u16 is annoying
@must_use
fn getMappedIndex(id: u32) -> u32 {
    return extractBits(mappings[id / 2], ((id + 1) % 2) * 16, 16);
}

@compute @workgroup_size(64, 1, 1)
fn compute_main(thread: ComputeParams) {
    // index to search in mapping buffer sections (y/z dims not used)
    let mapping_index = thread.global_invocation_id.x;

    // beam sim
    if (mapping_index < metadata.beam_i_c) {
        let index = getMappedIndex(metadata.max_particles + mapping_index);
        var beam = beams[index];
        let index_a = extractBits(beam.particle_pair, 0, 16);
        let index_b = extractBits(beam.particle_pair, 16, 16);
        var particle_a = particles[index_a];
        var particle_b = particles[index_b];
        let diff = particle_b.p - particle_a.p - vec2<f32>(0.0, 1e-10); // prevent divide by 0 in normalize
        let len = length(diff);
        // (ideal - current) * spring + (last - current) * damp
        let force = ((beam.target_length - len) * beam.damp + (beam.last_length - len) * beam.spring) * normalize(diff);
        beam.last_length = len;
        beams[index] = beam;
        // oh no
        particles[index_a].a -= force;
        particles[index_b].a += force;
    }

    workgroupBarrier();

    // particle sim
    if (mapping_index < metadata.particle_i_c) {
        let index = getMappedIndex(mapping_index);
        var particle = particles[index];
        // apply gravity
        particle.a.y -= metadata.gravity;
        // border collisions (very simple)
        let clamped_pos = clamp(particle.p, vec2<f32>(particle_radius, particle_radius), vec2<f32>(f32(grid_size) - particle_radius, f32(grid_size) - particle_radius));
        if (particle.p.x != clamped_pos.x) {
            particle.a.y -= sign(particle.v.y) * border_friction * abs(particle.v.x) * (1 + border_elasticity);
            particle.v.x *= - border_elasticity;
        }
        if (particle.p.y != clamped_pos.y) {
            particle.a.x -= sign(particle.v.x) * border_friction * abs(particle.v.y) * (1 + border_elasticity);
            particle.v.y *= - border_elasticity;
        }
        particle.p = clamped_pos;
        // collide with other particles
        // apply acceleration and velocity (all particles have mass 1)
        particle.v += particle.a * time_step;
        particle.p += particle.v * time_step;
        particle.a = vec2<f32>(0.0, 0.0);
        particles[index] = particle;
    }

    workgroupBarrier();

    // particle "delete"

}