import { BufferMapper } from './engineMapping';

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

    private readonly modules: {
        readonly compute: Promise<GPUShaderModule>
        readonly render: Promise<GPUShaderModule>
    };

    private readonly bufferMapper: Promise<BufferMapper>;
    private readonly gpuBuffers: Promise<{
        particles: GPUBuffer,
        beams: GPUBuffer,
        mapping: GPUBuffer
    }>;
    private readonly bindingGroups: Promise<{

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
        this.gpuBuffers = new Promise(async (resolve) => {
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
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
                })
            });
        });
        // set up pipeline after devices attained
        this.modules = {
            compute: this.device.then(async (device) => device.createShaderModule({
                label: 'Physics compute shader',
                code: await (await fetch('./particleCompute.wgsl')).text()
            })),
            render: this.device.then(async (device) => device.createShaderModule({
                label: 'Particle render shader',
                code: await (await fetch('./particleRender.wgsl')).text()
            }))
        };
        this.compileShaders();
        self.addEventListener('message', (e) => {

        });
    }

    private async compileShaders(): Promise<void> {
        const device = await this.device;
        const buffers = await this.gpuBuffers;
        const computeBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {
                        type: 'storage'
                    }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {
                        type: 'storage'
                    }
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: {
                        type: 'read-only-storage'
                    }
                }
            ]
        });
        const renderBindGroupLayout  = device.createBindGroupLayout({
            entries: [

            ]
        });
        // rendering of particles will be done using billboards created through instancing
        // rendering of beams done using lines and also through instancing

        // don't need bind groups if no storage buffers in render pipeline

        // render pipelines can have multiple buffers but primitive types are different!! multiple pipelines!

        // use mapping buffer as index buffer?
        // having the "empty" value be 0xffff effectively makes the vertex shader never create primitives for those
    }

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