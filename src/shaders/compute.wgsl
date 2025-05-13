override grid_size: f32;
override particle_radius: f32;
override time_step: f32;

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
    // 2 bytes pad due to vec2 alignment
    gravity: vec2<f32>,
    border_elasticity: f32,
    border_friction: f32,
    elasticity: f32,
    friction: f32,
    drag_coeff: f32,
    drag_exp: f32,
    user_strength: f32,
    mouse_active: u32,
    mouse_pos: vec2<f32>,
    mouse_vel: vec2<f32>,
    applied_force: vec2<f32>
}

@group(0) @binding(0)
var<storage, read_write> metadata: Metadata;
@group(0) @binding(1)
var<storage, read> particles_read: array<Particle>;
@group(0) @binding(2)
var<storage, read_write> particles_write: array<Particle>;
@group(0) @binding(3)
var<storage, read_write> beams: array<Beam>;
@group(0) @binding(4)
var<storage, read_write> mappings: array<u32>;

// super memory efficient very much yes
@group(0) @binding(5)
var<storage, read_write> particle_forces: array<atomic<i32>>;
const particle_force_scale: f32 = 65536;

// once again wgpu not having u16 is annoying
@must_use
fn getMappedIndex(id: u32) -> u32 {
    return extractBits(mappings[id / 2], (id % 2) * 16, 16);
}

@compute @workgroup_size(64, 1, 1)
fn compute_main(thread: ComputeParams) {
    // beam sim (inversion may help speed up simulation by spreading beams/particles across more threads)
    let beam_mapping_index = metadata.max_particles - thread.global_invocation_id.x - 1;
    if (beam_mapping_index < metadata.beam_i_c) {
        let index = getMappedIndex(metadata.max_particles + beam_mapping_index);
        var beam = beams[index];
        let index_a = extractBits(beam.particle_pair, 0, 16);
        let index_b = extractBits(beam.particle_pair, 16, 16);
        var particle_a = particles_read[index_a];
        var particle_b = particles_read[index_b];
        var diff = particle_b.p - particle_a.p;
        if (length(diff) == 0) {
            // prevent divide by 0 in normalize
            diff = vec2<f32>(0.0, - 1.0e-10);
        }
        let len = length(diff);
        // (ideal - current) * spring + (last - current) * damp
        let force_mag = ((beam.target_length - len) * beam.spring + (beam.last_length - len) * beam.damp);
        let force = force_mag * normalize(diff);
        beam.last_length = len;
        // TODO - add yield strength
        // if a force is too strong the beam begins to behave plastically - its target length will change
        // if the target length changes too much from its original length it will break
        beams[index] = beam;
        // atomics to add forces
        atomicAdd(&particle_forces[index_a * 2], i32(- force.x * particle_force_scale));
        atomicAdd(&particle_forces[index_a * 2 + 1], i32(- force.y * particle_force_scale));
        atomicAdd(&particle_forces[index_b * 2], i32(force.x * particle_force_scale));
        atomicAdd(&particle_forces[index_b * 2 + 1], i32(force.y * particle_force_scale));
    }

    // particle sim
    let particle_mapping_index = thread.global_invocation_id.x;
    if (particle_mapping_index < metadata.particle_i_c) {
        let index = getMappedIndex(particle_mapping_index);
        // particles read from one buffer and write to the other buffer (buffers alternate in workgroup dispatches)
        // prevents collision asymmetry where particle A calculates a force, moves, then particle B calculates a different force
        var particle = particles_read[index];
        // const copy of particle to prevent collisions from affecting subsequent collisions and borking physics
        let const_particle = particle;
        // collide with other particles (naive solution)
        let elasticity_coeff = (metadata.elasticity + 1) / 2;
        for (var o_map_index: u32 = 0; o_map_index < metadata.particle_i_c; o_map_index++) {
            if (o_map_index == particle_mapping_index) {
                continue;
            }
            let other_index = getMappedIndex(o_map_index);
            let other = particles_read[other_index];
            let dist = length(other.p - const_particle.p);
            if (dist < particle_radius * 2 && dist > 0) {
                let normal = normalize(other.p - const_particle.p);
                let tangent = vec2<f32>(- normal.y, normal.x);
                let inv_rel_velocity = const_particle.v - other.v;
                let impulse_normal = elasticity_coeff * dot(inv_rel_velocity, normal);
                let max_friction = impulse_normal * metadata.friction;
                let impulse_tangent = clamp(dot(inv_rel_velocity, tangent), - max_friction, max_friction);
                particle.v -= impulse_normal * normal + impulse_tangent * tangent;
                // offset thing from verlet integration style collisions
                let clip_shift = normal * (particle_radius * 2 - dist) / 2;
                // unfortunately these "static" forces can't be added to acceleration due to floating-point causing instability
                particle.p -= clip_shift;
                // particle.v -= clip_shift / time_step;
                // particle.a -= clip_shift / time_step / time_step;
            }
        }
        // gravity
        particle.a += metadata.gravity;
        // drag
        if (length(particle.v) > 0) {
            // particle.p.y += metadata.drag_exp * time_step;
            particle.a -= metadata.drag_coeff * pow(abs(particle.v), vec2<f32>(metadata.drag_exp, metadata.drag_exp)) * normalize(particle.v);
        }
        // user input forces
        particle.a += metadata.applied_force * metadata.user_strength;
        if (metadata.mouse_active > 0 && distance(metadata.mouse_pos, particle.p) < particle_radius * 10) {
            particle.a += (metadata.mouse_vel - particle.v) * metadata.user_strength - metadata.gravity;
        }
        // apply acceleration and velocity
        let beam_force_index = index * 2;
        particle.a.x += f32(atomicExchange(&particle_forces[beam_force_index], 0)) / particle_force_scale;
        particle.a.y += f32(atomicExchange(&particle_forces[beam_force_index + 1], 0)) / particle_force_scale;
        particle.v += particle.a * time_step;
        particle.p += particle.v * time_step;
        particle.a = vec2<f32>(0.0, 0.0);
        // border collisions (very simple)
        let clamped_pos = clamp(particle.p, vec2<f32>(particle_radius, particle_radius), vec2<f32>(f32(grid_size) - particle_radius, f32(grid_size) - particle_radius));
        if (particle.p.x != clamped_pos.x) {
            particle.a.y -= min(particle.a.y, sign(particle.v.y) * metadata.border_friction * abs(particle.v.x) * (1 + metadata.border_elasticity));
            particle.v.x *= - metadata.border_elasticity;
        }
        if (particle.p.y != clamped_pos.y) {
            particle.a.x -= min(particle.a.x, sign(particle.v.x) * metadata.border_friction * abs(particle.v.y) * (1 + metadata.border_elasticity));
            particle.v.y *= - metadata.border_elasticity;
        }
        particle.p = clamped_pos;
        // write
        particles_write[index] = particle;
    }
    // delete particles
}