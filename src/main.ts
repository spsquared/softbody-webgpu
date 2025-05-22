/// <reference types="@webgpu/types" />

import './assets/main.css';

import { SoftbodyEditor } from './editor';
import { WGPUSoftbodyEngine, WGPUSoftbodyEngineOptions, WGPUSoftbodyEnginePhysicsConstants } from './engine';
import { Beam, BufferMapper, Particle, Vector2D } from './engineMapping';

export const main = document.getElementById('main') as HTMLDivElement;
export const canvas = document.getElementById('canvas') as HTMLCanvasElement;

if (navigator.gpu === undefined) {
    alert('Your device does not support WebGPU or does not have it enabled');
    throw new TypeError('Your device does not support WebGPU or does not have it enabled');
}

type Mutable<T> = {
    -readonly [P in keyof T]: T[P]
}

// simulation mode
const resolution = 800;
const simulation: {
    instance: WGPUSoftbodyEngine
    readonly options: Mutable<WGPUSoftbodyEngineOptions>
    readonly constants: Mutable<WGPUSoftbodyEnginePhysicsConstants>
} = {
    instance: new WGPUSoftbodyEngine(canvas, resolution, {
        particleRadius: 10,
        subticks: 64,
    }),
    options: {
        particleRadius: 10,
        subticks: 64,
    },
    constants: {
        gravity: new Vector2D(0, -0.5),
        borderElasticity: 0.5,
        borderFriction: 0.2,
        elasticity: 0.5,
        friction: 0.1,
        dragCoeff: 0.001,
        dragExp: 2
    }
};
simulation.instance.setPhysicsConstants(simulation.constants);

// snapshot controls
const loadSnapshotButton = document.getElementById('loadSnapButton') as HTMLInputElement;
const saveSnapshotButton = document.getElementById('saveSnapButton') as HTMLInputElement;
async function downloadSnapshot() {
    if (allButtonsDisabled || simulationButtonsDisabled) return;
    disableAllButtons();
    const blob = new Blob([await simulation.instance.saveSnapshot()]);
    enableAllButtons();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `snapshot-${Math.floor(Date.now() / 1000)}.dat`;
    a.click();
    URL.revokeObjectURL(url);
}
async function uploadSnapshot() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dat';
    input.addEventListener('change', async () => {
        const file = input.files?.item(0);
        if (file == null) return;
        if (allButtonsDisabled || simulationButtonsDisabled) return;
        disableAllButtons();
        const buf = await file.arrayBuffer();
        const res = await simulation.instance.loadSnapshot(buf);
        if (res) {
            editor.initialState = buf;
            const constants = await simulation.instance.getPhysicsConstants();
            // changing the object to a new object borks stuff so we do this thing
            for (let i in constants) simulation.constants[i] = constants[i];
            loadClamps();
            updateClamps();
        } else {
            // oh no buffers too large
            console.error('Snapshot failed to load due to buffers being too large.\nThis can happen when the snapshot is created and then loaded on a different device with fewer resources.');
            alert('Snapshot could not load; too large for this device');
        }
        enableAllButtons();
    });
    input.click();
}
loadSnapshotButton.addEventListener('click', (e) => uploadSnapshot());
saveSnapshotButton.addEventListener('click', (e) => downloadSnapshot());

// inputs for engine settings and world constants
const clampedInputs = new Set<[HTMLInputElement, number | (() => number), number | (() => number), number, object | ((v?: number) => number)]>();
function updateClamps() {
    for (const [input, min, max, step, target] of clampedInputs) {
        const val = Number(input.value);
        const min2 = typeof min == 'number' ? min : min();
        const max2 = typeof max == 'number' ? max : max();
        const val2 = Math.max(min2, Math.min(max2, Math.round(val / step) * step));
        input.min = min2.toString();
        input.max = max2.toString();
        const val3 = isNaN(val2) ? 1 : val2;
        input.value = val3.toString();
        if (typeof target == 'function') target(val3);
        else target[input.id] = val3;
    }
}
function loadClamps() {
    for (const [input, min, max, step, target] of clampedInputs) {
        if (typeof target == 'function') input.value = target().toString();
        else input.value = target[input.id].toString();
    }
}
function createClampedInput(input: HTMLInputElement, min: number | (() => number), max: number | (() => number), step: number, target: object | ((v?: number) => number)): HTMLInputElement {
    clampedInputs.add([input, min, max, step, target]);
    input.step = step.toString();
    input.addEventListener('blur', () => updateClamps());
    return input;
}
// options
createClampedInput(document.getElementById('particleRadius') as HTMLInputElement, 1, 500, 1, simulation.options);
createClampedInput(document.getElementById('subticks') as HTMLInputElement, 2, 256, 2, simulation.options);
// keyboard force
createClampedInput(document.getElementById('keyboardForce') as HTMLInputElement, 0.1, 10, 0.1, (v) => simulation.instance.keyboardForce = v ?? simulation.instance.keyboardForce);
// constants
createClampedInput(document.getElementById('gravityX') as HTMLInputElement, -10, 10, 0.02, (v) => ((v !== undefined && (simulation.constants.gravity = new Vector2D(v, simulation.constants.gravity.y))), simulation.constants.gravity.x));
createClampedInput(document.getElementById('gravityY') as HTMLInputElement, -10, 10, 0.02, (v) => ((v !== undefined && (simulation.constants.gravity = new Vector2D(simulation.constants.gravity.x, v))), simulation.constants.gravity.y));
createClampedInput(document.getElementById('borderElasticity') as HTMLInputElement, 0, 1, 0.01, simulation.constants);
createClampedInput(document.getElementById('borderFriction') as HTMLInputElement, 0, 10, 0.01, simulation.constants);
createClampedInput(document.getElementById('elasticity') as HTMLInputElement, 0, 1, 0.01, simulation.constants);
createClampedInput(document.getElementById('friction') as HTMLInputElement, 0, 10, 0.01, simulation.constants);
createClampedInput(document.getElementById('dragCoeff') as HTMLInputElement, 0, 2 ** 32, 0.001, simulation.constants);
createClampedInput(document.getElementById('dragExp') as HTMLInputElement, 1, 4, 0.1, simulation.constants);
loadClamps();
updateClamps();
const applyOptionsButton = document.getElementById('applyOptions') as HTMLInputElement;
const applyConstantsButton = document.getElementById('applyConstants') as HTMLInputElement;
applyOptionsButton.addEventListener('click', async () => {
    if (allButtonsDisabled || simulationButtonsDisabled) return;
    disableAllButtons();
    // preserve simulation state
    const snapshot = await simulation.instance.saveSnapshot();
    simulation.instance.destroy();
    simulation.instance = new WGPUSoftbodyEngine(canvas, resolution, simulation.options);
    await simulation.instance.loadSnapshot(snapshot);
    enableAllButtons();
});
applyConstantsButton.addEventListener('click', async () => {
    // allow applying to editor for saving with physics constants
    if (allButtonsDisabled) return;
    disableAllButtons();
    if (!simulation.instance.destroyed) await simulation.instance.setPhysicsConstants(simulation.constants);
    await editor.instance.setPhysicsConstants(simulation.constants);
    enableAllButtons();
});

// button things to prevent race conditions (sim buttons can be disabled separately but "all" can force them disabled too)
const simulationButtons = [loadSnapshotButton, saveSnapshotButton, applyOptionsButton];
const allButtons = [...document.querySelectorAll('#editButtonsGrid1>input,#editButtonsGrid2>input,#editFileOptionsGrid>input'), applyConstantsButton, ...simulationButtons] as HTMLInputElement[];
const editButtonsDivs = [
    document.getElementById('editButtonsGrid1') as HTMLDivElement,
    document.getElementById('editButtonsGrid2') as HTMLDivElement,
    document.getElementById('editButtonsBeamSettings') as HTMLDivElement,
    document.getElementById('editButtonsOptions') as HTMLDivElement,
    document.getElementById('editFileOptionsGrid') as HTMLDivElement,
];
let allButtonsDisabled = false;
let simulationButtonsDisabled = false;
function disableAllButtons() {
    allButtonsDisabled = true;
    for (const b of allButtons) b.disabled = true;
}
function enableAllButtons() {
    allButtonsDisabled = false;
    for (const b of allButtons) b.disabled = false;
    // if the simulation buttons are disabled keep them disabled
    if (simulationButtonsDisabled) disableSimulationButtons();
}
function disableSimulationButtons() {
    simulationButtonsDisabled = true;
    for (const b of simulationButtons) b.disabled = true;
}
function enableSimulationButtons() {
    simulationButtonsDisabled = false;
    for (const b of simulationButtons) b.disabled = false;
}

// default state stuff
function oofDefaultState(mapper: BufferMapper) {
    const bufferMapper = mapper;
    let i = 0, j = 0;
    // beam tests
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(800, 700), new Vector2D(0, 10)));
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(700, 700), new Vector2D(0, 20)));
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(650, 600), new Vector2D(10, 10)));
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(550, 600), new Vector2D(-10, 30)));
    // bufferMapper.addBeam(new Beam(j++, 0, 1, 100, 0.2, 20));
    // bufferMapper.addBeam(new Beam(j++, 2, 3, 100, 0.2, 20));
    // collision tests
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(550, 300), new Vector2D(0, 0)));
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(568, 400), new Vector2D(0, 0)));
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(400, 300), new Vector2D(1, 0)));
    // bufferMapper.addParticle(new Particle(i++, new Vector2D(440, 300), new Vector2D(-1, 0)));
    function addRectangle(ox: number, oy: number, d: number, w: number, h: number, bs: number, bd: number) {
        for (let x = 0; x < w; x++) {
            for (let y = 0; y < h; y++) {
                let b = i;
                bufferMapper.addParticle(new Particle(i++, new Vector2D(x * d + ox, y * d + oy)));
                if (y < h - 1) bufferMapper.addBeam(new Beam(j++, b, b + 1, d, bs, bd));
                if (x < w - 1) bufferMapper.addBeam(new Beam(j++, b, b + h, d, bs, bd));
                if (y < h - 1 && x < w - 1) bufferMapper.addBeam(new Beam(j++, b, b + h + 1, Math.SQRT2 * d, bs, bd));
                if (y > 0 && x < w - 1) bufferMapper.addBeam(new Beam(j++, b, b + h - 1, Math.SQRT2 * d, bs, bd));
            }
        }
    }
    // lines
    // addRectangle(10, 990, 25, 10, 1, 10, 100);
    // CUBES
    addRectangle(185, 10, 60, 2, 2, 1, 50);
    addRectangle(35, 10, 60, 2, 2, 1, 50);
    addRectangle(20, 120, 30, 9, 4, 50, 700);
    bufferMapper.addParticle(new Particle(i++, new Vector2D(445, 10)));
    bufferMapper.addParticle(new Particle(i++, new Vector2D(925, 10)));
    addRectangle(400, 40, 30, 20, 2, 500, 800);
    addRectangle(700, 400, 40, 5, 5, 2, 50);
    // lol staircase
    // const qa = 500;
    // const qb = 500;
    // let guh = i;
    // for (let q = 0; q < 10; q++) {
    //     addRectangle(10 + 60 * q, 10, 30, 2, 20 - q * 2, qa, qb);
    // }
    // for (let q = 0; q < 9; q++) {
    //     const h = 20 - q * 2;
    //     for (let v = h; v < h * 2 - 2; v++) {
    //         bufferMapper.addBeam(new Beam(j++, guh + v, guh + h + v, 30, qa, qb));
    //         if (v > h) {
    //             bufferMapper.addBeam(new Beam(j++, guh + v, guh + h + v - 1, 30 * Math.SQRT2, qa, qb));
    //         }
    //         if (v < h * 2 - 3) {
    //             bufferMapper.addBeam(new Beam(j++, guh + v, guh + h + v + 1, 30 * Math.SQRT2, qa, qb));
    //         }
    //     }
    //     guh += 2 * h;
    // }
    addRectangle(20, 900, 50, 2, 2, 0.05, 10);
    addRectangle(20, 700, 50, 2, 2, 0.1, 10);
    // spam
    // for (; i < 100;) {
    //     bufferMapper.addParticle(new Particle(i++, new Vector2D(Math.random() * this.gridSize, Math.random() * this.gridSize), new Vector2D(Math.random() * 20 - 10, Math.random() * 20 - 10)))
    // }
    // idk
    // addRectangle(1, 1, 500, 2, 2, 0.05, 10);
}

// edit mode
const resetButton = document.getElementById('resetButton') as HTMLInputElement;
const editInitialButton = document.getElementById('editInitialButton') as HTMLInputElement;
const editCurrentButton = document.getElementById('editCurrentButton') as HTMLInputElement;
const simulateButton = document.getElementById('simulateButton') as HTMLInputElement;
const editor: {
    instance: SoftbodyEditor,
    initialState: ArrayBuffer,
    is: boolean
} = {
    instance: new SoftbodyEditor(canvas, resolution),
    // not spaghetti
    initialState: (() => {
        // arbitrary small size of buffer so no accidental out of bounds problems in load
        const mapper = new BufferMapper(65536);
        mapper.meta.setPhysicsConstants(simulation.constants);
        oofDefaultState(mapper);
        mapper.writeState();
        return mapper.createSnapshotBuffer();
    })(),
    is: false
};
// immediately stop editor instance (easier than null typing oof)
editor.instance.destroy();
editor.instance.beamSettings = { spring: 10, damp: 10 };
editor.instance.snapGridSize = 10;

// inputs for editing
const editModeToggle = document.getElementById('editModeToggleButton') as HTMLInputElement;
editModeToggle.addEventListener('click', () => {
    if (allButtonsDisabled || !editor.is) return;
    if (editor.instance.editMode == 'particle') {
        editor.instance.setEditMode('beam');
        editButtonsDivs[2].style.display = '';
        editModeToggle.value = 'Edit: Beams';
        loadClamps();
        updateClamps();
    } else {
        editor.instance.setEditMode('particle');
        editButtonsDivs[2].style.display = 'none';
        editModeToggle.value = 'Edit: Particles';
    }
});
createClampedInput(document.getElementById('beamSpring') as HTMLInputElement, 0, 2000, 0.1, (s) => editor.instance.beamSettings.spring = s ?? editor.instance.beamSettings.spring);
createClampedInput(document.getElementById('beamDamp') as HTMLInputElement, 0, 2000, 0.1, (d) => editor.instance.beamSettings.damp = d ?? editor.instance.beamSettings.damp);
createClampedInput(document.getElementById('triangulationDistance') as HTMLInputElement, 0, 1000, 10, (d) => editor.instance.autoTriangulateDistance = d ?? editor.instance.autoTriangulateDistance);
createClampedInput(document.getElementById('snapGridSize') as HTMLInputElement, 0, 100, 10, (d) => editor.instance.snapGridSize = d ?? editor.instance.snapGridSize);
const editLoadButton = document.getElementById('editLoadButton') as HTMLInputElement;
const editSaveButton = document.getElementById('editSaveButton') as HTMLInputElement;
async function downloadEdit() {
    if (allButtonsDisabled || !editor.is) return;
    disableAllButtons();
    const blob = new Blob([await editor.instance.save()]);
    enableAllButtons();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `save-${Math.floor(Date.now() / 1000)}.dat`;
    a.click();
    URL.revokeObjectURL(url);
}
async function uploadEdit() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dat';
    input.addEventListener('change', async () => {
        const file = input.files?.item(0);
        if (file == null) return;
        if (allButtonsDisabled || !editor.is) return;
        disableAllButtons();
        const buf = await file.arrayBuffer();
        const res = await editor.instance.load(buf);
        if (res) {
            loadClamps();
            updateClamps();
        } else {
            // oh no buffers too large
            console.error('Snapshot failed to load due to buffers being too large.\nThis can happen when the snapshot is created and then loaded on a different device with fewer resources.');
            alert('Snapshot could not load; too large for this device');
        }
        enableAllButtons();
    });
    input.click();
}
editLoadButton.addEventListener('click', (e) => uploadEdit());
editSaveButton.addEventListener('click', (e) => downloadEdit());

// switching and stuff
const simulationControlHints = document.getElementById('simulationControlHints') as HTMLDivElement;
const editorControlHints = document.getElementById('editorControlHints') as HTMLDivElement;
async function resetToInitial() {
    if (editor.is) return;
    disableAllButtons();
    await simulation.instance.loadSnapshot(editor.initialState);
    const constants = await simulation.instance.getPhysicsConstants();
    // changing the object to a new object borks stuff so we do this thing
    for (let i in constants) simulation.constants[i] = constants[i];
    loadClamps();
    updateClamps();
    enableAllButtons();
}
async function setInitialState() {
    if (editor.is) return;
    disableAllButtons();
    editor.initialState = await simulation.instance.saveSnapshot();
    enableAllButtons();
}
async function switchToEditor() {
    if (editor.is) return;
    disableSimulationButtons();
    disableAllButtons();
    await simulation.instance.destroy();
    const beamSettings = editor.instance.beamSettings;
    const grid = editor.instance.snapGridSize;
    const triangulation = editor.instance.autoTriangulateDistance;
    editor.instance = new SoftbodyEditor(canvas, resolution);
    await editor.instance.load(editor.initialState);
    editButtonsDivs[0].style.display = 'none';
    editButtonsDivs[1].style.display = '';
    editButtonsDivs[2].style.display = '';
    editButtonsDivs[3].style.display = '';
    editButtonsDivs[4].style.display = '';
    editModeToggle.value = 'Edit: Beams';
    editor.instance.beamSettings = beamSettings;
    editor.instance.snapGridSize = grid;
    editor.instance.autoTriangulateDistance = triangulation;
    editor.is = true;
    loadClamps();
    updateClamps();
    simulationControlHints.style.display = 'none';
    editorControlHints.style.display = '';
    enableAllButtons();
}
async function switchToSimulation() {
    if (!editor.is) return;
    disableAllButtons();
    editor.initialState = await editor.instance.save();
    await editor.instance.destroy();
    simulation.instance = new WGPUSoftbodyEngine(canvas, resolution, simulation.options);
    await simulation.instance.loadSnapshot(editor.initialState);
    editButtonsDivs[0].style.display = '';
    editButtonsDivs[1].style.display = 'none';
    editButtonsDivs[2].style.display = 'none';
    editButtonsDivs[3].style.display = 'none';
    editButtonsDivs[4].style.display = 'none';
    editor.is = false;
    loadClamps();
    updateClamps();
    simulationControlHints.style.display = '';
    editorControlHints.style.display = 'none';
    enableSimulationButtons();
    enableAllButtons();
}
resetButton.addEventListener('click', () => !allButtonsDisabled && resetToInitial());
editInitialButton.addEventListener('click', () => !allButtonsDisabled && resetToInitial().then(() => switchToEditor()));
editCurrentButton.addEventListener('click', () => !allButtonsDisabled && setInitialState().then(() => switchToEditor()));
simulateButton.addEventListener('click', () => !allButtonsDisabled && switchToSimulation());
resetToInitial();
editButtonsDivs[1].style.display = 'none';
editButtonsDivs[2].style.display = 'none';
editButtonsDivs[3].style.display = 'none';
editButtonsDivs[4].style.display = 'none';
editorControlHints.style.display = 'none';

// shortcuts for buttons
document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && e.target.matches('input[type=text],input[type=number],button,textarea,select')) return;
    const key = e.key.toLowerCase();
    if (key == 'enter') editModeToggle.click();
    else if (key == 'r' && e.ctrlKey && !e.shiftKey && !e.altKey) resetButton.click();
    else if (key == 'e' && e.ctrlKey && !e.shiftKey && !e.altKey) (editor.is ? simulateButton : editInitialButton).click();
    else if (key == 'p' && e.ctrlKey && !e.shiftKey && !e.altKey) (editor.is ? simulateButton : editCurrentButton).click();
    else if (key == 's' && e.ctrlKey && !e.shiftKey && !e.altKey) (editor.is ? editSaveButton : saveSnapshotButton).click();
    else if (key == 'o' && e.ctrlKey && !e.shiftKey && !e.altKey) (editor.is ? editLoadButton : loadSnapshotButton).click();
    else return;
    e.preventDefault(); // if anything was activated
});
