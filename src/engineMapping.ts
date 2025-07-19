/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

import { WGPUSoftbodyEnginePhysicsConstants } from "./engine";

type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

/**
 * Defines buffer structs for placing vectors into GPU buffers.
 */
export class Vector2D {
    readonly x: number;
    readonly y: number;
    readonly magnitude: number;

    constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
        this.magnitude = Math.sqrt(this.x ** 2 + this.y ** 2);
    }

    translate(x: number, y: number): Vector2D {
        return new Vector2D(this.x + x, this.y + y);
    }
    mult(s: number): Vector2D {
        return new Vector2D(this.x * s, this.y * s);
    }
    norm(): Vector2D {
        return this.mult(1 / this.magnitude);
    }
    negate(): Vector2D {
        return new Vector2D(-this.x, -this.y);
    }
    add(o: Vector2D): Vector2D {
        return new Vector2D(this.x + o.x, this.y + o.y);
    }
    sub(o: Vector2D): Vector2D {
        return this.add(o.negate());
    }
    dot(o: Vector2D): number {
        return this.x * o.x + this.y * o.y;
    }
    cross(o: Vector2D): number {
        return this.x * o.y - this.y * o.x;
    }

    static min(u: Vector2D, v: Vector2D): Vector2D {
        return new Vector2D(Math.min(u.x, v.x), Math.min(u.y, v.y));
    }
    static max(u: Vector2D, v: Vector2D): Vector2D {
        return new Vector2D(Math.max(u.x, v.x), Math.max(u.y, v.y));
    }
    static clamp(vec: Vector2D, min: Vector2D, max: Vector2D): Vector2D {
        return new Vector2D(Math.max(min.x, Math.min(vec.x, max.x)), Math.max(min.y, Math.min(vec.y, max.y)));
    }

    /**
     * Determines the turn direction from line segment PQ to point R. `0` Indicates
     * P, Q, and R are colinear, `1` indicates a right turn, and `-1` indicates a left turn.
     * ```
     * |  1   1   1  |
     * | P.x R.x Q.x |
     * | P.y R.y Q.y |
     * ```
     * Where `R` is this vector
     */
    static turnDirection(p: Vector2D, q: Vector2D, r: Vector2D): number {
        return Math.sign(p.x * (r.y - q.y) + r.x * (q.y - p.y) + q.x * (p.y - r.y));
    }

    toString(): string {
        return `Vector2D<${this.x}, ${this.y}>`;
    }

    static readonly zero: Vector2D = new Vector2D(0, 0);
    static readonly i: Vector2D = new Vector2D(1, 0);
    static readonly j: Vector2D = new Vector2D(0, 1);

    to(buffer: TypedArray, offset: number): void {
        buffer[offset] = this.x;
        buffer[offset + 1] = this.y;
    }

    static from(buffer: TypedArray, offset: number): Vector2D {
        return new Vector2D(buffer[offset], buffer[offset + 1]);
    }

    toObject(): { x: number, y: number } {
        return { x: this.x, y: this.y };
    }
    static fromObject(obj: { x: number, y: number }): Vector2D {
        return new Vector2D(obj.x, obj.y);
    }
}

/**
 * Defines buffer structs for placing particle data into GPU buffers.
 */
export class Particle {
    /**
     * Buffer stride in bytes.
     * - Position: `vec2<f32>`
     * - Velocity: `vec2<f32>`
     * - Acceleration: `vec2<f32>`
     */
    static readonly stride = 24;

    /**IDs are transient and will be reassigned on write to buffer */
    readonly id: number;
    position: Vector2D;
    velocity: Vector2D;
    acceleration: Vector2D;

    constructor(id: number, position?: Vector2D, velocity?: Vector2D, acceleration?: Vector2D) {
        this.id = id;
        this.position = position ?? Vector2D.zero;
        this.velocity = velocity ?? Vector2D.zero;
        this.acceleration = acceleration ?? Vector2D.zero;
    }

    to(pBuf: ArrayBuffer, mBuf: Uint16Array, index: number): void {
        mBuf[this.id] = index;
        const f32View = new Float32Array(pBuf, index * Particle.stride, Particle.stride / Float32Array.BYTES_PER_ELEMENT);
        this.position.to(f32View, 0);
        this.velocity.to(f32View, 2);
        this.acceleration.to(f32View, 4);
    }

    static from(pBuf: ArrayBuffer, mBuf: Uint16Array, id: number): Particle {
        const index = mBuf[id];
        const f32View = new Float32Array(pBuf, index * Particle.stride, Particle.stride / Float32Array.BYTES_PER_ELEMENT);
        return new Particle(id, Vector2D.from(f32View, 0), Vector2D.from(f32View, 2), Vector2D.from(f32View, 4));
    }
}

/**
 * Defines buffer structs for placing particle data into GPU buffers.
 */
export class Beam {
    /**
     * Buffer stride in bytes. (note particles are IDs in JS, but indices in buffers)
     * - Particle A index: `uint16`
     * - Particle B index: `uint16`
     * - Length: `f32`
     * - Target length: `f32`
     * - Last length: `f32`
     * - Spring constant: `f32`
     * - Damping constant: `f32`
     * - Yield stress: `f32`
     * - Strain break limit: `f32`
     * - Most recent strain: `f32`
     * - Most recent stress: `f32`
     */
    static readonly stride = 40;

    /**IDs are transient and will be reassigned on write to buffer */
    readonly id: number;
    readonly a: number | Particle;
    readonly b: number | Particle;
    length: number; // original length of beam
    targetLen: number; // target length of beam, affected by plastic deformation
    lastLen: number; // actual length in previous tick
    spring: number; // spring constant (elastic deformation, stress from strain from target length)
    damp: number; // damping constant (energy loss from strain, stress from change in actual length)
    yieldStrain: number; // maximum strain (proportion of original length) before plastic deformation occurs
    strainLimit: number; // maximum strain (proportion of original length) before beam completely breaks

    constructor(id: number, a: number | Particle, b: number | Particle, length: number, spring: number, damp: number, yieldStrain: number, strainLimit: number, targetLen?: number, lastLen?: number) {
        this.id = id;
        this.a = a;
        this.b = b;
        this.length = length;
        this.targetLen = targetLen ?? this.length;
        this.lastLen = lastLen ?? this.length;
        this.spring = spring;
        this.damp = damp;
        this.yieldStrain = yieldStrain;
        this.strainLimit = strainLimit;
    }

    to(bBuf: ArrayBuffer, mBuf: Uint16Array, index: number, mBufOffset: number): void {
        mBuf[mBufOffset + this.id] = index;
        // need to get index of particles in particle buffers first by their id
        const indexA = mBuf[typeof this.a == 'number' ? this.a : this.a.id];
        const indexB = mBuf[typeof this.b == 'number' ? this.b : this.b.id];
        const uint16View = new Uint16Array(bBuf, index * Beam.stride, Beam.stride / Uint16Array.BYTES_PER_ELEMENT);
        const f32View = new Float32Array(bBuf, index * Beam.stride, Beam.stride / Float32Array.BYTES_PER_ELEMENT);
        uint16View[0] = indexA;
        uint16View[1] = indexB;
        f32View[1] = this.length;
        f32View[2] = this.targetLen;
        f32View[3] = this.lastLen;
        f32View[4] = this.spring;
        f32View[5] = this.damp;
        f32View[6] = this.yieldStrain;
        f32View[7] = this.strainLimit;
    }

    static from(bBuf: ArrayBuffer, mBuf: Uint16Array, id: number, mBufOffset: number): Beam {
        const index = mBuf[mBufOffset + id];
        const uint16View = new Uint16Array(bBuf, index * Beam.stride, Beam.stride / Uint16Array.BYTES_PER_ELEMENT);
        const f32View = new Float32Array(bBuf, index * Beam.stride, Beam.stride / Float32Array.BYTES_PER_ELEMENT);
        // quite costly, but there isn't an easy good solution
        const idA = mBuf.indexOf(uint16View[0]);
        const idB = mBuf.indexOf(uint16View[1]);
        return new Beam(id, idA, idB, f32View[1], f32View[4], f32View[5], f32View[6], f32View[7], f32View[2], f32View[3]);

    }
}

/**
 * Defines buffer struct for engine metadata. Metadata buffer is also used as indirect buffer for render passes.
 */
export class Metadata {
    /**
     * Size of buffer needed to contain metadata in bytes.
     * - Particle vertex count - `u32`
     * - Particle instance count - `u32`
     * - Particle first vertex - `u32`
     * - Particle base vertex - `u32`
     * - Particle first instance - `u32`
     * - Beam vertex count - `u32`
     * - Beam instance count - `u32`
     * - Beam first vertex - `u32`
     * - Beam base vertex - `u32`
     * - Beam first instance - `u32`
     * - Max particles - `u32`
     * - Max beams - `u32`
     * - Gravity - `vec2<f32>`
     * - Border elasticity - `f32`
     * - Border friction - `f32`
     * - Elasticity - `f32`
     * - Friction - `f32`
     * - Drag coefficient - `f32`
     * - Drag exponent - `f32`
     * - User strength - `f32`
     * - Mouse active - `u32`
     * - Mouse position - `vec2<f32>`
     * - Mouse velocity - `vec2<f32>`
     * - User applied force - `vec2<f32>`
     */
    static readonly byteLength = 112;
    // indirect buffer (render) = 40
    // max particle + pad = 8
    // simulation constants = 32
    // game inputs = 32

    readonly buffer: ArrayBuffer;
    private readonly indirectView: Uint32Array;
    private readonly maxParticlesView: Uint32Array;
    private readonly physicsConstantsView: Float32Array;
    private readonly userInputViewUint32: Uint32Array;
    private readonly userInputViewF32: Float32Array;

    constructor(buf: ArrayBuffer, maxParticles: number, maxBeams: number) {
        this.buffer = buf;
        this.indirectView = new Uint32Array(this.buffer, 0, 10);
        this.indirectView[0] = 3;
        this.indirectView[5] = 2;
        this.maxParticlesView = new Uint32Array(this.buffer, 40, 2);
        this.maxParticlesView[0] = maxParticles;
        this.maxParticlesView[1] = maxBeams;
        this.physicsConstantsView = new Float32Array(this.buffer, 48, 8);
        this.userInputViewUint32 = new Uint32Array(this.buffer, 80, 8);
        this.userInputViewF32 = new Float32Array(this.buffer, 80, 8);
        this.userStrength = 1;
        this.setPhysicsConstants({
            gravity: new Vector2D(0, -0.5),
            borderElasticity: 0.5,
            borderFriction: 0.2,
            elasticity: 0.5,
            friction: 0.1,
            dragCoeff: 0.001,
            dragExp: 2
        });
    }

    get particleCount(): number {
        return this.indirectView[1];
    }
    set particleCount(c: number) {
        this.indirectView[1] = c;
    }

    get beamCount(): number {
        return this.indirectView[6];
    }
    set beamCount(c: number) {
        this.indirectView[6] = c;
    }

    setPhysicsConstants(constants: WGPUSoftbodyEnginePhysicsConstants): void {
        constants.gravity.to(this.physicsConstantsView, 0);
        this.physicsConstantsView[2] = constants.borderElasticity;
        this.physicsConstantsView[3] = constants.borderFriction;
        this.physicsConstantsView[4] = constants.elasticity;
        this.physicsConstantsView[5] = constants.friction;
        this.physicsConstantsView[6] = constants.dragCoeff;
        this.physicsConstantsView[7] = constants.dragExp;
    }
    getPhysicsConstants(): WGPUSoftbodyEnginePhysicsConstants {
        return {
            gravity: Vector2D.from(this.physicsConstantsView, 0),
            borderElasticity: this.physicsConstantsView[2],
            borderFriction: this.physicsConstantsView[3],
            elasticity: this.physicsConstantsView[4],
            friction: this.physicsConstantsView[5],
            dragCoeff: this.physicsConstantsView[6],
            dragExp: this.physicsConstantsView[7]
        };
    }

    get userStrength(): number {
        return this.userInputViewF32[0];
    }
    set userStrength(p: number) {
        this.userInputViewF32[0] = p;
    }

    setUserInput(appliedForce: Vector2D, mousePos: Vector2D, mouseVel: Vector2D, mouseActive: boolean): void {
        this.userInputViewUint32[1] = mouseActive ? 1 : 0;
        mousePos.to(this.userInputViewF32, 2);
        mouseVel.to(this.userInputViewF32, 4);
        appliedForce.to(this.userInputViewF32, 6);
    }
    writeUserInput(queue: GPUQueue, buffer: GPUBuffer) {
        queue.writeBuffer(buffer, this.userInputViewF32.byteOffset, this.buffer, this.userInputViewF32.byteOffset, this.userInputViewF32.byteLength);
    }
}

/**
 * Defines buffer structs for locating particles and beams by ID in GPU buffers.
 * 
 * Can be used to edit simulation state and transfer that state to and from `ArrayBuffer`s.
 * 
 * - Mapping buffers can hold up to `N` particles and `N` beams in `uint16` format,
 * with each index holding the location of the data in the respective buffer.
 * - Metadata buffer is also used as indirect buffer drawing
 * - Metadata holds number of particles/beams
 * - Mapping buffer is contiguous for the number of particles/beams
 * - Particles/beams never move within the data buffers, to make beam computations faster
 * - IDs of particles not guaranteed to stay the same across write/loads
 */
export class BufferMapper {
    readonly metadata: ArrayBuffer;
    readonly particleData: ArrayBuffer;
    readonly beamData: ArrayBuffer;
    readonly mapping: ArrayBuffer;

    readonly meta: Metadata;
    readonly maxParticles: number;
    readonly maxBeams: number;

    // use map by id to prevent particles/beams with the same ID (+store beams for each particle)
    private readonly particles: Map<number, Particle> = new Map();
    private readonly beams: Map<number, Beam> = new Map();
    private readonly particleBeams: Map<number, Set<Beam>> = new Map();
    private readonly mappingUint16View: Uint16Array;

    /**
     * @param maxByteLength Maximum byte length of buffers allowed
     */
    constructor(maxByteLength: number) {
        // either limited by uint16 index numbers, size of mapping buffer (basically impossible), or size of particle/beam buffers
        this.maxParticles = Math.min(65536, maxByteLength / Uint16Array.BYTES_PER_ELEMENT / 2, Math.floor(maxByteLength / Particle.stride));
        this.maxBeams = Math.min(65536, maxByteLength / Uint16Array.BYTES_PER_ELEMENT / 2, Math.floor(maxByteLength / Particle.stride));
        this.metadata = new ArrayBuffer(Metadata.byteLength);
        this.particleData = new ArrayBuffer(Particle.stride * this.maxParticles);
        this.beamData = new ArrayBuffer(Beam.stride * this.maxBeams);
        this.mapping = new ArrayBuffer(Uint16Array.BYTES_PER_ELEMENT * (this.maxParticles + this.maxBeams));
        this.mappingUint16View = new Uint16Array(this.mapping);
        this.meta = new Metadata(this.metadata, this.maxParticles, this.maxBeams);
    }

    /**
     * Create a snapshot of the current simulation state and store it to a snapshot `ArrayBuffer`.
     * Also writes the simulation state to buffers.
     * @returns Snapshot `ArrayBuffer`
     */
    createSnapshotBuffer(): ArrayBuffer {
        this.writeState();
        // 5 uint16 for length of each section, then metadata (8 float32), then the data of each section
        // mapping particles, particle data, mapping beams, beam data
        const lenSize = Uint16Array.BYTES_PER_ELEMENT * 6;
        const metadataSize = Float32Array.BYTES_PER_ELEMENT * 8;
        const particleMappingSize = Uint16Array.BYTES_PER_ELEMENT * this.meta.particleCount;
        const particleDataSize = Particle.stride * this.meta.particleCount;
        const beamMappingSize = Uint16Array.BYTES_PER_ELEMENT * this.meta.beamCount;
        const beamDataSize = Beam.stride * this.meta.beamCount;
        const buffer = new ArrayBuffer(lenSize + metadataSize + particleMappingSize + particleDataSize + beamMappingSize + beamDataSize);
        const uint16View = new Uint16Array(buffer, 0, 5);
        uint16View[0] = particleMappingSize;
        uint16View[1] = particleDataSize;
        uint16View[2] = beamMappingSize;
        uint16View[3] = beamDataSize;
        uint16View[4] = metadataSize;
        new Float32Array(buffer, lenSize, metadataSize / Float32Array.BYTES_PER_ELEMENT).set(new Float32Array(this.metadata, 48, metadataSize / Float32Array.BYTES_PER_ELEMENT));
        const uint8View = new Uint8Array(buffer, lenSize + metadataSize);
        uint8View.set(new Uint8Array(this.mapping, 0, particleMappingSize), 0);
        uint8View.set(new Uint8Array(this.particleData, 0, particleDataSize), particleMappingSize);
        uint8View.set(new Uint8Array(this.mapping, Uint16Array.BYTES_PER_ELEMENT * this.maxParticles, beamMappingSize), particleMappingSize + particleDataSize);
        uint8View.set(new Uint8Array(this.beamData, 0, beamDataSize), particleMappingSize + particleDataSize + beamMappingSize);
        return buffer;
    }
    /**
     * Replace simulation state with a snapshot from an `ArrayBuffer`.
     * Also writes the simulation state to buffers.
     * @param buf Snapshot `ArrayBuffer`
     */
    loadSnapshotbuffer(buf: ArrayBuffer): boolean {
        const buffer = buf;
        // probably the least efficient and least readable way to extract these buffers
        const uint16View = new Uint16Array(buffer, 0, 5);
        const lenSize = Uint16Array.BYTES_PER_ELEMENT * 6;
        const particleMappingSize = uint16View[0];
        const particleDataSize = uint16View[1];
        const beamMappingSize = uint16View[2];
        const beamDataSize = uint16View[3];
        const metadataSize = uint16View[4];
        // simulation buffers not large enough to contain this snapshot (if from a different device with more resources)
        if (particleMappingSize > this.maxParticles || beamMappingSize > this.maxBeams) return false;
        new Float32Array(this.metadata, 48, metadataSize / Float32Array.BYTES_PER_ELEMENT).set(new Float32Array(buffer, lenSize, metadataSize / Float32Array.BYTES_PER_ELEMENT));
        const baseOffset = lenSize + metadataSize;
        new Uint8Array(this.mapping).set(new Uint8Array(buffer, baseOffset, particleMappingSize), 0);
        new Uint8Array(this.particleData).set(new Uint8Array(buffer, baseOffset + particleMappingSize, particleDataSize), 0);
        new Uint8Array(this.mapping).set(new Uint8Array(buffer, baseOffset + particleMappingSize + particleDataSize, beamMappingSize), Uint16Array.BYTES_PER_ELEMENT * this.maxParticles);
        new Uint8Array(this.beamData).set(new Uint8Array(buffer, baseOffset + particleMappingSize + particleDataSize + beamMappingSize, beamDataSize), 0);
        // compute & buffer mapper uses metadata for particle counts, so just fudge these numbers
        this.meta.particleCount = particleMappingSize / Uint16Array.BYTES_PER_ELEMENT;
        this.meta.beamCount = beamMappingSize / Uint16Array.BYTES_PER_ELEMENT;
        this.loadState();
        return true;
    }

    addParticle(p: Particle): boolean {
        if (this.particles.size == this.maxParticles || this.particles.has(p.id)) return false;
        this.particles.set(p.id, p);
        return true;
    }
    addBeam(b: Beam): boolean {
        if (this.beams.size == this.maxBeams || this.beams.has(b.id)) return false;
        this.beams.set(b.id, b);
        const idA = typeof b.a == 'number' ? b.a : b.a.id;
        const idB = typeof b.b == 'number' ? b.b : b.b.id;
        if (!this.particleBeams.has(idA)) this.particleBeams.set(idA, new Set());
        if (!this.particleBeams.has(idB)) this.particleBeams.set(idB, new Set());
        this.particleBeams.get(idA)!.add(b);
        this.particleBeams.get(idB)!.add(b);
        return true;
    }
    removeParticle(p: Particle | number): boolean {
        const res = this.particles.delete(typeof p == 'number' ? p : p.id);
        return res;
    }
    removeBeam(b: Beam | number): boolean {
        const beam = typeof b == 'number' ? this.beams.get(b) : b;
        if (beam === undefined) return false;
        const res = this.beams.delete(beam.id);
        if (res) {
            this.particleBeams.get(typeof beam.a == 'number' ? beam.a : beam.a.id)?.delete(beam);
            this.particleBeams.get(typeof beam.b == 'number' ? beam.b : beam.b.id)?.delete(beam);
        }
        return res;
    }
    findParticle(id: number): Particle | null {
        return this.particles.get(id) ?? null;
    }
    findBeam(id: number): Beam | null {
        return this.beams.get(id) ?? null;
    }
    getConnectedBeams(p: Particle | number): Set<Beam> {
        return new Set(this.particleBeams.get(typeof p == 'number' ? p : p.id));
    }
    get firstEmptyParticleId(): number {
        if (this.particles.size == this.maxParticles) return -1;
        for (let i = 0; i < this.maxParticles; i++) {
            if (!this.particles.has(i)) return i;
        }
        return -1;
    }
    get firstEmptyBeamId(): number {
        if (this.beams.size == this.maxBeams) return -1;
        for (let i = 0; i < this.maxBeams; i++) {
            if (!this.beams.has(i)) return i;
        }
        return -1;
    }
    get particleSet(): Set<Particle> {
        return new Set(this.particles.values());
    }
    get beamSet(): Set<Beam> {
        return new Set(this.beams.values());
    }
    clear() {
        this.particles.clear();
        this.beams.clear();
        this.particleBeams.clear();
    }

    /**
     * Write the current simulation state to buffers.
     */
    writeState(): void {
        this.meta.particleCount = this.particles.size;
        this.meta.beamCount = this.beams.size;
        const particleIdRemap = new Map<number, number>();
        const particles = [...this.particles.values()];
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            particleIdRemap.set(p.id, i);
            new Particle(i, p.position, p.velocity, p.acceleration).to(this.particleData, this.mappingUint16View, i);
        }
        const beams = [...this.beams.values()];
        for (let i = 0; i < beams.length; i++) {
            const b = beams[i];
            const idA = particleIdRemap.get(typeof b.a == 'number' ? b.a : b.a.id) ?? b.a;
            const idB = particleIdRemap.get(typeof b.b == 'number' ? b.b : b.b.id) ?? b.b;
            new Beam(i, idA, idB, b.length, b.spring, b.damp, b.yieldStrain, b.strainLimit, b.targetLen, b.lastLen).to(this.beamData, this.mappingUint16View, i, this.maxParticles);
        }
    }
    /**
     * Load a new simulation state from buffers for editing.
     */
    loadState(): void {
        this.clear();
        const pCount = this.meta.particleCount;
        for (let i = 0; i < pCount; i++) this.addParticle(Particle.from(this.particleData, this.mappingUint16View, i));
        const bCount = this.meta.beamCount;
        for (let i = 0; i < bCount; i++) this.addBeam(Beam.from(this.beamData, this.mappingUint16View, i, this.maxParticles));
    }
}
