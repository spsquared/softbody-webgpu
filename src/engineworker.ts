class WGPUSoftbodyEngineWorker {
    private static instance: WGPUSoftbodyEngineWorker | null = null;

    static create(canvas: OffscreenCanvas): WGPUSoftbodyEngineWorker {
        return WGPUSoftbodyEngineWorker.instance = new WGPUSoftbodyEngineWorker(canvas);
    }

    private canvas: OffscreenCanvas;
    private ctx: GPUCanvasContext;

    private constructor(canvas: OffscreenCanvas) {
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
        if (this.ctx === null) throw new TypeError('WebGPU not supported');
        self.addEventListener('message', (e) => {
            
        });
    }
}

self.onmessage = (e) => {
    WGPUSoftbodyEngineWorker.create(e.data as OffscreenCanvas);
}