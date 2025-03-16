type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

// THERE IS NO VALIDATION FOR ANYTHING, IF SOMETHING GOES WRONG THERE WILL BE WEIRD ERRORS
// Note: If weird offsets are needed (4-byte type needs 2-byte offset), slice the ArrayBuffer to shift for reading and use copyWithin to shift for writing

/**
 * Defines buffer structs for placing vectors into GPU buffers.
 */
export class Vector2D {
    x: number;
    y: number;

    constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
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

    /**
     * Write a particle to a particular location.
     * Mapping buffer at this particle's `id` will point to `index`.'
     * 
     * @param pBuf Particle data buffer
     * @param mBuf Mapping buffer
     * @param index Location in the particle buffer (particle `n`)
     */
    to(pBuf: ArrayBuffer, mBuf: Uint16Array, index: number): void {
        mBuf[this.id] = index;
        const len = Particle.stride / Float32Array.BYTES_PER_ELEMENT;
        const f32View = new Float32Array(pBuf, index * len, len);
        this.position.to(f32View, 0);
        this.velocity.to(f32View, 2);
        this.acceleration.to(f32View, 4);
    }

    /**
     * Read a particle from a particular location.
     * Uses the mapping buffer and `id` of the target to find the particle in the data buffer.
     * 
     * @param pBuf Particle data buffer
     * @param mBuf Mapping buffer
     * @param id Location in the mapping buffer (id `n`)
     */
    static from(pBuf: ArrayBuffer, mBuf: Uint16Array, id: number): Particle {
        const index = mBuf[id];
        const len = Particle.stride / Float32Array.BYTES_PER_ELEMENT;
        const f32View = new Float32Array(pBuf, index * len, len);
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
     * - Target length: `f32`
     * - Last distance: `f32`
     * - Spring constant: `f32`
     * - Damping constant: `f32`
     */
    static readonly stride = 20;

    readonly id: number;
    readonly a: number | Particle;
    readonly b: number | Particle;
    length: number;
    lastDist: number;
    spring: number;
    damp: number;

    constructor(id: number, a: number | Particle, b: number | Particle, length: number, spring: number, damp: number, lastDist?: number) {
        this.id = id;
        this.a = a;
        this.b = b;
        this.length = length;
        this.lastDist = lastDist ?? this.length;
        this.spring = spring;
        this.damp = damp;
    }

    /**
     * Write a beam to a particular location.
     * Mapping buffer at this beam's `id` will point to `index`.
     * 
     * @param bBuf Beam data buffer
     * @param mBuf Mapping buffer
     * @param index Location in the beam buffer (beam `n`)
     * @param mBufOffset Location in the mapping buffer that beam mappings begin at
     */
    to(bBuf: ArrayBuffer, mBuf: Uint16Array, index: number, mBufOffset: number): void {
        mBuf[mBufOffset + this.id] = index;
        // need to get index of particles in particle buffers first by their id
        const indexA = mBuf[typeof this.a == 'number' ? this.a : this.a.id];
        const indexB = mBuf[typeof this.b == 'number' ? this.b : this.b.id];
        const lenUint16 = Beam.stride / Uint16Array.BYTES_PER_ELEMENT;
        const lenF32 = Beam.stride / Float32Array.BYTES_PER_ELEMENT;
        const uint16View = new Uint16Array(bBuf, index * lenUint16, lenUint16);
        const f32View = new Float32Array(bBuf, index * lenF32, lenF32);
        uint16View[0] = indexA;
        uint16View[1] = indexB;
        f32View[1] = this.length;
        f32View[2] = this.lastDist;
        f32View[3] = this.spring;
        f32View[4] = this.damp;
    }

    /**
     * Read a beam from a particular location.
     * Uses the mapping buffer and `id` of the target to find the beam in the data buffer.
     * *Note: this function is **very costly** as it searches the entire mapping buffer to find particle ID.*
     * @param bBuf beam data buffer
     * @param mBuf Mapping buffer
     * @param id Location in the mapping buffer (id `n`)
     * @param mBufOffset Location in the mapping buffer that beam mappings begin at
     */
    static from(bBuf: ArrayBuffer, mBuf: Uint16Array, id: number, mBufOffset: number): Beam {
        const index = mBuf[mBufOffset + id];
        const lenUint16 = Beam.stride / Uint16Array.BYTES_PER_ELEMENT;
        const lenF32 = Beam.stride / Float32Array.BYTES_PER_ELEMENT;
        const uint16View = new Uint16Array(bBuf, index * lenUint16, lenUint16);
        const f32View = new Float32Array(bBuf, index * lenF32, lenF32);
        // ensure beam counters & particles not checked
        const idA = mBuf.indexOf(uint16View[0], mBufOffset + 1);
        const idB = mBuf.indexOf(uint16View[1], mBufOffset + 1);
        return new Beam(id, idA, idB, f32View[1], f32View[3], f32View[4], f32View[2]);

    }
}

/**
 * Defines buffer struct for engine metadata.
 */
export class Metadata {
    /**
     * Size of buffer needed to contain metadata in bytes.
     * - Particle count - `uint16`
     * - Beam count - `uint16`
     */
    static readonly byteLength = 4;

    readonly buf: ArrayBuffer;
    private readonly uint16View: Uint16Array;

    constructor(buf: ArrayBuffer) {
        this.buf = buf;
        this.uint16View = new Uint16Array(this.buf);
    }

    get particleCount(): number {
        return this.uint16View[0];
    }
    set particleCount(c: number) {
        this.uint16View[0] = c;
    }

    get beamCount(): number {
        return this.uint16View[1];
    }
    set beamCount(c: number) {
        this.uint16View[1] = c;
    }
}

/**
 * Defines buffer structs for locating particles and beams by ID in GPU buffers.
 * Mapping buffers can hold up to `N` particles and `N` beams in `uint16` format,
 * with each index holding the location of the data in the respective buffer,
 * effectively acting as an index buffer.
 * 
 * particle/beam sections are contiguous
 * 
 * add new buffer for data like cursor, camera, particle/beam count?
 */
export class BufferMapper {
    readonly metadata: ArrayBuffer;
    readonly particleData: ArrayBuffer;
    readonly beamData: ArrayBuffer;
    readonly mapping: Uint16Array;

    readonly meta: Metadata;

    readonly maxParticles: number;

    /**
     * @param maxByteLength Maximum byte length of buffers allowed
     */
    constructor(maxByteLength: number) {
        // either limited by uint16 index numbers, size of mapping buffer, or size of particle/beam buffers
        this.maxParticles = Math.min(65536, maxByteLength / Uint16Array.BYTES_PER_ELEMENT / 2, Math.floor(maxByteLength / Math.max(Particle.stride, Beam.stride)));
        this.metadata = new ArrayBuffer(Metadata.byteLength);
        this.particleData = new ArrayBuffer(Particle.stride * this.maxParticles);
        this.beamData = new ArrayBuffer(Beam.stride * this.maxParticles);
        this.mapping = new Uint16Array(2 * this.maxParticles);
        this.meta = new Metadata(this.metadata);
    }

    addParticle(p: Particle): boolean {
        if (this.meta.particleCount == this.maxParticles) return false;
        p.to(this.particleData, this.mapping, this.meta.particleCount++);
        return true;
    }

    addBeam(b: Beam): boolean {
        if (this.meta.beamCount == this.maxParticles) return false;
        b.to(this.beamData, this.mapping, this.meta.beamCount++, this.maxParticles);
        return true;
    }

    removeParticle(p: Particle): boolean {
        const meta = Metadata.from(this.metadata);

    }
}