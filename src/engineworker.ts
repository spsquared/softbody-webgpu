/// <reference types="@webgpu/types" />

import { Beam, BufferMapper, Particle } from './engineMapping';

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

    private readonly modules: Promise<{
        readonly compute: GPUShaderModule
        readonly render: GPUShaderModule
    }>;

    private readonly bufferMapper: Promise<BufferMapper>;
    private readonly buffers: Promise<{
        readonly particles: GPUBuffer,
        readonly beams: GPUBuffer,
        readonly mapping: GPUBuffer
    }>;
    private readonly bindGroups: Promise<{
        readonly compute: BindGroupPair
        readonly beamRender: BindGroupPair
    }>;
    private readonly pipelines: Promise<{
        readonly compute: GPUComputePipeline,
        readonly renderParticles: GPURenderPipeline
        readonly renderBeams: GPURenderPipeline
    }>;

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
            const gpu = await ad.requestDevice();
            this.ctx.configure({
                device: gpu,
                format: this.textureFormat
            });
            resolve(gpu);
        });
        // create buffers
        this.bufferMapper = new Promise<BufferMapper>(async (resolve) => {
            const ad = await adapter;
            if (ad === null) throw new TypeError('GPU adapter not available');
            console.log(ad.limits)
            resolve(new BufferMapper(ad.limits.maxBufferSize));
        });
        this.modules = new Promise(async (resolve) => {
            const device = await this.device;
            resolve({
                compute: device.createShaderModule({
                    label: 'Physics compute shader',
                    code: await (await fetch('./particleCompute.wgsl')).text()
                }),
                render: device.createShaderModule({
                    label: 'Particle render shader',
                    code: await (await fetch('./particleRender.wgsl')).text()
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
                    }
                ]
            });
            const beamRenderBindGroupLayout = device.createBindGroupLayout({
                entries: [
                    {
                        binding: 0,
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
                        ]
                    })
                },
                beamRender: {
                    layout: beamRenderBindGroupLayout,
                    group: device.createBindGroup({
                        label: 'Beam render bind group',
                        layout: beamRenderBindGroupLayout,
                        entries: [
                            {
                                binding: 0,
                                resource: {
                                    label: 'Particle buffer binding',
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
                        constants: {}
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
                        constants: {},
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
                        targets: [
                            {
                                format: this.textureFormat,
                                // blending moment
                            }
                        ]
                    },
                    primitive: {
                        topology: 'triangle-strip',
                        stripIndexFormat: 'uint16'
                    }
                }),
                renderBeams: await device.createRenderPipelineAsync({
                    label: 'Particle render pipeline',
                    layout: device.createPipelineLayout({
                        label: 'Particle render pipeline layout',
                        bindGroupLayouts: [bindGroups.beamRender.layout]
                    }),
                    vertex: {
                        module: modules.render,
                        entryPoint: 'vertex_beam_main',
                        constants: {},
                        buffers: [
                            {
                                arrayStride: Beam.stride,
                                attributes: [
                                    {
                                        shaderLocation: 0,
                                        format: 'uint16',
                                        offset: 0
                                    },
                                    {
                                        shaderLocation: 1,
                                        format: 'uint16',
                                        offset: 2
                                    }
                                ],
                                stepMode: 'instance'
                            }
                        ]
                    },
                    fragment: {
                        module: modules.render,
                        entryPoint: 'fragment_beam_main',
                        targets: [
                            {
                                format: this.textureFormat,
                                // blending moment
                            }
                        ]
                    },
                    primitive: {
                        topology: 'triangle-strip',
                        stripIndexFormat: 'uint16'
                    }
                })
            })
        });
        self.addEventListener('message', (e) => {

        });
        this.beginLoop();
    }

    // rendering of particles will be done using billboards created through instancing
    // rendering of beams done using lines and also through instancing

    // don't need bind groups if no storage buffers in render pipeline

    // render pipelines can have multiple buffers but primitive types are different!! multiple pipelines!

    // use mapping buffer as index buffer?
    // having the "empty" value be 0xffff effectively makes the vertex shader never create primitives for those

    // don't need index buffer, just use instancing (and if particle doesn't exist delete it)

    private frame(): void {
    }

    private async beginLoop(): Promise<void> {
        while (true) {
            await new Promise<void>((resolve) => {
                requestAnimationFrame(() => this.frame());
            });
        }
    }
}

self.onmessage = (e) => {
    WGPUSoftbodyEngineWorker.create(e.data as OffscreenCanvas);
    self.onmessage = null;
};