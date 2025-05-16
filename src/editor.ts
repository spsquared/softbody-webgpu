/// <reference types="@webgpu/types" />

import { WGPUSoftbodyEngineOptions } from "./engine";
import { Beam, BufferMapper, Particle, Vector2D } from "./engineMapping";

export class SoftbodyEditor {
    readonly resolution: number;
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly bufferMapper: Promise<BufferMapper>;

    private readonly userInput = {
        rawMousePos: new Vector2D(0, 0),
        mousePos: new Vector2D(0, 0),
        lastMousePos: new Vector2D(0, 0),
        mouseInGrid: false
    };
    private readonly heldKeys: Set<string> = new Set();
    private updateMouse(e: MouseEvent | Touch) {
        const rect = this.canvas.getBoundingClientRect();
        this.userInput.rawMousePos = new Vector2D((e.clientX - rect.x) / rect.width, 1 - (e.clientY - rect.y) / rect.height);
        this.userInput.mousePos = this.userInput.rawMousePos.mult(this.gridSize / this.camera.s).add(this.camera.p);
        this.userInput.mouseInGrid = this.userInput.rawMousePos.x >= 0 && this.userInput.rawMousePos.x <= 1 && this.userInput.rawMousePos.y >= 0 && this.userInput.rawMousePos.y <= 1;
    }
    private updateKeyboard() {
        this.action.deleteMode = this.heldKeys.has('shift');
        this.action.forceAddMode = this.heldKeys.has('alt');
    }
    private readonly listeners: Partial<{ [E in keyof DocumentEventMap]: ((ev: DocumentEventMap[E]) => any) | [(ev: DocumentEventMap[E]) => any, AddEventListenerOptions] }> = {
        mousedown: (e) => {
            this.updateMouse(e);
            if (e.target instanceof HTMLElement && e.target.matches('input,button,textarea,select')) return;
            this.startAction();
        },
        mouseup: (e) => {
            this.updateMouse(e);
            this.endAction();
        },
        mousemove: (e) => {
            this.updateMouse(e);
        },
        touchstart: (e) => {
            this.updateMouse(e.touches[0]);
            if (e.target instanceof HTMLElement && e.target.matches('input,button,textarea,select')) return;
            this.startAction();
        },
        touchend: () => {
            this.endAction();
        },
        touchcancel: () => {
            this.endAction();
        },
        touchmove: [(e) => {
            this.updateMouse(e.touches[0]);
            e.preventDefault();
        }, { passive: false }],
        keydown: (e) => {
            if (e.target instanceof HTMLElement && e.target.matches('input[type=text],input[type=number],button,textarea,select')) return;
            if (e.key == 'Alt') e.preventDefault();
            this.heldKeys.add(e.key.toLowerCase());
            this.updateKeyboard();
        },
        keyup: (e) => {
            if (e.key == 'Alt') e.preventDefault();
            this.heldKeys.delete(e.key.toLowerCase());
            this.updateKeyboard();
        },
        blur: () => {
            console.log('buh')
            this.endAction();
            this.heldKeys.clear();
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

    // helper things
    private async getEndpoints(b: Beam): Promise<[Vector2D, Vector2D]> {
        const bufferMapper = await this.bufferMapper;
        return [
            typeof b.a == 'number' ? bufferMapper.findParticle(b.a)?.position ?? Vector2D.zero : b.a.position,
            typeof b.b == 'number' ? bufferMapper.findParticle(b.b)?.position ?? Vector2D.zero : b.b.position
        ];
    }
    private vecString(p: Vector2D): string {
        return `<${Math.round(p.x)}, ${Math.round(p.y)}>`;
    }

    private visible: boolean = !document.hidden;
    private readonly frameTimes: number[] = [];
    private readonly fpsHistory: number[] = [];
    private lastFrame: number = performance.now();
    private running: boolean = true;
    private readonly action: {
        // currently hovered particle - used to select what particle to move
        hoverParticle: Particle | null
        // particle being modified (moving/adding beam to)
        activeParticle: Particle | null
        // adding particle allows setting velocity, so this is needed
        activeParticleType: 'add' | 'move'
        // currently hovered beam
        hoverBeam: Beam | null
        // beam being created - particle A is existing particle, particle B is new particle (is deleted if ended on another particle)
        activeBeam: Beam | null
        // mode (switching modes should cancel the current action)
        mode: 'particle' | 'beam'
        // self-explanatory
        deleteMode: boolean
        // if want to add but game wants to hover over some particle
        forceAddMode: boolean
        // settings for new beams
        beamSettings: {
            spring: number,
            damp: number
        },
        // automatically create beams within a certain distance to triangulate things
        autoTriangulate: boolean
    } = {
            hoverParticle: null,
            activeParticle: null,
            activeParticleType: 'add',
            hoverBeam: null,
            activeBeam: null,
            mode: 'beam',
            deleteMode: false,
            forceAddMode: false,
            beamSettings: {
                spring: 0,
                damp: 0
            },
            autoTriangulate: false
        };
    private async startAction(): Promise<void> {
        const bufferMapper = await this.bufferMapper;
        // target particle or something
        if (this.action.mode == 'particle') {
            if (this.action.deleteMode) {
                // deletey deleters
                if (this.action.hoverParticle != null) {
                    bufferMapper.removeParticle(this.action.hoverParticle);
                    for (const b of bufferMapper.getConnectedBeams(this.action.hoverParticle)) {
                        bufferMapper.removeBeam(b);
                    }
                    this.action.hoverParticle = null;
                }
            } else if (this.action.hoverParticle != null) {
                // move
                this.action.activeParticle = this.action.hoverParticle;
                this.action.activeParticleType = 'move';
            } else if (this.action.hoverParticle == null || this.action.forceAddMode) {
                // add particle (but only if mouse on grid)
                if (this.userInput.mouseInGrid) {
                    this.action.activeParticle = new Particle(bufferMapper.firstEmptyParticleId, this.userInput.mousePos);
                    bufferMapper.addParticle(this.action.activeParticle);
                    this.action.activeParticleType = 'add';
                }
            }
        } else if (this.action.mode == 'beam') {
            // hovering particle has priority over hovering beam to make adding stuff easier
            if (this.action.deleteMode) {
                // delete
                if (this.action.hoverBeam != null) {
                    bufferMapper.removeBeam(this.action.hoverBeam);
                    this.action.hoverBeam = null;
                }
            } else if (this.action.hoverParticle != null && !this.action.forceAddMode) {
                // add new beam from existing particle (A is existing, B is new/endpoint)
                const endpoint = new Particle(bufferMapper.firstEmptyParticleId, this.userInput.mousePos);
                bufferMapper.addParticle(endpoint);
                this.action.activeBeam = new Beam(bufferMapper.firstEmptyBeamId, this.action.hoverParticle, endpoint, 0, 0, 0);
                bufferMapper.addBeam(this.action.activeBeam);
            } else if (this.action.hoverBeam != null && !this.action.forceAddMode) {
                // apply settings
                this.action.hoverBeam.spring = this.action.beamSettings.spring;
                this.action.hoverBeam.damp = this.action.beamSettings.damp;
            } else if (this.action.hoverParticle == null || this.action.forceAddMode) {
                // add new beam from new particle (but only if mouse on grid)
                if (this.userInput.mouseInGrid) {
                    const new1 = new Particle(bufferMapper.firstEmptyParticleId, this.userInput.mousePos);
                    bufferMapper.addParticle(new1);
                    const new2 = new Particle(bufferMapper.firstEmptyParticleId, this.userInput.mousePos);
                    bufferMapper.addParticle(new2);
                    this.action.activeBeam = new Beam(bufferMapper.firstEmptyBeamId, new1, new2, 0, 0, 0);
                    bufferMapper.addBeam(this.action.activeBeam);
                }
            }
        }
    }
    private async endAction(): Promise<void> {
        const bufferMapper = await this.bufferMapper;
        if (this.action.mode == 'particle') {
            if (this.action.activeParticle != null) {
                if (this.action.activeParticleType == 'add') {
                    // set velocity
                    this.action.activeParticle.velocity = this.userInput.mousePos.sub(this.action.activeParticle.position);
                    this.action.activeParticle = null;
                } else if (this.action.activeParticleType == 'move') {
                    // stop moving
                    this.action.activeParticle = null;
                }
            }
        } else if (this.action.mode == 'beam') {
            if (this.action.activeBeam != null) {
                // finalize new beam
                if (!this.action.forceAddMode && this.action.hoverParticle != null) {
                    // place on top of existing particle (hover particle will never be active beam particle)
                    bufferMapper.removeParticle(this.action.activeBeam.b);
                    bufferMapper.removeBeam(this.action.activeBeam);
                    this.action.activeBeam = new Beam(this.action.activeBeam.id, this.action.activeBeam.a, this.action.hoverParticle, 0, 0, 0);
                    bufferMapper.addBeam(this.action.activeBeam);
                }
                // set length & settings of beam
                const [a, b] = await this.getEndpoints(this.action.activeBeam);
                this.action.activeBeam.length = a.sub(b).magnitude;
                this.action.activeBeam.lastLen = this.action.activeBeam.length;
                this.action.activeBeam.spring = this.action.beamSettings.spring;
                this.action.activeBeam.damp = this.action.beamSettings.damp;
                // stop moving
                this.action.activeBeam = null;
            }
        }
    }
    private async updateAction(): Promise<void> {
        const bufferMapper = await this.bufferMapper;
        // small margin amount around particles & beams make clicking easier
        const particleMargin = Math.max(1, 2 - (2 * this.camera.s / 10));
        const beamMargin = Math.max(4, 10 - (8 * this.camera.s / 10));
        // closest particle (remove active beam particle)
        const particles = bufferMapper.particleSet;
        if (this.action.activeBeam != null) {
            const rmA = typeof this.action.activeBeam.a == 'number' ? bufferMapper.findParticle(this.action.activeBeam.a) : this.action.activeBeam.a;
            const rmB = typeof this.action.activeBeam.b == 'number' ? bufferMapper.findParticle(this.action.activeBeam.b) : this.action.activeBeam.b;
            if (rmA != null) particles.delete(rmA);
            if (rmB != null) particles.delete(rmB);
        }
        if (this.action.activeParticle != null) particles.delete(this.action.activeParticle);
        this.action.hoverParticle = null;
        let closestDist = Infinity;
        for (const p of particles) {
            const dist = p.position.sub(this.userInput.mousePos).magnitude;
            if (dist < closestDist && dist < this.particleRadius * particleMargin) {
                this.action.hoverParticle = p;
                closestDist = dist;
            }
        }
        // closest beam
        const beams = bufferMapper.beamSet;
        this.action.hoverBeam = null;
        closestDist = Infinity;
        for (const b of beams) {
            const [p, q] = await this.getEndpoints(b);
            // vector math - p, q, endpoints of line r(t) = p + pq * t, mouse pos is point r
            // projected "position" t on line = (pq * pr) / ||pq||^2
            // closest point s on line = p + clamp(t, 0, 1) * pq
            const dir = q.sub(p);
            const closest = p.add(dir.mult(Math.max(0, Math.min(this.userInput.mousePos.sub(p).dot(dir) / (dir.magnitude * dir.magnitude), 1))));
            const dist = this.userInput.mousePos.sub(closest).magnitude;
            if (dist < closestDist && dist < beamMargin) {
                this.action.hoverBeam = b;
                closestDist = dist;
            }
        }
        // actual edit stuff
        if (this.action.mode == 'particle') {
            if (this.action.activeParticle != null) {
                if (this.action.activeParticleType == 'add') {
                    // setting velocity (nothing now)
                } else if (this.action.activeParticleType == 'move') {
                    // move it or something
                    this.action.activeParticle.position = this.action.activeParticle.position.add(this.userInput.mousePos.sub(this.userInput.lastMousePos)).clamp(new Vector2D(this.particleRadius, this.particleRadius), new Vector2D(this.gridSize - this.particleRadius, this.gridSize - this.particleRadius));
                }
            }
        } else if (this.action.mode == 'beam') {
            if (this.action.activeBeam != null) {
                const clampedPos = this.userInput.mousePos.clamp(new Vector2D(this.particleRadius, this.particleRadius), new Vector2D(this.gridSize - this.particleRadius, this.gridSize - this.particleRadius));
                // move endpoint (very useless code because beam particle should always be a particle and not an id)
                if (typeof this.action.activeBeam.b == 'number') {
                    const p = bufferMapper.findParticle(this.action.activeBeam.b);
                    if (p != undefined) p.position = clampedPos;
                } else this.action.activeBeam.b.position = clampedPos;
            }
        }
    }
    get editMode(): SoftbodyEditor['action']['mode'] {
        return this.action.mode;
    }
    async setEditMode(mode: SoftbodyEditor['action']['mode']): Promise<void> {
        await this.endAction();
        this.action.mode = mode;
    }
    get beamSettings(): SoftbodyEditor['action']['beamSettings'] {
        return this.action.beamSettings;
    }
    set beamSettings(settings: SoftbodyEditor['action']['beamSettings']) {
        this.action.beamSettings = settings;
    }

    private async updateFrame(): Promise<void> {
        // update mouse position in case camera moved
        this.userInput.mousePos = this.userInput.rawMousePos.mult(this.gridSize / this.camera.s).add(this.camera.p);
        // random update things
        const now = performance.now();
        const deltaTime = now - this.lastFrame;
        let ocs = this.camera.s;
        let zoomed = false;
        if (this.heldKeys.has('[')) {
            this.camera.s /= deltaTime * 0.002 + 1;
            zoomed = true;
        }
        if (this.heldKeys.has(']')) {
            this.camera.s *= deltaTime * 0.002 + 1;
            zoomed = true;
        }
        if (zoomed) {
            this.camera.s = Math.max(1, Math.min(this.camera.s, 10));
            this.camera.p = this.camera.p.add(this.userInput.rawMousePos.mult(this.gridSize / ocs)).sub(this.userInput.rawMousePos.mult(this.gridSize / this.camera.s));
        }
        const speed = deltaTime * (this.heldKeys['shift'] ? 3 : 1) * 0.4;
        this.camera.p = this.camera.p.add(new Vector2D(
            ((this.heldKeys.has('l') ? 1 : 0) - (this.heldKeys.has('j') ? 1 : 0)) * speed,
            ((this.heldKeys.has('i') ? 1 : 0) - (this.heldKeys.has('k') ? 1 : 0)) * speed
        ));
        this.camera.p = this.camera.p.clamp(new Vector2D(0, 0), new Vector2D(this.gridSize - this.gridSize / this.camera.s, this.gridSize - this.gridSize / this.camera.s));
        this.lastFrame = now;
        await this.updateAction();
    }
    private async drawFrame(): Promise<void> {
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
        const pRadius = this.particleRadius * 0.9; // n/2 + 0.5
        const pEdgeThickness = this.particleRadius * 0.2 * scale; // (1 - n) * r / w * s
        this.ctx.lineWidth = pEdgeThickness;
        this.ctx.lineCap = 'butt';
        this.ctx.beginPath();
        for (const p of particles) {
            this.ctx.moveTo(p.position.x + pRadius, p.position.y);
            this.ctx.arc(p.position.x, p.position.y, pRadius, 0, 2 * Math.PI);
        }
        this.ctx.fill();
        this.ctx.stroke();
        this.ctx.strokeStyle = '#FF0000';
        this.ctx.lineWidth = 1;
        this.ctx.lineCap = 'butt';
        this.ctx.beginPath();
        for (const p of particles) {
            // particles don't really have acceleration as it's reset every frame
            this.ctx.moveTo(p.position.x, p.position.y);
            this.ctx.lineTo(p.position.x + p.velocity.x, p.position.y + p.velocity.y);
        }
        this.ctx.stroke();
        // beams (with stress colors)
        const beams = bufferMapper.beamSet;
        this.ctx.lineWidth = 1;
        this.ctx.lineCap = 'round';
        const stressQuantization = 16;
        const stressScale = 1 / 20; // arbitrary, beams will saturate stress colors
        const stressLevelBeams: Set<[Vector2D, Vector2D]>[] = Array.from({ length: 2 * stressQuantization + 1 }, () => new Set());
        const invalidBeams = new Set<Beam>();
        for (const b of beams) {
            const p1 = typeof b.a == 'number' ? bufferMapper.findParticle(b.a) : b.a;
            const p2 = typeof b.b == 'number' ? bufferMapper.findParticle(b.b) : b.b;
            if (p1 == null || p2 == null) invalidBeams.add(b);
            else {
                const len = p1.position.sub(p2.position).magnitude;
                const force = (b.length - len) * b.spring + (b.lastLen - len) * b.damp;
                // positive = compression, negative = tension (multiplication by quantization * 2 because stress color in compute is funny)
                stressLevelBeams[Math.max(0, Math.min(stressLevelBeams.length - 1, Math.round(force * stressScale * stressQuantization * 2 + stressQuantization)))].add([p1.position, p2.position]);
            }
        }
        for (let i = 0; i < stressLevelBeams.length; i++) {
            const stress = (i - stressQuantization) / stressQuantization;
            this.ctx.strokeStyle = `rgba(${Math.min(1, stress + 1) * 255}, ${Math.min(1, -stress + 1) * 255}, 255, 1)`;
            this.ctx.beginPath();
            for (const [p1, p2] of stressLevelBeams[i]) {
                this.ctx.moveTo(p1.x, p1.y);
                this.ctx.lineTo(p2.x, p2.y);
            }
            this.ctx.stroke();
        }
        // invalid beams
        this.ctx.strokeStyle = '#FF00FF';
        this.ctx.lineWidth = 2;
        this.ctx.setLineDash([10, 5]);
        this.ctx.beginPath();
        for (const b of invalidBeams) {
            const [p1, p2] = await this.getEndpoints(b);
            this.ctx.moveTo(p1.x, p1.y);
            this.ctx.lineTo(p2.x, p2.y);
        }
        this.ctx.stroke();
        this.ctx.setLineDash([]);
        // action things
        const drawParticleOutline = (pos: Vector2D, color: string) => {
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = pEdgeThickness * 3;
            this.ctx.beginPath();
            this.ctx.moveTo(pos.x + pRadius, pos.y);
            this.ctx.arc(pos.x, pos.y, pRadius, 0, 2 * Math.PI);
            this.ctx.stroke();
        };
        if (this.action.mode == 'particle') {
            if (this.action.activeParticle != null) {
                if (this.action.activeParticleType == 'add') {
                    // adding velocity to new particle
                    this.ctx.strokeStyle = '#FF0000';
                    this.ctx.lineWidth = 2;
                    this.ctx.lineCap = 'butt';
                    this.ctx.beginPath();
                    this.ctx.moveTo(this.action.activeParticle.position.x, this.action.activeParticle.position.y);
                    this.ctx.lineTo(this.userInput.mousePos.x, this.userInput.mousePos.y);
                    this.ctx.stroke();
                } else if (this.action.activeParticleType == 'move') {
                    // nothing
                }
                drawParticleOutline(this.action.activeParticle.position, '#00EE00');
            } else if (this.action.hoverParticle != null && !this.action.forceAddMode) {
                // no active particle & not adding particle, show closest hovered particle
                drawParticleOutline(this.action.hoverParticle.position, this.action.deleteMode ? '#FF0000' : '#FFFF00');
            } else if (!this.action.deleteMode) {
                // create new particle
                if (this.userInput.mouseInGrid) drawParticleOutline(this.userInput.mousePos, '#00EE0099');
            }
        } else if (this.action.mode == 'beam') {
            if (this.action.activeBeam != null) {
                // adding new beam from existing particle
                const [a, b] = await this.getEndpoints(this.action.activeBeam);
                drawParticleOutline(a, '#00EE00');
                drawParticleOutline(b, '#00EE00');
                if (this.action.hoverParticle != null && !this.action.forceAddMode) {
                    // show possibility of second endpoint on existing particle
                    drawParticleOutline(this.action.hoverParticle.position, '#FFFF00');
                    this.ctx.strokeStyle = '#FFFF00';
                    this.ctx.lineWidth = 3;
                    this.ctx.lineCap = 'round';
                    this.ctx.beginPath();
                    this.ctx.moveTo(a.x, a.y);
                    this.ctx.lineTo(this.action.hoverParticle.position.x, this.action.hoverParticle.position.y);
                    this.ctx.stroke();
                }
                this.ctx.strokeStyle = '#00EE00';
                this.ctx.lineWidth = 3;
                this.ctx.lineCap = 'round';
                this.ctx.beginPath();
                this.ctx.moveTo(a.x, a.y);
                this.ctx.lineTo(b.x, b.y);
                this.ctx.stroke();
            } else if (this.action.hoverParticle && !this.action.forceAddMode && !this.action.deleteMode) {
                // add beam from existing particle
                drawParticleOutline(this.action.hoverParticle.position, '#FFFF00');
            } else if (this.action.hoverBeam != null && !this.action.forceAddMode) {
                // apply settings to beam or delete
                const [a, b] = await this.getEndpoints(this.action.hoverBeam);
                this.ctx.strokeStyle = this.action.deleteMode ? '#FF0000' : '#FFFF00';
                this.ctx.lineWidth = 5;
                this.ctx.lineCap = 'round';
                this.ctx.beginPath();
                this.ctx.moveTo(a.x, a.y);
                this.ctx.lineTo(b.x, b.y);
                this.ctx.stroke();
            } else if (!this.action.deleteMode) {
                // add beam from new particle
                if (this.userInput.mouseInGrid) drawParticleOutline(this.userInput.mousePos, '#00EE0099');
            }
        }
        // return to canvas space
        this.ctx.resetTransform();
        // ui stuff
        const now = performance.now();
        this.frameTimes.push(now);
        while (this.frameTimes[0] + 1000 < now) this.frameTimes.shift();
        this.fpsHistory.push(this.frameTimes.length);
        this.ctx.fillStyle = '#FFFFFF';
        this.ctx.font = '14px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';
        this.ctx.fillText(`FPS: ${this.fps}`, 8, 8);
        this.ctx.textAlign = 'right';
        const modeText: string[] = [];
        modeText.push(`MODE: ${this.action.mode.toUpperCase()}`);
        if (this.action.mode == 'particle') {
            if (this.action.activeParticle != null) {
                // active particle (create/move)
                const text = `${this.action.activeParticleType.toUpperCase()}: ${this.vecString(this.action.activeParticle.position)}`;
                if (this.action.activeParticleType == 'add') {
                    modeText.push(`${text} V=${this.vecString(this.userInput.mousePos.sub(this.action.activeParticle.position))}`);
                } else modeText.push(text);
            } else if (this.action.hoverParticle != null && !this.action.forceAddMode) {
                modeText.push(`HOVER: ${this.vecString(this.action.hoverParticle.position)} V=${this.vecString(this.action.hoverParticle.velocity)}`);
                // hover particle for delete/move
                modeText.push(`${this.action.deleteMode ? 'DELETE' : 'MOVE'}`);
            } else if (!this.action.deleteMode) {
                // add new particle
                if (this.userInput.mouseInGrid) modeText.push(`ADD AT: ${this.vecString(this.userInput.mousePos)}`);
            }
        } else if (this.action.mode == 'beam') {
            if (this.action.activeBeam != null) {
                // adding new beam
                const [a, b] = await this.getEndpoints(this.action.activeBeam);
                modeText.push(`ADD: ${this.vecString(a)} → ${this.vecString(b)}`);
                if (this.action.hoverParticle != null && !this.action.forceAddMode) {
                    // snap beam to existing particle
                    modeText.push(`SNAP TO ${this.vecString(this.action.hoverParticle.position)}`);
                }
            } else if (this.action.hoverParticle != null && !this.action.forceAddMode && !this.action.deleteMode) {
                // add new beam from existing particle
                modeText.push(`ADD FROM: ${this.vecString(this.action.hoverParticle.position)}`);
            } else if (this.action.hoverBeam != null && !this.action.forceAddMode) {
                const [a, b] = await this.getEndpoints(this.action.hoverBeam);
                modeText.push(`HOVER: ${this.vecString(a)} → ${this.vecString(b)} (S=${this.action.hoverBeam.spring}, D=${this.action.hoverBeam.damp})`);
                // apply settings to beam or delete
                if (this.action.deleteMode) modeText.push('DELETE');
                else modeText.push(`APPLY SETTINGS (S=${this.action.beamSettings.spring}, D=${this.action.beamSettings.damp})`);
            } else if (!this.action.deleteMode) {
                // add beam from new particle
                if (this.userInput.mouseInGrid) modeText.push(`ADD AT: ${this.vecString(this.userInput.mousePos)}`);
            }
        }
        if (this.action.forceAddMode) modeText.push('FORCED ADD');
        for (let i = 0; i < modeText.length; i++) {
            this.ctx.fillText(modeText[i], this.resolution - 8, 8 + 18 * i);
        }
        // last frame mouse position
        this.userInput.lastMousePos = this.userInput.mousePos;
    }
    get fps(): number {
        return this.frameTimes.length;
    }
    private async startDraw(): Promise<void> {
        while (this.running) {
            await new Promise<void>((resolve) => {
                if (this.visible) requestAnimationFrame(async () => {
                    await this.updateFrame();
                    await this.drawFrame();
                    resolve();
                });
                else setTimeout(() => resolve(), 100);
            });
        }
    }

    destroy(): void {
        this.running = false;
        for (const ev in this.listeners) {
            if (Array.isArray(this.listeners[ev]))
                document.removeEventListener(ev, this.listeners[ev][0], this.listeners[ev][1]);
            else
                document.removeEventListener(ev, this.listeners[ev]);
        }
    }
    get destroyed(): boolean {
        return !this.running;
    }
}
