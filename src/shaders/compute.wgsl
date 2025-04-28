override grid_size: f32;
override particle_radius: f32;
override time_step: f32;

override border_elasticity: f32;
override border_friction: f32;
override elasticity: f32;
override friction: f32;

@must_use
fn cross2(u: vec2<f32>, v: vec2<f32>) -> f32 {
    return u.x * v.y - u.y * v.x;
}

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

// super memory efficient very much yes
@group(0) @binding(4)
var<storage, read_write> beam_forces: array<atomic<i32>>;
const beam_force_scale: f32 = 65536;

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
        var diff = particle_b.p - particle_a.p;
        if (length(diff) == 0) {
            // prevent divide by 0 in normalize
            diff = vec2<f32>(0.0, - 1.0e-10);
        }
        let len = length(diff);
        // (ideal - current) * spring + (last - current) * damp
        let force = ((beam.target_length - len) * beam.spring + (beam.last_length - len) * beam.damp) * normalize(diff);
        beam.last_length = len;
        beams[index] = beam;
        // atomics to add forces
        atomicAdd(&beam_forces[index_a * 2], i32(- force.x * beam_force_scale));
        atomicAdd(&beam_forces[index_a * 2 + 1], i32(- force.y * beam_force_scale));
        atomicAdd(&beam_forces[index_b * 2], i32(force.x * beam_force_scale));
        atomicAdd(&beam_forces[index_b * 2 + 1], i32(force.y * beam_force_scale));
    }

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
        // collide with other particles (naive solution)
        let elasticity_coeff = (elasticity + 1) / 2;
        for (var o_map_index: u32 = 0; o_map_index < metadata.particle_i_c; o_map_index++) {
            if (o_map_index == mapping_index) {
                continue;
            }
            var other = particles[getMappedIndex(o_map_index)];
            let dist = distance(other.p, particle.p);
            if (dist <= particle_radius && dist > 0) {
                let norm = normalize(other.p - particle.p);
                let impulse = elasticity_coeff * dot(particle.v - other.v, norm);
                particle.v -= impulse * norm;
            }
        }
        // apply acceleration and velocity
        let beam_force_index = index * 2;
        particle.a.x += f32(atomicExchange(&beam_forces[beam_force_index], 0)) / beam_force_scale;
        particle.a.y += f32(atomicExchange(&beam_forces[beam_force_index + 1], 0)) / beam_force_scale;
        particle.v += particle.a * time_step;
        particle.p += particle.v * time_step;
        particle.a = vec2<f32>(0.0, 0.0);
        particles[index] = particle;
    }
    // delete particles
}