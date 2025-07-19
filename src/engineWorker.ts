/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

import { WGPUSoftbodyEngineMessageTypes, WGPUSoftbodyEngineOptions } from './engine';
import { Beam, BufferMapper, Particle, Vector2D } from './engineMapping';
import { AsyncLock } from './lock';

import computeShader from './shaders/compute.wgsl?raw';
import renderShader from './shaders/render.wgsl?raw';

type BindGroupPair = { readonly layout: GPUBindGroupLayout, readonly group: GPUBindGroup };

/**
 * Worker thread singleton class that handles simulation & drawing through WebGPU. Softbody objects
 * consist of "particles" - simple circles with elastic collisions with each other and the edge of
 * the simulation space ("grid") - and "beams" - spring/damp relations between particles (very similar
 * to BeamNG's simulation system of nodes & beams) that attempt to maintain a target distance (spring)
 * and resist changes in distance (damp).
 * 
 * Simulation is done using compute shaders, with one thread assigned to each ID (particle & beam)
 * (note many threads will often do nothing if there's no particle/beam there). Multiple subticks
 * are run to increase accuracy of simulation.
 */
class WGPUSoftbodyEngineWorker {
    private static sInstance: WGPUSoftbodyEngineWorker | null = null;

    static create(canvas: OffscreenCanvas, opts?: Partial<WGPUSoftbodyEngineOptions>): WGPUSoftbodyEngineWorker {
        return WGPUSoftbodyEngineWorker.sInstance = new WGPUSoftbodyEngineWorker(canvas, opts);
    }

    static instance(): WGPUSoftbodyEngineWorker | null {
        return WGPUSoftbodyEngineWorker.sInstance;
    }

    private readonly canvas: OffscreenCanvas;
    private readonly ctx: GPUCanvasContext;
    private readonly device: Promise<GPUDevice>;
    private readonly textureFormat: GPUTextureFormat;

    private readonly lock: AsyncLock = new AsyncLock();

    readonly boundsSize: number = 1000;
    readonly particleRadius: number = 10;
    readonly subticks: number = 64;

    readonly blur: number = 0.4;
    readonly workgroupSize = 64;

    private readonly modules: Promise<{
        readonly compute: GPUShaderModule
        readonly render: GPUShaderModule
    }>;
    private readonly bufferMapper: Promise<BufferMapper>;
    private readonly buffers: Promise<{
        readonly metadata: GPUBuffer
        readonly particlesA: GPUBuffer
        readonly particlesB: GPUBuffer
        readonly beams: GPUBuffer
        readonly mapping: GPUBuffer
        readonly particleForces: GPUBuffer
        readonly deleteMappings: GPUBuffer
    }>;
    private readonly bindGroups: Promise<{
        readonly computeA: BindGroupPair
        readonly computeB: BindGroupPair
        readonly renderBeams: BindGroupPair
    }>;
    private readonly pipelines: Promise<{
        readonly computeUpdate: GPUComputePipeline
        readonly computeDelete: GPUComputePipeline
        readonly renderParticles: GPURenderPipeline
        readonly renderBeams: GPURenderPipeline
    }>;
    private readonly stagingBuffers: Promise<{
        readonly metadata: GPUBuffer
        readonly particles: GPUBuffer
        readonly beams: GPUBuffer
        readonly mapping: GPUBuffer
    }>;

    private visible: boolean = true;
    private readonly frameTimes: number[] = [];
    private readonly fpsHistory: number[] = [];
    private running: boolean = true;

    private constructor(canvas: OffscreenCanvas, opts?: Partial<WGPUSoftbodyEngineOptions>) {
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
        if (this.ctx === null) throw new TypeError('WebGPU not supported');
        // apply options
        if (opts !== undefined) {
            if (opts.particleRadius !== undefined) this.particleRadius = opts.particleRadius;
            if (opts.subticks !== undefined) this.subticks = Math.ceil(opts.subticks / 2) * 2;
        }
        // get GPU device and configure devices
        if (navigator.gpu === undefined) throw new TypeError('WebGPU not supported');
        this.textureFormat = navigator.gpu.getPreferredCanvasFormat();
        const adapter = navigator.gpu?.requestAdapter();
        this.device = new Promise<GPUDevice>(async (resolve) => {
            const ad = await adapter;
            if (ad === null) throw new TypeError('GPU adapter not available');
            console.log('Adapter max limits', ad.limits);
            const gpu = await ad.requestDevice({
                requiredLimits: {
                    maxComputeInvocationsPerWorkgroup: ad.limits.maxComputeInvocationsPerWorkgroup,
                    maxComputeWorkgroupSizeX: ad.limits.maxComputeWorkgroupSizeX,
                    maxComputeWorkgroupSizeY: ad.limits.maxComputeWorkgroupSizeY,
                    maxBufferSize: ad.limits.maxBufferSize,
                    maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize
                }
            });
            this.ctx.configure({
                device: gpu,
                format: this.textureFormat,
                alphaMode: 'premultiplied',
            });
            console.log('GPU limits', gpu.limits);
            resolve(gpu);
        });
        // create resources
        this.bufferMapper = new Promise<BufferMapper>(async (resolve) => {
            const ad = await adapter;
            if (ad === null) throw new TypeError('GPU adapter not available');
            resolve(new BufferMapper(ad.limits.maxStorageBufferBindingSize));
        });
        this.modules = new Promise(async (resolve) => {
            const device = await this.device;
            resolve({
                compute: device.createShaderModule({
                    label: import.meta.env.DEV ? 'Physics compute shader' : undefined,
                    code: computeShader
                }),
                render: device.createShaderModule({
                    label: import.meta.env.DEV ? 'Particle render shader' : undefined,
                    code: renderShader
                })
            });
        });
        this.buffers = new Promise(async (resolve) => {
            const device = await this.device;
            const bufferMapper = await this.bufferMapper;
            resolve({
                metadata: device.createBuffer({
                    label: import.meta.env.DEV ? 'Metadata buffer' : undefined,
                    size: bufferMapper.metadata.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                particlesA: device.createBuffer({
                    label: import.meta.env.DEV ? 'Particle data buffer primary' : undefined,
                    size: bufferMapper.particleData.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                particlesB: device.createBuffer({
                    label: import.meta.env.DEV ? 'Particle data buffer secondary' : undefined,
                    size: bufferMapper.particleData.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                beams: device.createBuffer({
                    label: import.meta.env.DEV ? 'Beam data buffer' : undefined,
                    size: bufferMapper.beamData.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                mapping: device.createBuffer({
                    label: import.meta.env.DEV ? 'Mapping buffer' : undefined,
                    size: bufferMapper.mapping.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                particleForces: device.createBuffer({
                    label: import.meta.env.DEV ? 'Totally necessary particle forces buffer' : undefined,
                    size: bufferMapper.maxParticles * Uint32Array.BYTES_PER_ELEMENT * 2,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                }),
                deleteMappings: device.createBuffer({
                    label: import.meta.env.DEV ? 'Delete mappings buffer' : undefined,
                    size: Math.ceil(bufferMapper.maxParticles + bufferMapper.maxBeams / Uint32Array.BYTES_PER_ELEMENT) * Uint32Array.BYTES_PER_ELEMENT,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
                }),
            });
        });
        this.bindGroups = new Promise(async (resolve) => {
            const device = await this.device;
            const buffers = await this.buffers;
            const computeLayoutEntry = (binding: number, type?: GPUBufferBindingType) => ({
                binding: binding,
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: type ?? 'storage' }
            });
            const computeBindGroupLayout = device.createBindGroupLayout({
                entries: [
                    computeLayoutEntry(0),
                    computeLayoutEntry(1, 'read-only-storage'),
                    computeLayoutEntry(2),
                    computeLayoutEntry(3),
                    computeLayoutEntry(4),
                    computeLayoutEntry(5),
                    computeLayoutEntry(6)
                ]
            });
            const renderBindGroupLayout = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 1,
                        visibility: GPUShaderStage.VERTEX,
                        buffer: { type: 'read-only-storage' }
                    }
                ]
            });
            const computeCommonEntries = [
                {
                    binding: 0,
                    resource: {
                        label: import.meta.env.DEV ? 'Metadata buffer binding' : undefined,
                        buffer: buffers.metadata
                    }
                },
                {
                    binding: 3,
                    resource: {
                        label: import.meta.env.DEV ? 'Beam buffer binding' : undefined,
                        buffer: buffers.beams
                    }
                },
                {
                    binding: 4,
                    resource: {
                        label: import.meta.env.DEV ? 'Mapping buffer binding' : undefined,
                        buffer: buffers.mapping
                    }
                },
                {
                    binding: 5,
                    resource: {
                        label: import.meta.env.DEV ? 'Totally necessary particle forces buffer binding' : undefined,
                        buffer: buffers.particleForces
                    }
                },
                {
                    binding: 6,
                    resource: {
                        label: import.meta.env.DEV ? 'Delete mappings buffer binding' : undefined,
                        buffer: buffers.deleteMappings
                    }
                }
            ];
            // two bind groups because alternating subticks reading from one and writing to the other - fixes collision asymmetry
            // particle A collides with particle B, then moves, then particle B updates and calculates a different force, causing flying
            resolve({
                computeA: {
                    layout: computeBindGroupLayout,
                    group: device.createBindGroup({
                        label: import.meta.env.DEV ? 'Compute bind group A' : undefined,
                        layout: computeBindGroupLayout,
                        entries: [
                            ...computeCommonEntries,
                            {
                                binding: 1,
                                resource: {
                                    label: import.meta.env.DEV ? 'Particle buffer primary binding A' : undefined,
                                    buffer: buffers.particlesA
                                }
                            },
                            {
                                binding: 2,
                                resource: {
                                    label: import.meta.env.DEV ? 'Particle buffer secondary binding A' : undefined,
                                    buffer: buffers.particlesB
                                }
                            }
                        ]
                    })
                },
                computeB: {
                    layout: computeBindGroupLayout,
                    group: device.createBindGroup({
                        label: import.meta.env.DEV ? 'Compute bind group B' : undefined,
                        layout: computeBindGroupLayout,
                        entries: [
                            ...computeCommonEntries,
                            {
                                binding: 1,
                                resource: {
                                    label: import.meta.env.DEV ? 'Particle buffer secondary binding B' : undefined,
                                    buffer: buffers.particlesB
                                }
                            },
                            {
                                binding: 2,
                                resource: {
                                    label: import.meta.env.DEV ? 'Particle buffer primary binding B' : undefined,
                                    buffer: buffers.particlesA
                                }
                            }
                        ]
                    })
                },
                renderBeams: {
                    layout: renderBindGroupLayout,
                    group: device.createBindGroup({
                        label: import.meta.env.DEV ? 'Render bind group' : undefined,
                        layout: renderBindGroupLayout,
                        entries: [
                            {
                                binding: 1,
                                resource: {
                                    label: import.meta.env.DEV ? 'Particle buffer binding' : undefined,
                                    buffer: buffers.particlesA
                                }
                            }
                        ]
                    })
                }
            });
        });
        this.pipelines = new Promise(async (resolve) => {
            const device = await this.device;
            const modules = await this.modules;
            const bindGroups = await this.bindGroups;
            // two compute pipelines as deleting beams/particles from within the shaders requires syncing
            const computeLayout = device.createPipelineLayout({
                label: import.meta.env.DEV ? 'Compute pipeline layout' : undefined,
                bindGroupLayouts: [bindGroups.computeA.layout]
            });
            resolve({
                computeUpdate: await device.createComputePipelineAsync({
                    label: import.meta.env.DEV ? 'Physics compute pipeline' : undefined,
                    layout: computeLayout,
                    compute: {
                        module: modules.compute,
                        entryPoint: 'compute_update',
                        constants: {
                            bounds_size: this.boundsSize,
                            particle_radius: this.particleRadius,
                            time_step: 1 / this.subticks,
                        }
                    }
                }),
                computeDelete: await device.createComputePipelineAsync({
                    label: import.meta.env.DEV ? 'Delete compute pipeline' : undefined,
                    layout: computeLayout,
                    compute: {
                        module: modules.compute,
                        entryPoint: 'compute_delete',
                        constants: { }
                    }
                }),
                renderParticles: await device.createRenderPipelineAsync({
                    label: import.meta.env.DEV ? 'Particle render pipeline' : undefined,
                    layout: device.createPipelineLayout({
                        label: import.meta.env.DEV ? 'Particle render pipeline layout' : undefined,
                        bindGroupLayouts: []
                    }),
                    vertex: {
                        module: modules.render,
                        entryPoint: 'vertex_particle_main',
                        constants: {
                            bounds_size: this.boundsSize,
                            particle_radius: this.particleRadius
                        },
                        buffers: [
                            {
                                arrayStride: Particle.stride,
                                attributes: [
                                    {
                                        shaderLocation: 0,
                                        format: 'float32x2',
                                        offset: 0
                                    },
                                ],
                                stepMode: 'instance'
                            }
                        ]
                    },
                    fragment: {
                        module: modules.render,
                        entryPoint: 'fragment_particle_main',
                        constants: {
                            particle_radius: this.particleRadius
                        },
                        targets: [
                            {
                                format: this.textureFormat,
                                blend: {
                                    color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                                    alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }
                                }
                            }
                        ]
                    },
                    primitive: {
                        topology: 'triangle-strip',
                        stripIndexFormat: 'uint16'
                    }
                }),
                renderBeams: await device.createRenderPipelineAsync({
                    label: import.meta.env.DEV ? 'Beam render pipeline' : undefined,
                    layout: device.createPipelineLayout({
                        label: import.meta.env.DEV ? 'Beam render pipeline layout' : undefined,
                        bindGroupLayouts: [bindGroups.renderBeams.layout]
                    }),
                    vertex: {
                        module: modules.render,
                        entryPoint: 'vertex_beam_main',
                        constants: {
                            bounds_size: this.boundsSize,
                        },
                        buffers: [
                            {
                                arrayStride: Beam.stride,
                                attributes: [
                                    {
                                        shaderLocation: 0,
                                        format: 'uint32',
                                        offset: 0
                                    },
                                    {
                                        shaderLocation: 1,
                                        format: 'float32',
                                        offset: 4
                                    },
                                    {
                                        shaderLocation: 2,
                                        format: 'float32',
                                        offset: 32
                                    },
                                    {
                                        shaderLocation: 3,
                                        format: 'float32',
                                        offset: 36
                                    }
                                ],
                                stepMode: 'instance'
                            }
                        ]
                    },
                    fragment: {
                        module: modules.render,
                        entryPoint: 'fragment_beam_main',
                        constants: {},
                        targets: [
                            {
                                format: this.textureFormat,
                                // blending moment
                            }
                        ]
                    },
                    primitive: {
                        topology: 'line-strip',
                        stripIndexFormat: 'uint16'
                    }
                })
            });
        });
        this.stagingBuffers = new Promise(async (resolve) => {
            const device = await this.device;
            const bufferMapper = await this.bufferMapper;
            resolve({
                metadata: device.createBuffer({
                    label: import.meta.env.DEV ? 'Metadata staging buffer' : undefined,
                    size: bufferMapper.metadata.byteLength,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                }),
                particles: device.createBuffer({
                    label: import.meta.env.DEV ? 'Particle data staging buffer' : undefined,
                    size: bufferMapper.particleData.byteLength,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                }),
                beams: device.createBuffer({
                    label: import.meta.env.DEV ? 'Beam data staging buffer' : undefined,
                    size: bufferMapper.beamData.byteLength,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                }),
                mapping: device.createBuffer({
                    label: import.meta.env.DEV ? 'Mapping staging buffer' : undefined,
                    size: bufferMapper.mapping.byteLength,
                    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
                })
            });
        });
        self.addEventListener('message', this.onMessageWrapper);
        this.startDraw();
        this.device.then((device) => device.lost.then(() => this.destroy()));
    }

    private postMessage(type: WGPUSoftbodyEngineMessageTypes, data?: any, transfers?: Transferable[]) {
        self.postMessage({
            type: type,
            data: data
        }, { transfer: transfers });
    }
    private async onMessage(e: MessageEvent) {
        // scuffed blocks
        switch (e.data.type) {
            case WGPUSoftbodyEngineMessageTypes.DESTROY: {
                this.destroy();
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.PHYSICS_CONSTANTS: {
                const bufferMapper = await this.bufferMapper;
                await this.loadBuffers();
                bufferMapper.meta.setPhysicsConstants({
                    ...e.data.data,
                    gravity: Vector2D.fromObject(e.data.data.gravity)
                });
                await this.writeBuffers();
                this.postMessage(WGPUSoftbodyEngineMessageTypes.PHYSICS_CONSTANTS, bufferMapper.meta.getPhysicsConstants());
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.GET_PHYSICS_CONSTANTS: {
                const bufferMapper = await this.bufferMapper;
                await this.loadBuffers();
                this.postMessage(WGPUSoftbodyEngineMessageTypes.PHYSICS_CONSTANTS, bufferMapper.meta.getPhysicsConstants());
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.INPUT: {
                this.userInput.appliedForce = Vector2D.fromObject(e.data.data[0]);
                this.userInput.mousePos = Vector2D.fromObject(e.data.data[1]);
                this.userInput.mouseActive = e.data.data[2];
                this.postMessage(WGPUSoftbodyEngineMessageTypes.INPUT);
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.VISIBILITY_CHANGE: {
                this.visible = !e.data.data;
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.SNAPSHOT_SAVE: {
                const bufferMapper = await this.bufferMapper;
                await this.loadBuffers();
                bufferMapper.loadState();
                this.postMessage(WGPUSoftbodyEngineMessageTypes.SNAPSHOT_SAVE, bufferMapper.createSnapshotBuffer());
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.SNAPSHOT_LOAD: {
                const bufferMapper = await this.bufferMapper;
                const buffer = e.data.data as ArrayBuffer;
                const res = bufferMapper.loadSnapshotbuffer(buffer);
                if (res) await this.writeBuffers();
                this.postMessage(WGPUSoftbodyEngineMessageTypes.SNAPSHOT_LOAD, res);
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.CORRUPT_BUFFERS: {
                this.corruptBuffers();
            }
                break;
        }
    }
    private onMessageWrapper = (e: MessageEvent) => this.onMessage(e);

    async loadBuffers(): Promise<void> {
        const device = await this.device;
        const buffers = await this.buffers;
        const stagingBuffers = await this.stagingBuffers;
        const bufferMapper = await this.bufferMapper;
        await this.lock.acquire();
        await device.queue.onSubmittedWorkDone();
        // if only there was a readBuffer convenience function
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffers.metadata, 0, stagingBuffers.metadata, 0, buffers.metadata.size);
        encoder.copyBufferToBuffer(buffers.particlesA, 0, stagingBuffers.particles, 0, buffers.particlesA.size);
        encoder.copyBufferToBuffer(buffers.beams, 0, stagingBuffers.beams, 0, buffers.beams.size);
        encoder.copyBufferToBuffer(buffers.mapping, 0, stagingBuffers.mapping, 0, buffers.mapping.size);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        await Promise.all([
            stagingBuffers.metadata.mapAsync(GPUMapMode.READ, 0, stagingBuffers.metadata.size),
            stagingBuffers.particles.mapAsync(GPUMapMode.READ, 0, stagingBuffers.particles.size),
            stagingBuffers.beams.mapAsync(GPUMapMode.READ, 0, stagingBuffers.beams.size),
            stagingBuffers.mapping.mapAsync(GPUMapMode.READ, 0, stagingBuffers.mapping.size)
        ]);
        // no way to directly copy ArrayBuffers (since they're just pointers) so we do this
        new Uint8Array(bufferMapper.metadata).set(new Uint8Array(stagingBuffers.metadata.getMappedRange(0, stagingBuffers.metadata.size).slice()));
        new Uint8Array(bufferMapper.particleData).set(new Uint8Array(stagingBuffers.particles.getMappedRange(0, stagingBuffers.particles.size).slice()));
        new Uint8Array(bufferMapper.beamData).set(new Uint8Array(stagingBuffers.beams.getMappedRange(0, stagingBuffers.beams.size).slice()));
        new Uint8Array(bufferMapper.mapping).set(new Uint8Array(stagingBuffers.mapping.getMappedRange(0, stagingBuffers.mapping.size).slice()));
        stagingBuffers.metadata.unmap();
        stagingBuffers.particles.unmap();
        stagingBuffers.beams.unmap();
        stagingBuffers.mapping.unmap();
        this.lock.release();
    }
    async writeBuffers(): Promise<void> {
        const device = await this.device;
        const buffers = await this.buffers;
        const bufferMapper = await this.bufferMapper;
        await this.lock.acquire();
        await device.queue.onSubmittedWorkDone();
        device.queue.writeBuffer(buffers.metadata, 0, bufferMapper.metadata, 0);
        device.queue.writeBuffer(buffers.mapping, 0, bufferMapper.mapping, 0);
        device.queue.writeBuffer(buffers.particlesA, 0, bufferMapper.particleData, 0);
        device.queue.writeBuffer(buffers.beams, 0, bufferMapper.beamData, 0);
        const encoder = device.createCommandEncoder();
        encoder.clearBuffer(buffers.particleForces, 0, buffers.particleForces.size);
        encoder.clearBuffer(buffers.deleteMappings, 0, buffers.deleteMappings.size);
        encoder.clearBuffer(buffers.particlesB, 0, buffers.particlesB.size);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        this.lock.release();
    }

    async corruptBuffers(): Promise<void> {
        const device = await this.device;
        const buffers = await this.buffers;
        const corrupt = (buf: GPUBuffer) => {
            const oof = new Uint32Array(1);
            while (Math.random() < 0.5) {
                oof[0] = Math.floor(Math.random() * 4294967296);
                const pos = Math.floor(Math.random() * buf.size / 4) * 4;
                device.queue.writeBuffer(buf, pos, oof.buffer, 0, 4);
            }
        };
        // this will spawn race conditions all over the place lol
        if (Math.random() < 0.1) corrupt(buffers.metadata);
        corrupt(buffers.mapping);
        corrupt(buffers.particlesA);
        corrupt(buffers.particlesB);
        corrupt(buffers.beams);
        corrupt(buffers.particleForces);
    }

    private readonly userInput = {
        appliedForce: new Vector2D(0, 0),
        mousePos: new Vector2D(0, 0),
        lastMouse: new Vector2D(0, 0),
        mouseActive: false,
        lastFrame: performance.now()
    };
    private async frame(): Promise<void> {
        const device = await this.device;
        const buffers = await this.buffers;
        const bufferMapper = await this.bufferMapper;
        const bindGroups = await this.bindGroups;
        const pipelines = await this.pipelines;
        await this.lock.acquire();
        await device.queue.onSubmittedWorkDone();
        // inputs
        const frameStart = performance.now();
        bufferMapper.meta.setUserInput(
            this.userInput.appliedForce,
            this.userInput.mousePos.mult(this.boundsSize),
            this.userInput.mousePos.sub(this.userInput.lastMouse).mult(this.currentFps * (frameStart - this.userInput.lastFrame) / 1000 * this.boundsSize),
            this.userInput.mouseActive
        );
        bufferMapper.meta.writeUserInput(device.queue, buffers.metadata);
        this.userInput.lastMouse = this.userInput.mousePos;
        this.userInput.lastFrame = frameStart;
        // compute pass then render pass with 2 draw calls
        const encoder = device.createCommandEncoder();
        // multiple subticks help stabilize and make simulation more accurate
        const computePass = encoder.beginComputePass({
            label: import.meta.env.DEV ? 'Engine compute pass' : undefined
        });
        computePass.setPipeline(pipelines.computeUpdate);
        // using this will break if new particles/beams are added by the compute shader
        // const numWorkgroups = Math.ceil(Math.max(bufferMapper.meta.particleCount, bufferMapper.meta.beamCount) / this.workgroupSize);
        const numWorkgroups = Math.ceil(Math.max(bufferMapper.maxParticles, bufferMapper.maxBeams) / this.workgroupSize);
        for (let i = 0; i < this.subticks; i++) {
            // alternating bind groups - read from one buffer and write to the other (fixes collision asymmetry)
            if (i % 2 == 0) computePass.setBindGroup(0, bindGroups.computeA.group);
            else computePass.setBindGroup(0, bindGroups.computeB.group);
            // computePass.dispatchWorkgroupsIndirect()
            // computePass.dispatchWorkgroupsIndirect()
            // computePass.dispatchWorkgroupsIndirect()
            // computePass.dispatchWorkgroupsIndirect()
            // computePass.dispatchWorkgroupsIndirect()
            // computePass.dispatchWorkgroupsIndirect()
            computePass.dispatchWorkgroups(numWorkgroups, 1, 1);
        }
        // anything that should be deleted is deleted afterward to avoid shuffling around in other threads' data
        computePass.setPipeline(pipelines.computeDelete);
        computePass.dispatchWorkgroups(1, 1, 1);
        computePass.end();
        const renderPass = encoder.beginRenderPass({
            label: import.meta.env.DEV ? 'Render pass' : undefined,
            colorAttachments: [{
                view: this.ctx.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: this.blur }
            }]
        });
        renderPass.setPipeline(pipelines.renderParticles);
        renderPass.setVertexBuffer(0, buffers.particlesA);
        renderPass.setIndexBuffer(buffers.mapping, 'uint16', 0, bufferMapper.maxParticles *  Uint16Array.BYTES_PER_ELEMENT);
        renderPass.drawIndexedIndirect(buffers.metadata, 0);
        renderPass.setPipeline(pipelines.renderBeams);
        renderPass.setVertexBuffer(0, buffers.beams);
        renderPass.setBindGroup(0, bindGroups.renderBeams.group);
        renderPass.setIndexBuffer(buffers.mapping, 'uint16', bufferMapper.maxParticles * Uint16Array.BYTES_PER_ELEMENT, bufferMapper.maxBeams *  Uint16Array.BYTES_PER_ELEMENT);
        renderPass.drawIndexedIndirect(buffers.metadata, 20);
        renderPass.end();
        // submit
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        this.lock.release();
        // framerate stuff
        const now = performance.now();
        this.frameTimes.push(now);
        while (this.frameTimes[0] + 1000 < now) this.frameTimes.shift();
        this.fpsHistory.push(this.frameTimes.length);
        this.postMessage(WGPUSoftbodyEngineMessageTypes.FRAMERATE, this.currentFps);
    }
    get currentFps(): number {
        return this.frameTimes.length;
    }
    private async startDraw(): Promise<void> {
        while (this.running) {
            await new Promise<void>((resolve) => {
                if (this.visible) requestAnimationFrame(async () => {
                    await this.frame();
                    resolve();
                });
                else setTimeout(() => resolve(), 100);
            });
        }
    }

    async destroy() {
        this.running = false;
        (await this.device).destroy();
        self.removeEventListener('message', this.onMessageWrapper);
        this.postMessage(WGPUSoftbodyEngineMessageTypes.DESTROY);
        WGPUSoftbodyEngineWorker.sInstance = null;
    }
}

self.onmessage = (e) => {
    if (e.data.type == WGPUSoftbodyEngineMessageTypes.INIT) {
        WGPUSoftbodyEngineWorker.create(e.data.data.canvas, e.data.data.options);
        self.onmessage = null;
    }
};
