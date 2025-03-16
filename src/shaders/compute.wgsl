override grid_size: u32;
override particle_radius: f32;

struct ComputeParams {
    @builtin(local_invocation_id) local_invocation_id: vec3<u32>,
    @builtin(workgroup_id) workgroup_id: vec3<u32>
}

struct Particle {
    p: vec2<f32>,
    v: vec2<f32>,
    a: vec2<f32>
}

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<storage, read_write> beams: array<f32>;
@group(0) @binding(2) var<storage, read> mappings: array<u32>;

@compute @workgroup_size(64, 1, 1)
fn compute_main(thread: ComputeParams) {
    // Compute threads are striated across all particles - distributes particle compute load evenly
    // e.g. 10 particles, 4 threads would have thread mapping 0,1,2,3,0,1,2,3,0,1
    // wait how to move particle to way off the screen if no particle simulating?
    // oh wait just use thread sync locks, create storage array (not bound) for storing what was updated
    // then after running updates using mapping buffer, run another test on particle buffer to "delete" un-updated parts
    // using the same ordering system
    let thing = grid_size;
    let other_thing = particle_radius;
}