override grid_size: u32;
override particle_radius: f32;
override time_step: f32;

struct ComputeParams {
    @builtin(local_invocation_id) local_invocation_id: vec3<u32>,
    @builtin(num_workgroups) num_workgroups: vec3<u32>,
    @builtin(workgroup_id) workgroup_id: vec3<u32>
}

struct Particle {
    p: vec2<f32>,
    v: vec2<f32>,
    a: vec2<f32>
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
    gravity: f32,
    applied_force: vec2<f32>,
    mouse_pos: vec2<f32>,
    mouse_vel: vec2<f32>,
    mouse_active: u32
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> beams: array<f32>;
@group(0) @binding(2) var<storage, read> mappings: array<u32>;
@group(0) @binding(3) var<uniform> metadata: Metadata;

@compute @workgroup_size(64, 1, 1)
fn compute_main(thread: ComputeParams) {
    // Compute threads are striated across all particles - distributes particle compute load evenly
    // e.g. 10 particles, 4 threads would have thread mapping 0,1,2,3,0,1,2,3,0,1
    // Afterward, move particles that were not updated off the screen
    // Update beams last, using atomic operations to ensure no race conditions updating particles (oof)
    // Note that some beams may update before their particles due to being in different workgroups,
    // cross-workgroup synchronization doesn't exist

    let b = thread.local_invocation_id;
    let dsf = particle_radius;
    let d = thread.workgroup_id * grid_size;

    // index to search in mapping buffer sections (y/z dims not used)
    let mapping_index = (thread.workgroup_id * thread.num_workgroups + thread.local_invocation_id).x;

    // particle sim (don't simulate particles that don't exist)
    if (mapping_index <= metadata.particle_i_c) {
        var particle = particles[mappings[mapping_index]];
        // apply gravity
        particle.a.y -= metadata.gravity;
        // apply acceleration and velocity (all particles have mass 1)
        particle.p += particle.v * time_step + particle.a * time_step * time_step;
        particles[mappings[mapping_index]] = particle;
    }

    workgroupBarrier();

    // particle "delete"


    workgroupBarrier();

    // beam sim
    // use non-atomic operations to read all the particles first, then barrier, then atomic write to acceleration?
    // or just atomic everything
}