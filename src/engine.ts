/// <reference types="@webgpu/types" />

import { Vector2D } from "./engineMapping";

export enum WGPUSoftbodyEngineMessageTypes {
    INIT,
    DESTROY,
    PHYSICS_CONSTANTS,
    GET_PHYSICS_CONSTANTS,
    INPUT,
    VISIBILITY_CHANGE,
    SNAPSHOT_SAVE,
    SNAPSHOT_LOAD,
    FRAMERATE
}

export type WGPUSoftbodyEngineOptions = {
    readonly particleRadius: number
    readonly subticks: number
};

export type WGPUSoftbodyEnginePhysicsConstants = {
    readonly gravity: Vector2D
    readonly borderElasticity: number
    readonly borderFriction: number
    readonly elasticity: number
    readonly friction: number
    readonly dragCoeff: number
    readonly dragExp: number
}

export class WGPUSoftbodyEngine {
    readonly resolution: number;
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly simCanvas: HTMLCanvasElement;

    private readonly worker: Worker;

    private readonly userInput = {
        appliedForce: new Vector2D(0, 0),
        rawMousePos: new Vector2D(0, 0),
        mouseActive: false,
        touchActive: false
    };
    private readonly heldKeys: Record<string, number> = {};
    private sendUserInput = ((fn) => {
        let timeout: NodeJS.Timeout = setTimeout(() => { });
        let lastUpdate = 0;
        return () => {
            clearTimeout(timeout);
            if (performance.now() - lastUpdate >= 10) {
                fn();
                lastUpdate = performance.now();
            } else {
                timeout = setTimeout(() => {
                    fn();
                    lastUpdate = performance.now();
                }, 10 - performance.now() + lastUpdate);
            }
        };
    })(() => {
        this.postMessageWithAck(WGPUSoftbodyEngineMessageTypes.INPUT, undefined, [this.userInput.appliedForce, this.userInput.rawMousePos, this.userInput.mouseActive || this.userInput.touchActive]);
    });
    private updateMouse(e: MouseEvent | Touch) {
        const rect = this.canvas.getBoundingClientRect();
        this.userInput.rawMousePos = new Vector2D((e.clientX - rect.x) / rect.width, 1 - (e.clientY - rect.y) / rect.height);
        this.sendUserInput();
    }
    private updateKeyboard() {
        this.userInput.appliedForce = new Vector2D(
            (this.heldKeys['d'] ?? 0) - (this.heldKeys['a'] ?? 0),
            (this.heldKeys['w'] ?? 0) - (this.heldKeys['s'] ?? 0)
        );
        this.sendUserInput();
    }
    private readonly listeners: Partial<{ [E in keyof DocumentEventMap]: ((ev: DocumentEventMap[E]) => any) | [(ev: DocumentEventMap[E]) => any, AddEventListenerOptions] }> = {
        mousedown: (e) => {
            if (e.button == 0) this.userInput.mouseActive = true;
            this.updateMouse(e);
        },
        mouseup: (e) => {
            if (e.button == 0) this.userInput.mouseActive = false;
            this.updateMouse(e);
        },
        mousemove: (e) => {
            this.updateMouse(e);
        },
        touchstart: (e) => {
            this.userInput.touchActive = true;
            this.updateMouse(e.touches[0]);
        },
        touchend: () => {
            this.userInput.touchActive = false;
            this.sendUserInput();
        },
        touchcancel: () => {
            this.userInput.touchActive = false;
            this.sendUserInput();
        },
        touchmove: [(e) => {
            this.updateMouse(e.touches[0]);
            e.preventDefault();
        }, { passive: false }],
        keydown: (e) => {
            if (e.target instanceof HTMLElement && e.target.matches('input,button,textarea,select')) return;
            this.heldKeys[e.key.toLowerCase()] = 1;
            this.updateKeyboard();
        },
        keyup: (e) => {
            this.heldKeys[e.key.toLowerCase()] = 0;
            this.updateKeyboard();
        },
        blur: () => {
            this.userInput.mouseActive = false;
            this.updateKeyboard();
        }
    };

    constructor(canvas: HTMLCanvasElement, resolution: number, opts?: Partial<WGPUSoftbodyEngineOptions>) {
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
        this.worker.addEventListener('error', (err) => { throw err.error ?? new Error(err.message ?? 'Error in engine worker'); });
        this.worker.addEventListener('message', (e) => this.onMessage(e));
        this.postMessage(WGPUSoftbodyEngineMessageTypes.INIT, { canvas: offscreen, options: opts }, [offscreen]);
        document.addEventListener('visibilitychange', () => this.postMessage(WGPUSoftbodyEngineMessageTypes.VISIBILITY_CHANGE, document.hidden));
        this.postMessage(WGPUSoftbodyEngineMessageTypes.VISIBILITY_CHANGE, document.hidden);
        this.startDraw();
        for (const ev in this.listeners) {
            if (Array.isArray(this.listeners[ev]))
                document.addEventListener(ev, this.listeners[ev][0], this.listeners[ev][1]);
            else
                document.addEventListener(ev, this.listeners[ev]);
        }
    }

    private postMessage(type: WGPUSoftbodyEngineMessageTypes, data?: any, transfers?: Transferable[]) {
        this.worker.postMessage({
            type: type,
            data: data
        }, { transfer: transfers });
    }
    private async postMessageWithAck<T>(type: WGPUSoftbodyEngineMessageTypes, responseType?: WGPUSoftbodyEngineMessageTypes, data?: any, transfers?: Transferable[]): Promise<T> {
        const resType = responseType ?? type;
        return await new Promise<T>((resolve) => {
            const listener = (e: MessageEvent) => {
                if (e.data.type == resType) {
                    resolve(e.data.data);
                    this.worker.removeEventListener('message', listener);
                }
            };
            this.worker.addEventListener('message', listener);
            this.postMessage(type, data, transfers);
        });
    }
    private async onMessage(e: MessageEvent) {
        // more scuffed blocks
        switch (e.data.type) {
            case WGPUSoftbodyEngineMessageTypes.FRAMERATE: {
                this.fps = e.data.data;
            }
                break;
            case WGPUSoftbodyEngineMessageTypes.DESTROY: {
                this.worker.terminate();
            }
                break;
        }
    }
    async setPhysicsConstants(constants: WGPUSoftbodyEnginePhysicsConstants): Promise<void> {
        await this.postMessageWithAck(WGPUSoftbodyEngineMessageTypes.PHYSICS_CONSTANTS, undefined, constants);
    }
    async getPhysicsConstants(): Promise<WGPUSoftbodyEnginePhysicsConstants> {
        return await this.postMessageWithAck<WGPUSoftbodyEnginePhysicsConstants>(WGPUSoftbodyEngineMessageTypes.GET_PHYSICS_CONSTANTS, WGPUSoftbodyEngineMessageTypes.PHYSICS_CONSTANTS);
    }

    async saveSnapshot(): Promise<ArrayBuffer> {
        return await this.postMessageWithAck<ArrayBuffer>(WGPUSoftbodyEngineMessageTypes.SNAPSHOT_SAVE);
    }
    async loadSnapshot(buf: ArrayBuffer): Promise<boolean> {
        return await this.postMessageWithAck<boolean>(WGPUSoftbodyEngineMessageTypes.SNAPSHOT_LOAD, undefined, buf);
    }

    private running: boolean = true;
    private fps: number = 0;
    private async startDraw(): Promise<void> {
        while (this.running) {
            await new Promise<void>((resolve) => {
                if (!document.hidden) window.requestAnimationFrame(async () => {
                    this.ctx.resetTransform();
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

    destroy() {
        this.running = false;
        this.postMessage(WGPUSoftbodyEngineMessageTypes.DESTROY);
        for (const ev in this.listeners) {
            if (Array.isArray(this.listeners[ev]))
                document.removeEventListener(ev, this.listeners[ev][0], this.listeners[ev][1]);
            else
                document.removeEventListener(ev, this.listeners[ev]);
        }
    }
}
