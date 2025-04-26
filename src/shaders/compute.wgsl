override grid_size: u32;
override particle_radius: f32;
override time_step: f32;

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

@compute @workgroup_size(64, 1, 1)
fn compute_main(thread: ComputeParams) {
    let dsf = particle_radius;
    let d = grid_size;

    // index to search in mapping buffer sections (y/z dims not used)
    let mapping_index = thread.global_invocation_id.x;

    // beam sim
    if (mapping_index <= metadata.beam_i_c) {
        var beam = beams[mappings[metadata.max_particles + mapping_index]];
        // read particles normally
        let index_a = extractBits(beam.particle_pair, 0, 16);
        let index_b = extractBits(beam.particle_pair, 16, 16);
        var particle_a = particles[index_a];
        var particle_b = particles[index_b];
        let dir = particle_b.p - particle_a.p;
        beam.last_length = length(dir);
        beams[mappings[metadata.max_particles + mapping_index]] = beam;
        // atomically write particles
    }

    workgroupBarrier();

    // particle sim (don't simulate particles that don't exist)
    if (mapping_index <= metadata.particle_i_c) {
        var particle = particles[mappings[mapping_index]];
        // apply gravity
        particle.a.y -= metadata.gravity;
        // apply acceleration and velocity (all particles have mass 1)
        particle.v += particle.a * time_step;
        particle.p += particle.v * time_step;
        particle.a = vec2<f32>(0.0, 0.0);
        particles[mappings[mapping_index]] = particle;
    }

    workgroupBarrier();

    // particle "delete"

}