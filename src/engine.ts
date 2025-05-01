import { Vector2D } from "./engineMapping";

export enum WGPUSoftbodyEngineMessageTypes {
    INPUT,
    VISIBILITY_CHANGE,
    SNAPSHOT_SAVE,
    SNAPSHOT_LOAD,
    FRAMERATE
}

export class WGPUSoftbodyEngine {
    readonly resolution: number;
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly simCanvas: HTMLCanvasElement;

    private readonly worker: Worker;

    constructor(canvas: HTMLCanvasElement, resolution: number) {
        this.resolution = resolution;
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
        this.canvas.width = this.resolution;
        this.canvas.height = this.resolution;
        this.simCanvas = document.createElement('canvas');
        const offscreen = this.simCanvas.transferControlToOffscreen();
        offscreen.width = this.resolution;
        offscreen.height = this.resolution;
        this.worker = new Worker(new URL('./engineWorker', import.meta.url), { type: 'module' });
        this.worker.postMessage(offscreen, [offscreen]);
        this.worker.addEventListener('error', (err) => { throw err.error; });
        this.worker.addEventListener('message', (e) => this.onMessage(e));
        document.addEventListener('visibilitychange', () => this.postMessage(WGPUSoftbodyEngineMessageTypes.VISIBILITY_CHANGE, document.hidden));
        this.postMessage(WGPUSoftbodyEngineMessageTypes.VISIBILITY_CHANGE, document.hidden);
        this.startDraw();
    }

    private postMessage(type: WGPUSoftbodyEngineMessageTypes, data?: any, transfers?: Transferable[]) {
        this.worker.postMessage({
            type: type,
            data: data
        }, { transfer: transfers });
    }
    private async onMessage(e: MessageEvent) {
        // more scuffed blocks
        switch (e.data.type) {
            case WGPUSoftbodyEngineMessageTypes.FRAMERATE: {
                this.fps = e.data.data;
            }
                break;
        }
    }

    setUserInput(appliedForce: Vector2D, mousePos: Vector2D, mouseActive: boolean): void {
        this.postMessage(WGPUSoftbodyEngineMessageTypes.INPUT, [appliedForce, mousePos, mouseActive]);
    }

    async saveSnapshot(): Promise<ArrayBuffer> {
        return await new Promise<ArrayBuffer>((resolve) => {
            const listener = (e: MessageEvent) => {
                if (e.data.type == WGPUSoftbodyEngineMessageTypes.SNAPSHOT_SAVE) {
                    resolve(e.data.data);
                    this.worker.removeEventListener('message', listener);
                }
            };
            this.worker.addEventListener('message', listener);
            this.postMessage(WGPUSoftbodyEngineMessageTypes.SNAPSHOT_SAVE);
        });
    }
    async loadSnapshot(buf: ArrayBuffer): Promise<void> {
        return await new Promise<void>((resolve) => {
            const listener = (e: MessageEvent) => {
                if (e.data.type == WGPUSoftbodyEngineMessageTypes.SNAPSHOT_LOAD) {
                    resolve();
                    this.worker.removeEventListener('message', listener);
                }
            };
            this.worker.addEventListener('message', listener);
            this.postMessage(WGPUSoftbodyEngineMessageTypes.SNAPSHOT_LOAD, buf, [buf]);
        });
    }

    private fps: number = 0;
    private async startDraw(): Promise<never> {
        while (true) {
            await new Promise<void>((resolve) => {
                if (!document.hidden) window.requestAnimationFrame(async () => {
                    this.ctx.drawImage(this.simCanvas, 0, 0);
                    this.ctx.fillStyle = '#FFFFFF';
                    this.ctx.font = '14px monospace';
                    this.ctx.textAlign = 'left';
                    this.ctx.textBaseline = 'top';
                    this.ctx.fillText(`FPS: ${this.fps}`, 8, 8);
                    resolve();
                });
                else setTimeout(resolve, 100);
            });
        }
    }
}