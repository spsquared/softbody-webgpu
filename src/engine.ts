import { Vector2D } from "./engineMapping";

export enum WGPUSoftbodyEngineMessageTypes {
    INPUT,
    VISIBILITY_CHANGE
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
        document.addEventListener('visibilitychange', () => this.postMessage(WGPUSoftbodyEngineMessageTypes.VISIBILITY_CHANGE, document.hidden));
        this.postMessage(WGPUSoftbodyEngineMessageTypes.VISIBILITY_CHANGE, document.hidden);
        this.startDraw();
    }

    private async startDraw(): Promise<never> {
        while (true) {
            await new Promise<void>((resolve) => {
                if (!document.hidden) window.requestAnimationFrame(async () => {
                    this.ctx.drawImage(this.simCanvas, 0, 0);
                    resolve();
                });
                else setTimeout(resolve, 100);
            });
        }
    }

    private postMessage(type: WGPUSoftbodyEngineMessageTypes, data: any) {
        this.worker.postMessage({
            type: type,
            data: data
        });
    }

    setUserInput(appliedForce: Vector2D, mousePos: Vector2D, mouseActive: boolean): void {
        this.postMessage(WGPUSoftbodyEngineMessageTypes.INPUT, [appliedForce, mousePos, mouseActive]);
    }
}