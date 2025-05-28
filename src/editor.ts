/// <reference types="@webgpu/types" />

import { WGPUSoftbodyEngineOptions, WGPUSoftbodyEnginePhysicsConstants } from "./engine";
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
        this.userInput.mousePos = this.userInput.rawMousePos.mult(this.boundsSize / this.camera.s).add(this.camera.p);
        this.userInput.mouseInGrid = this.userInput.rawMousePos.x >= 0 && this.userInput.rawMousePos.x <= 1 && this.userInput.rawMousePos.y >= 0 && this.userInput.rawMousePos.y <= 1;
    }
    private updateKeyboard() {
        this.action.deleteMode = this.heldKeys.has('shift');
        this.action.forceAddMode = this.heldKeys.has('alt');
        this.action.selectMode = this.heldKeys.has('control');
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
            if (e.target instanceof HTMLElement && e.target.matches('input[type=text],input[type=number],textarea')) return;
            if (e.key == 'Alt') e.preventDefault();
            this.heldKeys.add(e.key.toLowerCase());
            this.updateKeyboard();
            this.keyAction(e.key.toLowerCase());
        },
        keyup: (e) => {
            if (e.key == 'Alt') e.preventDefault();
            this.heldKeys.delete(e.key.toLowerCase());
            this.updateKeyboard();
        },
        blur: () => {
            this.endAction();
            this.heldKeys.clear();
            this.updateKeyboard();
        },
        visibilitychange: () => {
            this.visible = !document.hidden
        }
    };

    readonly camera = {
        p: new Vector2D(0, 0),
        s: 1
    };

    readonly boundsSize: number = 1000;
    readonly particleRadius: number = 10;

    readonly blur: number = 0.4;

    constructor(canvas: HTMLCanvasElement, resolution: number, opts?: Partial<Omit<WGPUSoftbodyEngineOptions, 'subticks'>>) {
        this.resolution = resolution;
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
        this.canvas.width = this.resolution;
        this.canvas.height = this.resolution;
        if (opts !== undefined) {
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
        this.startDraw();
        for (const ev in this.listeners) {
            if (Array.isArray(this.listeners[ev])) {
                (ev == 'blur' ? window : document).addEventListener(ev, this.listeners[ev][0], this.listeners[ev][1]);
            } else {
                (ev == 'blur' ? window : document).addEventListener(ev, this.listeners[ev]);
            }
        }
    }

    async load(buf: ArrayBuffer): Promise<boolean> {
        return (await this.bufferMapper).loadSnapshotbuffer(buf);
    }
    async save(): Promise<ArrayBuffer> {
        return (await this.bufferMapper).createSnapshotBuffer();
    }

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
    private snapParticle(p: Vector2D): Vector2D {
        const min = this.particleRadius;
        const max = this.snapGridSize > 0 ? Math.floor((this.boundsSize - this.particleRadius * 2) / this.action.snapGridSize) * this.action.snapGridSize + this.particleRadius : this.boundsSize - this.particleRadius;
        const clamped = Vector2D.clamp(p, new Vector2D(min, min), new Vector2D(max, max));
        if (this.action.snapGridSize > 0) return new Vector2D(
            Math.round((clamped.x - this.particleRadius) / this.action.snapGridSize) * this.action.snapGridSize + this.particleRadius,
            Math.round((clamped.y - this.particleRadius) / this.action.snapGridSize) * this.action.snapGridSize + this.particleRadius
        );
        else return clamped;
    }

    private readonly action: {
        // currently hovered particle - used to select what particle to move
        hoverParticle: Particle | null
        // particle being modified (moving/adding beam to)
        activeParticle: Particle | null
        // adding particle allows setting velocity, so this is needed
        activeParticleType: 'add' | 'move'
        // spaghetti thing to fix moving with snapping on (0 key is mouse initial position)
        spaghettiInitialPositions: Map<Particle | 0, Vector2D>
        // currently hovered beam
        hoverBeam: Beam | null
        // beam being created - particle A is existing particle, particle B is new particle (is deleted if ended on another particle)
        activeBeam: Beam | null
        // mode (switching modes should cancel the current action)
        mode: 'particle' | 'beam'
        // self-explanatory (activated by holding shift)
        deleteMode: boolean
        // if want to add but game wants to hover over some particle (activated by holding alt)
        forceAddMode: boolean
        // settings for new beams
        beamSettings: {
            spring: number
            damp: number
            yieldStrain: number
            strainLimit: number
        }
        // automatically create beams within a certain distance to triangulate things
        autoTriangulate: number
        // particles that could potentially auto-triangulate to
        autoTriangulateParticles: Set<Particle>
        // automatically snap particles to a grid (0 meaning no grid)
        snapGridSize: number
        // clicking will created select box (activated by holding ctrl)
        selectMode: boolean
        // selection rectangle defined by 2 points
        selectBox: {
            a: Vector2D
            b: Vector2D
            // make sure selection stays active until action ends
            active: boolean
        },
        // selected particles, used after selecting
        selectedParticles: Set<Particle>
        // selected beams, same stuff
        selectedBeams: Set<Beam>
    } = {
            hoverParticle: null,
            activeParticle: null,
            activeParticleType: 'add',
            spaghettiInitialPositions: new Map(),
            hoverBeam: null,
            activeBeam: null,
            mode: 'beam',
            deleteMode: false,
            forceAddMode: false,
            beamSettings: {
                spring: 0,
                damp: 0,
                yieldStrain: 0,
                strainLimit: 0
            },
            autoTriangulate: 0,
            autoTriangulateParticles: new Set(),
            snapGridSize: 0,
            selectMode: false,
            selectBox: {
                a: Vector2D.zero,
                b: Vector2D.zero,
                active: false
            },
            selectedParticles: new Set(),
            selectedBeams: new Set()
        };
    private async startAction(): Promise<void> {
        // run updateAction to update hovered stuff
        await this.updateAction();
        const bufferMapper = await this.bufferMapper;
        if (this.action.selectMode) {
            // start selection
            this.action.selectBox.a = this.userInput.mousePos;
            this.action.selectBox.b = this.userInput.mousePos;
            this.action.selectedParticles.clear();
            this.action.selectedBeams.clear();
            this.action.selectBox.active = true;
        } else if (this.action.mode == 'particle') {
            if (this.action.deleteMode) {
                // deletey deleters
                if (this.action.hoverParticle !== null) {
                    bufferMapper.removeParticle(this.action.hoverParticle);
                    for (const b of bufferMapper.getConnectedBeams(this.action.hoverParticle)) bufferMapper.removeBeam(b);
                    this.action.hoverParticle = null;
                    this.action.selectedParticles.clear();
                }
            } else if (this.action.hoverParticle !== null) {
                // move
                this.action.activeParticle = this.action.hoverParticle;
                this.action.activeParticleType = 'move';
                this.action.spaghettiInitialPositions.clear();
                this.action.spaghettiInitialPositions.set(0, this.userInput.mousePos);
                this.action.spaghettiInitialPositions.set(this.action.activeParticle, this.action.activeParticle.position);
                // include selection if in selection
                if (this.action.selectedParticles.has(this.action.activeParticle)) {
                    for (const p of this.action.selectedParticles) this.action.spaghettiInitialPositions.set(p, p.position);
                } else {
                    this.action.selectedParticles.clear();
                }
            } else if (this.action.hoverParticle === null || this.action.forceAddMode) {
                // add particle
                if (this.userInput.mouseInGrid) {
                    this.action.activeParticle = new Particle(bufferMapper.firstEmptyParticleId, this.snapParticle(this.userInput.mousePos));
                    bufferMapper.addParticle(this.action.activeParticle);
                    this.action.activeParticleType = 'add';
                    this.action.selectedParticles.clear();
                }
            }
        } else if (this.action.mode == 'beam') {
            // hovering particle has priority over hovering beam to make adding stuff easier
            if (this.action.deleteMode) {
                // delete
                if (this.action.hoverBeam !== null) {
                    bufferMapper.removeBeam(this.action.hoverBeam);
                    this.action.hoverBeam = null;
                    this.action.selectedBeams.clear();
                }
            } else if (this.action.hoverParticle !== null && !this.action.forceAddMode) {
                // add new beam from existing particle (A is existing, B is new/endpoint)
                const endpoint = new Particle(bufferMapper.firstEmptyParticleId, this.snapParticle(this.userInput.mousePos));
                bufferMapper.addParticle(endpoint);
                this.action.activeBeam = new Beam(bufferMapper.firstEmptyBeamId, this.action.hoverParticle, endpoint, 0, 0, 0, 0, 0);
                bufferMapper.addBeam(this.action.activeBeam);
                this.action.selectedBeams.clear();
            } else if (this.action.hoverBeam !== null && !this.action.forceAddMode) {
                // apply settings
                this.action.hoverBeam.spring = this.action.beamSettings.spring;
                this.action.hoverBeam.damp = this.action.beamSettings.damp;
                // apply to selection if possible
                if (this.action.selectedBeams.has(this.action.hoverBeam)) {
                    for (const b of this.action.selectedBeams) {
                        b.spring = this.action.beamSettings.spring;
                        b.damp = this.action.beamSettings.damp;
                    }
                }
            } else if (this.action.hoverParticle === null || this.action.forceAddMode) {
                // add new beam from new particle
                if (this.userInput.mouseInGrid) {
                    const new1 = new Particle(bufferMapper.firstEmptyParticleId, this.snapParticle(this.userInput.mousePos));
                    bufferMapper.addParticle(new1);
                    const new2 = new Particle(bufferMapper.firstEmptyParticleId, this.snapParticle(this.userInput.mousePos));
                    bufferMapper.addParticle(new2);
                    this.action.activeBeam = new Beam(bufferMapper.firstEmptyBeamId, new1, new2, 0, 0, 0, 0, 0);
                    bufferMapper.addBeam(this.action.activeBeam);
                    this.action.selectedBeams.clear();
                }
            }
        }
    }
    private async endAction(): Promise<void> {
        const bufferMapper = await this.bufferMapper;
        if (this.action.selectBox.active) {
            // end selection
            this.action.selectBox.active = false;
        } else if (this.action.mode == 'particle') {
            if (this.action.activeParticle !== null) {
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
            if (this.action.activeBeam !== null) {
                // finalize new beam
                if (!this.action.forceAddMode && this.action.hoverParticle !== null) {
                    // place on top of existing particle (hover particle will never be active beam particle)
                    bufferMapper.removeParticle(this.action.activeBeam.b);
                    bufferMapper.removeBeam(this.action.activeBeam);
                    this.action.activeBeam = new Beam(this.action.activeBeam.id, this.action.activeBeam.a, this.action.hoverParticle, 0, 0, 0, 0, 0);
                    bufferMapper.addBeam(this.action.activeBeam);
                }
                // set length & settings of beam
                const [a, b] = await this.getEndpoints(this.action.activeBeam);
                this.action.activeBeam.length = a.sub(b).magnitude;
                this.action.activeBeam.targetLen = this.action.activeBeam.length;
                this.action.activeBeam.lastLen = this.action.activeBeam.length;
                this.action.activeBeam.spring = this.action.beamSettings.spring;
                this.action.activeBeam.damp = this.action.beamSettings.damp;
                // triangulation weee
                if (this.action.autoTriangulate > 0) {
                    for (const p of this.action.autoTriangulateParticles) {
                        bufferMapper.addBeam(new Beam(bufferMapper.firstEmptyBeamId, this.action.activeBeam.b, p, b.sub(p.position).magnitude, this.action.beamSettings.spring, this.action.beamSettings.damp, this.action.beamSettings.yieldStrain, this.action.beamSettings.strainLimit));
                    }
                }
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
        if (this.action.activeBeam !== null) {
            const rmA = typeof this.action.activeBeam.a == 'number' ? bufferMapper.findParticle(this.action.activeBeam.a) : this.action.activeBeam.a;
            const rmB = typeof this.action.activeBeam.b == 'number' ? bufferMapper.findParticle(this.action.activeBeam.b) : this.action.activeBeam.b;
            if (rmA !== null) particles.delete(rmA);
            if (rmB !== null) particles.delete(rmB);
        }
        if (this.action.activeParticle !== null) particles.delete(this.action.activeParticle);
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
        if (this.action.selectBox.active) {
            // selecting stuff
            this.action.selectBox.b = this.userInput.mousePos;
            const left = Math.min(this.action.selectBox.a.x, this.action.selectBox.b.x);
            const right = Math.max(this.action.selectBox.a.x, this.action.selectBox.b.x);
            const top = Math.max(this.action.selectBox.a.y, this.action.selectBox.b.y);
            const bottom = Math.min(this.action.selectBox.a.y, this.action.selectBox.b.y);
            if (this.action.mode == 'particle') {
                this.action.selectedParticles.clear();
                for (const p of particles) {
                    if (p.position.x >= left && p.position.x <= right && p.position.y >= bottom && p.position.y <= top) {
                        this.action.selectedParticles.add(p);
                    }
                }
            } else if (this.action.mode == 'beam') {
                // beam intersection is funny
                const rectBox = [
                    new Vector2D(left, top),
                    new Vector2D(right, top),
                    new Vector2D(right, bottom),
                    new Vector2D(left, bottom)
                ];
                this.action.selectedBeams.clear();
                selCheck: for (const b of beams) {
                    const [p, q] = await this.getEndpoints(b);
                    // check any endpoints inside rectangle and any line intersections
                    if ((p.x >= left && p.x <= right && p.y >= bottom && p.y <= top) || (q.x >= left && q.x <= right && q.y >= bottom && q.y <= top)) {
                        this.action.selectedBeams.add(b);
                        continue selCheck;
                    }
                    // if both of these points are on opposite sides of the other's line segment
                    // and both of the other's points are on opposite sides of this line segment
                    for (let i = 0; i < 4; i++) {
                        const u = rectBox[i];
                        const v = rectBox[(i + 1) % 4];
                        const pDet = Vector2D.turnDirection(u, v, p);
                        const qDet = Vector2D.turnDirection(u, v, q);
                        if (pDet != qDet && Vector2D.turnDirection(p, q, u) != Vector2D.turnDirection(p, q, v)) {
                            this.action.selectedBeams.add(b);
                            continue selCheck;
                        }
                    }
                }
            }
        } else if (this.action.mode == 'particle') {
            if (this.action.activeParticle !== null) {
                if (this.action.activeParticleType == 'add') {
                    // setting velocity (nothing now)
                } else if (this.action.activeParticleType == 'move') {
                    // move it or something
                    const diff = this.userInput.mousePos.sub(this.action.spaghettiInitialPositions.get(0) ?? Vector2D.zero);
                    // apply to whole selection if in selection
                    if (this.action.selectedParticles.has(this.action.activeParticle)) {
                        for (const p of this.action.selectedParticles) {
                            p.position = this.snapParticle((this.action.spaghettiInitialPositions.get(p) ?? Vector2D.zero).add(diff));
                        }
                    } else {
                        this.action.activeParticle.position = this.snapParticle((this.action.spaghettiInitialPositions.get(this.action.activeParticle) ?? Vector2D.zero).add(diff));
                    }
                }
            }
        } else if (this.action.mode == 'beam') {
            if (this.action.activeBeam !== null) {
                // move endpoint (very useless code because beam particle should always be a particle and not an id)
                const clampedPos = this.snapParticle(this.userInput.mousePos);
                const a = typeof this.action.activeBeam.a == 'number' ? bufferMapper.findParticle(this.action.activeBeam.a) : this.action.activeBeam.a;
                const b = typeof this.action.activeBeam.b == 'number' ? bufferMapper.findParticle(this.action.activeBeam.b) : this.action.activeBeam.b;
                if (b !== null) b.position = clampedPos;
                // auto-triangulate
                if (this.action.autoTriangulate > 0) {
                    this.action.autoTriangulateParticles.clear();
                    if (b !== null) {
                        const particles = bufferMapper.particleSet;
                        for (const p of particles) {
                            if (p.position.sub(b.position).magnitude <= this.action.autoTriangulate && p !== a && p !== b) {
                                this.action.autoTriangulateParticles.add(p);
                            }
                        }
                    }
                }
            }
        }
    }
    private async keyAction(key: string) {
        const bufferMapper = await this.bufferMapper;
        if (key == 'backspace' || key == 'delete') {
            // deletier deletesters
            if (this.action.mode == 'particle') {
                for (const p of this.action.selectedParticles) {
                    bufferMapper.removeParticle(p);
                    for (const b of bufferMapper.getConnectedBeams(p)) bufferMapper.removeBeam(b);
                }
                this.action.selectedParticles.clear();
            } else if (this.action.mode == 'beam') {
                for (const b of this.action.selectedBeams) {
                    bufferMapper.removeBeam(b);
                }
                this.action.selectedBeams.clear();
            }
        } else if (key == 'escape') {
            this.action.selectedParticles.clear();
            this.action.selectedBeams.clear();
        } else if (key == 'r' && this.action.mode == 'beam') {
            // reset beam stresses
            for (const b of this.action.selectedBeams) {
                const [p, q] = await this.getEndpoints(b);
                b.length = p.sub(q).magnitude;
                b.targetLen = b.length;
                b.lastLen = b.length;
            }
        }
    }
    get editMode(): SoftbodyEditor['action']['mode'] {
        return this.action.mode;
    }
    async setEditMode(mode: SoftbodyEditor['action']['mode']): Promise<void> {
        await this.endAction();
        this.action.selectedParticles.clear();
        this.action.selectedBeams.clear();
        this.action.mode = mode;
    }
    get beamSettings(): SoftbodyEditor['action']['beamSettings'] {
        return this.action.beamSettings;
    }
    set beamSettings(settings: SoftbodyEditor['action']['beamSettings']) {
        this.action.beamSettings = settings;
    }
    get autoTriangulateDistance(): number {
        return this.action.autoTriangulate;
    }
    set autoTriangulateDistance(d: number) {
        this.action.autoTriangulate = d;
    }
    get snapGridSize(): number {
        return this.action.snapGridSize;
    }
    set snapGridSize(s: number) {
        this.action.snapGridSize = s;
    }

    // only to allow setting these for downloading/uploading
    async setPhysicsConstants(constants: WGPUSoftbodyEnginePhysicsConstants): Promise<void> {
        (await this.bufferMapper).meta.setPhysicsConstants(constants);
    }
    async getPhysicsConstants(): Promise<WGPUSoftbodyEnginePhysicsConstants> {
        return (await this.bufferMapper).meta.getPhysicsConstants();
    }

    private visible: boolean = !document.hidden;
    private readonly frameTimes: number[] = [];
    private readonly fpsHistory: number[] = [];
    private lastFrame: number = performance.now();
    private running: boolean = true;
    private async updateFrame(): Promise<void> {
        // update mouse position in case camera moved
        this.userInput.mousePos = this.userInput.rawMousePos.mult(this.boundsSize / this.camera.s).add(this.camera.p);
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
            this.camera.p = this.camera.p.add(this.userInput.rawMousePos.mult(this.boundsSize / ocs)).sub(this.userInput.rawMousePos.mult(this.boundsSize / this.camera.s));
        }
        const speed = deltaTime * (this.heldKeys['shift'] ? 3 : 1) * 0.4;
        this.camera.p = this.camera.p.add(new Vector2D(
            ((this.heldKeys.has('l') ? 1 : 0) - (this.heldKeys.has('j') ? 1 : 0)) * speed,
            ((this.heldKeys.has('i') ? 1 : 0) - (this.heldKeys.has('k') ? 1 : 0)) * speed
        ));
        this.camera.p = Vector2D.clamp(this.camera.p, new Vector2D(0, 0), new Vector2D(this.boundsSize - this.boundsSize / this.camera.s, this.boundsSize - this.boundsSize / this.camera.s));
        this.lastFrame = now;
        await this.updateAction();
    }
    private async drawFrame(): Promise<void> {
        const bufferMapper = await this.bufferMapper;
        this.ctx.resetTransform();
        this.ctx.fillStyle = `rgba(0, 0, 0, ${this.blur})`;
        this.ctx.fillRect(0, 0, this.resolution, this.resolution);
        // transform to simulation space
        const scale = this.resolution / this.boundsSize;
        this.ctx.transform(scale, 0, 0, -scale, 0, this.resolution);
        // camera transform on top
        this.ctx.transform(this.camera.s, 0, 0, this.camera.s, -this.camera.p.x * this.camera.s, -this.camera.p.y * this.camera.s);
        // snap grid
        if (this.action.snapGridSize > 0) {
            this.ctx.strokeStyle = '#555555';
            this.ctx.lineWidth = 1;
            this.ctx.lineCap = 'square';
            this.ctx.lineJoin = 'miter';
            this.ctx.beginPath();
            const max = Math.floor((this.boundsSize - this.particleRadius * 2) / this.action.snapGridSize) * this.action.snapGridSize + this.particleRadius;
            for (let i = this.particleRadius; i <= max; i += this.action.snapGridSize) {
                this.ctx.moveTo(this.particleRadius, i);
                this.ctx.lineTo(max, i);
                this.ctx.moveTo(i, this.particleRadius);
                this.ctx.lineTo(i, max);
            }
            this.ctx.stroke();
        }
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
        const stressScale = 1 / 20; // arbitrary, beams will saturate stress colors
        const invalidBeams = new Set<Beam>();
        for (const b of beams) {
            const p1 = typeof b.a == 'number' ? bufferMapper.findParticle(b.a) : b.a;
            const p2 = typeof b.b == 'number' ? bufferMapper.findParticle(b.b) : b.b;
            if (p1 === null || p2 === null) invalidBeams.add(b);
            else {
                const len = p1.position.sub(p2.position).magnitude;
                const strain = Math.abs(b.targetLen - len) / b.length;
                const stress = ((b.targetLen - len) * b.spring + (b.lastLen - len) * b.damp) * stressScale;
                this.ctx.strokeStyle = `rgba(${Math.max(0, Math.min(1, stress + 1)) * 255}, ${Math.max(0, Math.min(1, -stress + 1)) * 255}, ${Math.max(0, 1 - strain / b.strainLimit) * 255}, 1)`;
                this.ctx.beginPath();
                this.ctx.moveTo(p1.position.x, p1.position.y);
                this.ctx.lineTo(p2.position.x, p2.position.y);
                this.ctx.stroke();
            }
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
            // selected particles always drawn for actions
            this.ctx.strokeStyle = '#00FFFF';
            this.ctx.lineWidth = pEdgeThickness * 2;
            this.ctx.beginPath();
            for (const p of this.action.selectedParticles) {
                this.ctx.moveTo(p.position.x + pRadius, p.position.y);
                this.ctx.arc(p.position.x, p.position.y, pRadius, 0, 2 * Math.PI);
            }
            this.ctx.stroke(); if (this.action.selectBox.active || this.action.selectMode) {
                // block drawing
            } else if (this.action.activeParticle !== null) {
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
                // snapping here because moving is borked
                drawParticleOutline(this.action.activeParticle.position, '#00EE00');
            } else if (this.action.hoverParticle !== null && !this.action.forceAddMode) {
                // no active particle & not adding particle, show closest hovered particle
                drawParticleOutline(this.action.hoverParticle.position, this.action.deleteMode ? '#FF0000' : '#FFFF00');
            } else if (!this.action.deleteMode) {
                // create new particle
                if (this.userInput.mouseInGrid) drawParticleOutline(this.snapParticle(this.userInput.mousePos), '#00EE0099');
            }
        } else if (this.action.mode == 'beam') {
            // selected beams always drawn for actions
            this.ctx.strokeStyle = '#00FFFF';
            this.ctx.lineWidth = 3;
            this.ctx.lineCap = 'round';
            this.ctx.beginPath();
            for (const b of this.action.selectedBeams) {
                const [p, q] = await this.getEndpoints(b);
                this.ctx.moveTo(p.x, p.y);
                this.ctx.lineTo(q.x, q.y);
            }
            this.ctx.stroke();
            if (this.action.selectBox.active || this.action.selectMode) {
                // block drawing
            } else if (this.action.activeBeam !== null) {
                // adding new beam
                const [a, b] = await this.getEndpoints(this.action.activeBeam);
                drawParticleOutline(a, '#00EE00');
                drawParticleOutline(b, '#00EE00');
                if (this.action.hoverParticle !== null && !this.action.forceAddMode) {
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
                // triangulated beams
                if (this.action.autoTriangulate > 0) {
                    this.ctx.lineWidth = 1;
                    this.ctx.beginPath();
                    for (const p of this.action.autoTriangulateParticles) {
                        this.ctx.moveTo(b.x, b.y);
                        this.ctx.lineTo(p.position.x, p.position.y);
                    }
                    this.ctx.stroke();
                }
            } else if (this.action.hoverParticle && !this.action.forceAddMode && !this.action.deleteMode) {
                // add beam from existing particle
                drawParticleOutline(this.action.hoverParticle.position, '#00EE00');
            } else if (this.action.hoverBeam !== null && !this.action.forceAddMode) {
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
                if (this.userInput.mouseInGrid) drawParticleOutline(this.snapParticle(this.userInput.mousePos), '#00EE0099');
            }
        }
        if (this.action.selectBox.active) {
            // this is drawn last to be on top of everything
            this.ctx.strokeStyle = '#FFFFFFAA';
            this.ctx.lineCap = 'butt';
            this.ctx.lineWidth = 1;
            this.ctx.setLineDash([10, 5]);
            const pos = Vector2D.min(this.action.selectBox.a, this.action.selectBox.b);
            const size = Vector2D.max(this.action.selectBox.a, this.action.selectBox.b).sub(pos);
            this.ctx.strokeRect(pos.x, pos.y, size.x, size.y);
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = '#FFFFFF22';
            this.ctx.fillRect(pos.x, pos.y, size.x, size.y);
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
            if (this.action.selectBox.active) {
                modeText.push(`SELECTING: ${this.action.selectedParticles.size}`);
            } else if (this.action.selectMode) {
                modeText.push('SELECT');
            } else if (this.action.activeParticle !== null) {
                // active particle (create/move)
                const text = `${this.action.activeParticleType.toUpperCase()}: ${this.vecString(this.action.activeParticle.position)}`;
                if (this.action.activeParticleType == 'add') {
                    modeText.push(`${text} V=${this.vecString(this.userInput.mousePos.sub(this.action.activeParticle.position))}`);
                } else modeText.push(text);
            } else if (this.action.hoverParticle !== null && !this.action.forceAddMode) {
                modeText.push(`HOVER: ${this.vecString(this.action.hoverParticle.position)} V=${this.vecString(this.action.hoverParticle.velocity)}`);
                // hover particle for delete/move
                modeText.push(`${this.action.deleteMode ? 'DELETE' : 'MOVE'}`);
                // apply to entire selection
                if (!this.action.deleteMode && this.action.selectedParticles.has(this.action.hoverParticle)) modeText.push('APPLY TO SELECTION');
            } else if (!this.action.deleteMode) {
                // add new particle
                if (this.userInput.mouseInGrid) modeText.push(`ADD AT: ${this.vecString(this.snapParticle(this.userInput.mousePos))}`);
            }
        } else if (this.action.mode == 'beam') {
            if (this.action.selectBox.active) {
                modeText.push(`SELECTING: ${this.action.selectedBeams.size}`);
            } else if (this.action.selectMode) {
                modeText.push('SELECT');
            } else if (this.action.activeBeam !== null) {
                // adding new beam
                const [a, b] = await this.getEndpoints(this.action.activeBeam);
                modeText.push(`ADD: ${this.vecString(a)} → ${this.vecString(b)}`);
                if (this.action.hoverParticle !== null && !this.action.forceAddMode) {
                    // snap beam to existing particle
                    modeText.push(`SNAP TO ${this.vecString(this.action.hoverParticle.position)}`);
                }
            } else if (this.action.hoverParticle !== null && !this.action.forceAddMode && !this.action.deleteMode) {
                // add new beam from existing particle
                modeText.push(`ADD FROM: ${this.vecString(this.action.hoverParticle.position)}`);
            } else if (this.action.hoverBeam !== null && !this.action.forceAddMode) {
                const [a, b] = await this.getEndpoints(this.action.hoverBeam);
                modeText.push(`HOVER: ${this.vecString(a)} → ${this.vecString(b)} (S=${this.action.hoverBeam.spring}, D=${this.action.hoverBeam.damp})`);
                // apply settings to beam or delete
                if (this.action.deleteMode) {
                    modeText.push('DELETE');
                } else {
                    modeText.push(`APPLY SETTINGS (S=${this.action.beamSettings.spring}, D=${this.action.beamSettings.damp})`);
                    // apply to selection
                    if (this.action.selectedBeams.has(this.action.hoverBeam)) modeText.push('APPLY TO SELECTION');
                }

            } else if (!this.action.deleteMode) {
                // add beam from new particle
                if (this.userInput.mouseInGrid) modeText.push(`ADD AT: ${this.vecString(this.snapParticle(this.userInput.mousePos))}`);
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
            if (Array.isArray(this.listeners[ev])) {
                (ev == 'blur' ? window : document).removeEventListener(ev, this.listeners[ev][0], this.listeners[ev][1]);
            } else {
                (ev == 'blur' ? window : document).removeEventListener(ev, this.listeners[ev]);
            }
        }
    }
    get destroyed(): boolean {
        return !this.running;
    }
}
