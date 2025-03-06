override grid_size: u32;
override particle_radius: f32;

struct ComputeParams {
    @builtin(local_invocation_id) local_invocation_id: vec3<u32>,
    @builtin(workgroup_id) workgroup_id: vec3<u32>,
    @builtin(local_invocation_index) local_invocation_index: u32
}

@compute @workgroup_size(1, 1, 1)
fn compute_main(thread: ComputeParams) {
    // idk
}