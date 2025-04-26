/// <reference types="@webgpu/types" />                                                                                                                                                        

import { Beam, BufferMapper, Particle, Vector2D } from './engineMapping';

type BindGroupPair = { readonly layout: GPUBindGroupLayout, readonly group: GPUBindGroup };

class WGPUSoftbodyEngineWorker {
    private static sInstance: WGPUSoftbodyEngineWorker | null = null;

    static create(canvas: OffscreenCanvas): WGPUSoftbodyEngineWorker {
        return WGPUSoftbodyEngineWorker.sInstance = new WGPUSoftbodyEngineWorker(canvas);
    }

    static instance(): WGPUSoftbodyEngineWorker | null {
        return WGPUSoftbodyEngineWorker.sInstance;
    }

    private readonly canvas: OffscreenCanvas;
    private readonly ctx: GPUCanvasContext;
    private readonly device: Promise<GPUDevice>;
    private readonly textureFormat: GPUTextureFormat;

    private readonly gridSize: number = 1000;
    private readonly particleRadius: number = 100;
    private readonly subticks: number = 10;

    private readonly numWorkgroups = 64;

    private readonly modules: Promise<{
        readonly compute: GPUShaderModule
        readonly render: GPUShaderModule
    }>;

    private readonly bufferMapper: Promise<BufferMapper>;
    private readonly buffers: Promise<{
        readonly particles: GPUBuffer
        readonly beams: GPUBuffer
        readonly mapping: GPUBuffer
        readonly metadata: GPUBuffer
    }>;
    private readonly bindGroups: Promise<{
        readonly compute: BindGroupPair
        readonly renderBeams: BindGroupPair
    }>;
    private readonly pipelines: Promise<{
        readonly compute: GPUComputePipeline
        readonly renderParticles: GPURenderPipeline
        readonly renderBeams: GPURenderPipeline
    }>;

    private readonly blur: number = 0.1;

    private readonly frameTimes: number[] = [];
    private readonly fpsHistory: number[] = [];

    private constructor(canvas: OffscreenCanvas) {
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
        if (this.ctx === null) throw new TypeError('WebGPU not supported');
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
                alphaMode: 'premultiplied'
            });
            console.log('GPU limits', gpu.limits);
            resolve(gpu);
        });
        // create buffers
        this.bufferMapper = new Promise<BufferMapper>(async (resolve) => {
            const ad = await adapter;
            if (ad === null) throw new TypeError('GPU adapter not available');
            resolve(new BufferMapper(ad.limits.maxBufferSize));
        });
        this.modules = new Promise(async (resolve) => {
            const device = await this.device;
            resolve({
                compute: device.createShaderModule({
                    label: 'Physics compute shader',
                    code: await (await fetch(new URL('./shaders/compute.wgsl', import.meta.url))).text()
                }),
                render: device.createShaderModule({
                    label: 'Particle render shader',
                    code: await (await fetch(new URL('./shaders/render.wgsl', import.meta.url))).text()
                })
            });
        });
        this.buffers = new Promise(async (resolve) => {
            const device = await this.device;
            const mapper = await this.bufferMapper;
            resolve({
                particles: device.createBuffer({
                    label: 'Particle data buffer',
                    size: mapper.particleData.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                beams: device.createBuffer({
                    label: 'Beam data buffer',
                    size: mapper.beamData.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                mapping: device.createBuffer({
                    label: 'Mapping buffer',
                    size: mapper.mapping.byteLength,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                }),
                metadata: device.createBuffer({
                    label: 'Metadata buffer',
                    size: mapper.metadata.byteLength,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                })
            });
        });
        this.bindGroups = new Promise(async (resolve) => {
            const device = await this.device;
            const buffers = await this.buffers;
            const computeBindGroupLayout = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' }
                    },
                    {
                        binding: 1,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'storage' }
                    },
                    {
                        binding: 2,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'read-only-storage' }
                    },
                    {
                        binding: 3,
                        visibility: GPUShaderStage.COMPUTE,
                        buffer: { type: 'uniform' }
                    }
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
            resolve({
                compute: {
                    layout: computeBindGroupLayout,
                    group: device.createBindGroup({
                        label: 'Compute bind group',
                        layout: computeBindGroupLayout,
                        entries: [
                            {
                                binding: 0,
                                resource: {
                                    label: 'Particle buffer binding',
                                    buffer: buffers.particles
                                }
                            },
                            {
                                binding: 1,
                                resource: {
                                    label: 'Beam buffer binding',
                                    buffer: buffers.beams
                                }
                            },
                            {
                                binding: 2,
                                resource: {
                                    label: 'Mapping buffer binding',
                                    buffer: buffers.mapping
                                }
                            },
                            {
                                binding: 3,
                                resource: {
                                    label: 'Metadata buffer binding',
                                    buffer: buffers.metadata
                                }
                            }
                        ]
                    })
                },
                renderBeams: {
                    layout: renderBindGroupLayout,
                    group: device.createBindGroup({
                        label: 'Render bind group',
                        layout: renderBindGroupLayout,
                        entries: [
                            {
                                binding: 1,
                                resource: {
                                    label: 'Beam buffer binding',
                                    buffer: buffers.particles
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
            // unforunately we need two render pipelines as we need two index buffers
            resolve({
                compute: await device.createComputePipelineAsync({
                    label: 'Compute pipeline',
                    layout: device.createPipelineLayout({
                        label: 'Compute pipeline layout',
                        bindGroupLayouts: [bindGroups.compute.layout]
                    }),
                    compute: {
                        module: modules.compute,
                        entryPoint: 'compute_main',
                        constants: {
                            grid_size: this.gridSize,
                            particle_radius: this.particleRadius,
                            time_step: 1 / this.subticks
                        }
                    }
                }),
                renderParticles: await device.createRenderPipelineAsync({
                    label: 'Particle render pipeline',
                    layout: device.createPipelineLayout({
                        label: 'Particle render pipeline layout',
                        bindGroupLayouts: []
                    }),
                    vertex: {
                        module: modules.render,
                        entryPoint: 'vertex_particle_main',
                        constants: {
                            grid_size: this.gridSize,
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
                            // grid_size: this.gridSize,
                            // particle_radius: this.particleRadius
                        },
                        targets: [
                            {
                                format: this.textureFormat,
                                blend: {
                                    color: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
                                    alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }
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
                    label: 'Beam render pipeline',
                    layout: device.createPipelineLayout({
                        label: 'Beam render pipeline layout',
                        bindGroupLayouts: [bindGroups.renderBeams.layout]
                    }),
                    vertex: {
                        module: modules.render,
                        entryPoint: 'vertex_beam_main',
                        constants: {
                            grid_size: this.gridSize,
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
        self.addEventListener('message', (e) => {

        });
        this.beginDraw();
    }

    private async frame(): Promise<void> {
        const device = await this.device;
        const buffers = await this.buffers;
        const bufferMapper = await this.bufferMapper;
        const bindGroups = await this.bindGroups;
        const pipelines = await this.pipelines;
        const encoder = device.createCommandEncoder();
        const computePass = encoder.beginComputePass({
            label: 'Engine compute pass'
        });
        computePass.setPipeline(pipelines.compute);
        computePass.setBindGroup(0, bindGroups.compute.group);
        for (let i = 0; i < this.subticks; i++) computePass.dispatchWorkgroups(Math.ceil(bufferMapper.maxParticles / this.numWorkgroups), 1, 1);
        computePass.end();
        const renderPass = encoder.beginRenderPass({
            label: 'Render pass',
            colorAttachments: [{
                view: this.ctx.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: this.blur }
            }]
        });
        renderPass.setPipeline(pipelines.renderParticles);
        renderPass.setVertexBuffer(0, buffers.particles);
        renderPass.drawIndirect(buffers.metadata, 0);
        renderPass.setPipeline(pipelines.renderBeams);
        renderPass.setVertexBuffer(0, buffers.beams);
        renderPass.setBindGroup(0, bindGroups.renderBeams.group);
        renderPass.drawIndirect(buffers.metadata, 20);
        renderPass.end();
        device.queue.submit([encoder.finish()]);
        const now = performance.now();
        this.frameTimes.push(now);
        while (this.frameTimes[0] + 1000 < now) this.frameTimes.shift();
        this.fpsHistory.push(this.frameTimes.length);
    }

    get currentFps(): number {
        return this.frameTimes.length;
    }

    async loadBuffers(): Promise<void> {
        const device = await this.device;
        const buffers = await this.buffers;
        const bufferMapper = await this.bufferMapper;
        throw new Error('buh no staging buffer to read from')
    }

    async writeBuffers(): Promise<void> {
        const device = await this.device;
        const buffers = await this.buffers;
        const bufferMapper = await this.bufferMapper;
        device.queue.writeBuffer(buffers.metadata, 0, bufferMapper.metadata, 0);
        device.queue.writeBuffer(buffers.mapping, 0, bufferMapper.mapping, 0);
        device.queue.writeBuffer(buffers.particles, 0, bufferMapper.particleData, 0);
        device.queue.writeBuffer(buffers.beams, 0, bufferMapper.beamData, 0);
    }

    private async beginDraw(): Promise<void> {
        // TESTING CODE
        // TESTING CODE
        // TESTING CODE
        const bufferMapper = await this.bufferMapper;
        bufferMapper.load();
        bufferMapper.addParticle(new Particle(0, new Vector2D(500, -500), new Vector2D(-5, 10)))
        bufferMapper.addParticle(new Particle(1, new Vector2D(-500, -500), new Vector2D(0, -10)))
        // bufferMapper.addParticle(new Particle(2, new Vector2D(10, 10), new Vector2D(1, 1)))
        // bufferMapper.addParticle(new Particle(3, new Vector2D(10, 10), new Vector2D(1, 1)))
        bufferMapper.addBeam(new Beam(0, 0, 1, 100, 1, 1))
        bufferMapper.meta.gravity = 1;
        bufferMapper.save();
        await this.writeBuffers();
        // STILL TESTING CODE
        // STILL TESTING CODE
        // STILL TESTING CODE
        // console.log(new Uint32Array(bufferMapper.beamData))
        while (true) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(async () => {
                    await this.frame();
                    resolve();
                });
            });
        }
    }
}

self.onmessage = (e) => {
    WGPUSoftbodyEngineWorker.create(e.data as OffscreenCanvas);
    self.onmessage = null;
};