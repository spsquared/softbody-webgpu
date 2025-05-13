/// <reference types="@webgpu/types" />

import { WGPUSoftbodyEngineOptions } from "./engine";
import { Beam, BufferMapper, Vector2D } from "./engineMapping";

export class SoftbodyEditor {
    readonly resolution: number;
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly bufferMapper: Promise<BufferMapper>;

    private readonly userInput = {
        rawMousePos: new Vector2D(0, 0),
        mousePos: new Vector2D(0, 0),
        mouseActive: false,
        touchActive: false
    };
    private readonly heldKeys: Record<string, number> = {};
    private updateMouse(e: MouseEvent | Touch) {
        const rect = this.canvas.getBoundingClientRect();
        this.userInput.rawMousePos = new Vector2D((e.clientX - rect.x) / rect.width, 1 - (e.clientY - rect.y) / rect.height);
        this.userInput.mousePos = this.userInput.rawMousePos.mult(this.gridSize / this.camera.s).add(this.camera.p);
    }
    private updateKeyboard() {
        // buh
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
        },
        touchcancel: () => {
            this.userInput.touchActive = false;
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

    readonly camera = {
        p: new Vector2D(0, 0),
        s: 1
    };

    readonly gridSize: number = 1000;
    readonly particleRadius: number = 10;

    readonly blur: number = 0.4;

    constructor(canvas: HTMLCanvasElement, resolution: number, opts?: Partial<Omit<WGPUSoftbodyEngineOptions, 'subticks'>>) {
        this.resolution = resolution;
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
        this.canvas.width = this.resolution;
        this.canvas.height = this.resolution;
        if (opts != undefined) {
            if (opts.particleRadius !== undefined) this.particleRadius = opts.particleRadius;
        }
        // still need max buffer size so get gpu adapter
        if (navigator.gpu === undefined) throw new TypeError('WebGPU not supported');
        const adapter = navigator.gpu?.requestAdapter();
        this.bufferMapper = new Promise<BufferMapper>(async (resolve) => {
            const ad = await adapter;
            if (ad === null) throw new TypeError('GPU adapter not available');
            resolve(new BufferMapper(ad.limits.maxStorageBufferBindingSize));
        });
        document.addEventListener('visibilitychange', () => this.visible = !document.hidden);
        this.startDraw();
        for (const ev in this.listeners) {
            if (Array.isArray(this.listeners[ev]))
                document.addEventListener(ev, this.listeners[ev][0], this.listeners[ev][1]);
            else
                document.addEventListener(ev, this.listeners[ev]);
        }
    }

    async load(buf: ArrayBuffer): Promise<boolean> {
        return (await this.bufferMapper).loadSnapshotbuffer(buf);
    }
    async save(): Promise<ArrayBuffer> {
        return (await this.bufferMapper).createSnapshotBuffer();
    }

    private visible: boolean = !document.hidden;
    private readonly frameTimes: number[] = [];
    private readonly fpsHistory: number[] = [];
    private lastFrame: number = performance.now();
    private running: boolean = true;
    private async updateFrame(): Promise<void> {
        const now = performance.now();
        const deltaTime = now - this.lastFrame;
        let ocs = this.camera.s;
        let zoomed = false;
        if (this.heldKeys['[']) {
            this.camera.s /= deltaTime * 0.002 + 1;
            zoomed = true;
        }
        if (this.heldKeys[']']) {
            this.camera.s *= deltaTime * 0.002 + 1;
            zoomed = true;
        }
        if (zoomed) {
            this.camera.s = Math.max(1, Math.min(this.camera.s, 10));
            this.camera.p = this.camera.p.add(this.userInput.rawMousePos.mult(this.gridSize / ocs)).sub(this.userInput.rawMousePos.mult(this.gridSize / this.camera.s));
        }
        const speed = deltaTime * (this.heldKeys['shift'] ? 3 : 1) * 0.8;
        this.camera.p = this.camera.p.add(new Vector2D(
            ((this.heldKeys['l'] ?? 0) - (this.heldKeys['j'] ?? 0)) * speed,
            ((this.heldKeys['i'] ?? 0) - (this.heldKeys['k'] ?? 0)) * speed
        ));
        this.camera.p = this.camera.p.clamp(new Vector2D(0, 0), new Vector2D(this.gridSize - this.gridSize / this.camera.s, this.gridSize - this.gridSize / this.camera.s));
        this.lastFrame = now;
    }
    private async frame(): Promise<void> {
        const bufferMapper = await this.bufferMapper;
        this.ctx.resetTransform();
        this.ctx.fillStyle = `rgba(0, 0, 0, ${this.blur})`;
        this.ctx.fillRect(0, 0, this.resolution, this.resolution);
        // transform to simulation space
        const scale = this.resolution / this.gridSize;
        this.ctx.transform(scale, 0, 0, -scale, 0, this.resolution);
        // camera transform on top
        this.ctx.transform(this.camera.s, 0, 0, this.camera.s, -this.camera.p.x * this.camera.s, -this.camera.p.y * this.camera.s);
        // particles
        const particles = bufferMapper.particleSet;
        this.ctx.fillStyle = `rgba(${0 * 255}, ${0.7 * 255}, ${1 * 255}, 0.5)`;
        this.ctx.strokeStyle = `rgba(${1 * 255}, ${1 * 255}, ${1 * 255}, 1.0)`;
        const r = this.particleRadius * 0.9; // n/2 + 0.5
        this.ctx.lineWidth = this.particleRadius * 0.2 * scale; // (1 - n) * r / w * s
        this.ctx.beginPath();
        for (const p of particles) {
            this.ctx.moveTo(p.position.x + r, p.position.y);
            this.ctx.arc(p.position.x, p.position.y, r, 0, 2 * Math.PI);
        }
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.strokeStyle = '#FF0000';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        for (const p of particles) {
            // particles don't really have acceleration as it's reset every frame
            this.ctx.moveTo(p.position.x, p.position.y);
            this.ctx.lineTo(p.position.x + p.velocity.x, p.position.y + p.velocity.y);
        }
        this.ctx.stroke();
        // beams (will have stress color at some point)
        const beams = bufferMapper.beamSet;
        this.ctx.strokeStyle = `rgba(${1 * 255}, ${1 * 255}, ${1 * 255}, 1.0)`;
        this.ctx.lineWidth = 1;
        const invalidBeams = new Set<Beam>();
        this.ctx.beginPath();
        for (const b of beams) {
            const p1 = typeof b.a == 'number' ? bufferMapper.findParticle(b.a) : b.a;
            const p2 = typeof b.b == 'number' ? bufferMapper.findParticle(b.b) : b.b;
            if (p1 == null || p2 == null) invalidBeams.add(b);
            else {
                this.ctx.moveTo(p1.position.x, p1.position.y);
                this.ctx.lineTo(p2.position.x, p2.position.y);
                // wtf text
            }
        }
        this.ctx.stroke();
        // return to canvas space
        this.ctx.resetTransform();
        // framerate stuff
        const now = performance.now();
        this.frameTimes.push(now);
        while (this.frameTimes[0] + 1000 < now) this.frameTimes.shift();
        this.fpsHistory.push(this.frameTimes.length);
        this.ctx.fillStyle = '#FFFFFF';
        this.ctx.font = '14px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText(`FPS: ${this.fps}`, 8, 8);

    }
    get fps(): number {
        return this.frameTimes.length;
    }
    private async startDraw(): Promise<void> {
        while (this.running) {
            await new Promise<void>((resolve) => {
                if (this.visible) requestAnimationFrame(async () => {
                    await this.updateFrame();
                    await this.frame();
                    resolve();
                });
                else setTimeout(() => resolve(), 100);
            });
        }
    }

    destroy() {
        this.running = false;
        for (const ev in this.listeners) {
            if (Array.isArray(this.listeners[ev]))
                document.removeEventListener(ev, this.listeners[ev][0], this.listeners[ev][1]);
            else
                document.removeEventListener(ev, this.listeners[ev]);
        }
    }
}
