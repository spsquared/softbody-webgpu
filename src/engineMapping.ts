type TypedArray = Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array | Float32Array | Float64Array;

// THERE IS NO VALIDATION FOR ANYTHING, IF SOMETHING GOES WRONG THERE WILL BE WEIRD ERRORS

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
        const f32View = new Float32Array(pBuf, index * Particle.stride, Particle.stride / Float32Array.BYTES_PER_ELEMENT);
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
     * - Target length: `f32`
     * - Last length: `f32`
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
        const uint16View = new Uint16Array(bBuf, index * Beam.stride, Beam.stride / Uint16Array.BYTES_PER_ELEMENT);
        const f32View = new Float32Array(bBuf, index * Beam.stride, Beam.stride / Float32Array.BYTES_PER_ELEMENT);
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
        const uint16View = new Uint16Array(bBuf, index * Beam.stride, Beam.stride / Uint16Array.BYTES_PER_ELEMENT);
        const f32View = new Float32Array(bBuf, index * Beam.stride, Beam.stride / Float32Array.BYTES_PER_ELEMENT);
        const idA = mBuf.indexOf(uint16View[0]);
        const idB = mBuf.indexOf(uint16View[1]);
        return new Beam(id, idA, idB, f32View[1], f32View[3], f32View[4], f32View[2]);

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
     * - Gravity - `f32`
     * - User strength - `f32`
     * - Mouse active - `u32`
     * - Mouse position - `vec2<f32>`
     * - Mouse velocity - `vec2<f32>`
     * - User applied force - `vec2<f32>`
     */
    static readonly byteLength = 80; // particle/beam = 40, game - 40, (be careful with struct alignment)

    readonly buf: ArrayBuffer;
    private readonly uint32View: Uint32Array;
    private readonly float32View: Float32Array;

    constructor(buf: ArrayBuffer, maxParticles: number) {
        this.buf = buf;
        this.uint32View = new Uint32Array(this.buf);
        this.float32View = new Float32Array(this.buf);
        this.uint32View[0] = 3;
        this.uint32View[5] = 2;
        this.uint32View[10] = maxParticles;
        this.userStrength = 1;
    }

    get particleCount(): number {
        return this.uint32View[1];
    }
    set particleCount(c: number) {
        this.uint32View[1] = c;
    }

    get beamCount(): number {
        return this.uint32View[6];
    }
    set beamCount(c: number) {
        this.uint32View[6] = c;
    }

    get gravity(): number {
        return this.float32View[11];
    }
    set gravity(g: number) {
        this.float32View[11] = g;
    }

    get userStrength(): number {
        return this.float32View[12];
    }
    set userStrength(p: number) {
        this.float32View[12] = p;
    }

    setUserInput(appliedForce: Vector2D, mousePos: Vector2D, mouseVel: Vector2D, mouseActive: boolean): void {
        this.uint32View[13] = mouseActive ? 1 : 0;
        mousePos.to(this.float32View, 14);
        mouseVel.to(this.float32View, 16);
        appliedForce.to(this.float32View, 18);
    }
    writeUserInput(queue: GPUQueue, buffer: GPUBuffer) {
        queue.writeBuffer(buffer, 48, this.buf, 48, 32);
        // queue.writeBuffer(buffer, 0, this.buf, 0);
    }
}

/**
 * Defines buffer structs for locating particles and beams by ID in GPU buffers.
 * - Mapping buffers can hold up to `N` particles and `N` beams in `uint16` format,
 * with each index holding the location of the data in the respective buffer.
 * - Metadata buffer is also used as indirect buffer drawing
 * - Metadata holds number of particles/beams
 * - Mapping buffer is contiguous for the number of particles/beams
 * - Particles/beams never move within the data buffers, to make beam computations faster
 * - IDs of particles not guaranteed to stay the same
 */
export class BufferMapper {
    readonly metadata: ArrayBuffer;
    readonly particleData: ArrayBuffer;
    readonly beamData: ArrayBuffer;
    readonly mapping: ArrayBuffer;

    readonly meta: Metadata;
    readonly maxParticles: number;

    private readonly particles: Set<Particle> = new Set();
    private readonly beams: Set<Beam> = new Set();
    private readonly mappingUint16View: Uint16Array;

    /**
     * @param maxByteLength Maximum byte length of buffers allowed
     */
    constructor(maxByteLength: number) {
        // either limited by uint16 index numbers, size of mapping buffer, or size of particle/beam buffers
        this.maxParticles = Math.min(65536, maxByteLength / Uint16Array.BYTES_PER_ELEMENT / 2, Math.floor(maxByteLength / Math.max(Particle.stride, Beam.stride)));
        this.metadata = new ArrayBuffer(Metadata.byteLength);
        this.particleData = new ArrayBuffer(Particle.stride * this.maxParticles);
        this.beamData = new ArrayBuffer(Beam.stride * this.maxParticles);
        this.mapping = new ArrayBuffer(Uint16Array.BYTES_PER_ELEMENT * 2 * this.maxParticles);
        this.mappingUint16View = new Uint16Array(this.mapping);
        this.meta = new Metadata(this.metadata, this.maxParticles);
    }

    load(): void {
        this.clear();
        const pCount = this.meta.particleCount;
        for (let i = 0; i < pCount; i++) this.particles.add(Particle.from(this.particleData, this.mappingUint16View, i));
        const bCount = this.meta.beamCount;
        for (let i = 0; i < bCount; i++) this.beams.add(Beam.from(this.beamData, this.mappingUint16View, i, this.maxParticles));
    }
    save(): void {
        this.meta.particleCount = this.particles.size;
        this.meta.beamCount = this.beams.size;
        const particles = [...this.particles.values()];
        for (let i = 0; i < particles.length; i++) particles[i].to(this.particleData, this.mappingUint16View, i);
        const beams = [...this.beams.values()];
        for (let i = 0; i < beams.length; i++) beams[i].to(this.beamData, this.mappingUint16View, i, this.maxParticles);
    }

    addParticle(p: Particle): boolean {
        if (this.particles.size == this.maxParticles) return false;
        this.particles.add(p);
        return true;
    }
    addBeam(b: Beam): boolean {
        if (this.beams.size == this.maxParticles) return false;
        this.beams.add(b);
        return true;
    }
    removeParticle(p: Particle): boolean {
        return this.particles.delete(p);
    }
    removeBeam(b: Beam): boolean {
        return this.beams.delete(b);
    }
    clear() {
        this.particles.clear();
        this.beams.clear();
    }
}