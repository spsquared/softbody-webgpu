import './assets/main.css';

import { WGPUSoftbodyEngine, WGPUSoftbodyEngineOptions, WGPUSoftbodyEnginePhysicsConstants } from './engine';
import { Vector2D } from './engineMapping';

export const main = document.getElementById('main') as HTMLDivElement;
export const canvas = document.getElementById('canvas') as HTMLCanvasElement;

type Mutable<T> = {
    -readonly [P in keyof T]: T[P]
}

const resolution = 800;
const game: {
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
game.instance.setPhysicsConstants(game.constants);

document.getElementById('loadSnapButton')!.addEventListener('click', (e) => uploadSnapshot());
document.getElementById('saveSnapButton')!.addEventListener('click', (e) => downloadSnapshot());
async function downloadSnapshot() {
    const blob = new Blob([await game.instance.saveSnapshot()]);
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
        await game.instance.loadSnapshot(await file.arrayBuffer());
        const constants = await game.instance.getPhysicsConstants();
        // changing the object to a new object borks stuff so we do this thing
        for (let i in constants) game.constants[i] = constants[i];
        loadClamps();
        updateClamps();
    });
    input.click();
}

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
// game.options
createClampedInput(document.getElementById('particleRadius') as HTMLInputElement, 1, 500, 1, game.options);
createClampedInput(document.getElementById('subticks') as HTMLInputElement, 2, 192, 2, game.options);
// constants
createClampedInput(document.getElementById('gravityX') as HTMLInputElement, -10, 10, 0.02, (v) => ((v !== undefined && (game.constants.gravity = new Vector2D(v, game.constants.gravity.y))), game.constants.gravity.x));
createClampedInput(document.getElementById('gravityY') as HTMLInputElement, -10, 10, 0.02, (v) => ((v !== undefined && (game.constants.gravity = new Vector2D(game.constants.gravity.x, v))), game.constants.gravity.y));
createClampedInput(document.getElementById('borderElasticity') as HTMLInputElement, 0, 1, 0.01, game.constants);
createClampedInput(document.getElementById('borderFriction') as HTMLInputElement, 0, 100, 0.01, game.constants);
createClampedInput(document.getElementById('elasticity') as HTMLInputElement, 0, 1, 0.01, game.constants);
createClampedInput(document.getElementById('friction') as HTMLInputElement, 0, 100, 0.01, game.constants);
createClampedInput(document.getElementById('dragCoeff') as HTMLInputElement, 0, 2 ** 32, 0.001, game.constants);
createClampedInput(document.getElementById('dragExp') as HTMLInputElement, 1, 4, 0.1, game.constants);
// oof
loadClamps();
updateClamps();
document.getElementById('applyOptions')?.addEventListener('click', () => {
    game.instance.destroy();
    game.instance = new WGPUSoftbodyEngine(canvas, resolution, game.options);
    game.instance.setPhysicsConstants(game.constants);
});
document.getElementById('applyConstants')?.addEventListener('click', () => game.instance.setPhysicsConstants(game.constants));

// buh inputs
function throttle<F extends (...args: any[]) => void>(fn: F, ms: number): (...args: Parameters<F>) => void {
    let timeout: NodeJS.Timeout = setTimeout(() => { });
    let lastUpdate = 0;
    return function throttled(...args: Parameters<F>) {
        clearTimeout(timeout);
        if (performance.now() - lastUpdate >= ms) {
            fn(...args);
            lastUpdate = performance.now();
        } else {
            timeout = setTimeout(() => {
                fn(...args);
                lastUpdate = performance.now();
            }, ms - performance.now() + lastUpdate);
        }
    };
}
const userInput = {
    appliedForce: new Vector2D(0, 0),
    mousePos: new Vector2D(0, 0),
    mouseActive: false,
    touchActive: false
};
const sendUserInput = throttle(() => {
    game.instance.setUserInput(userInput.appliedForce, userInput.mousePos, userInput.mouseActive || userInput.touchActive);
}, 10);
function updateMouse(e: MouseEvent | Touch) {
    const rect = canvas.getBoundingClientRect();
    userInput.mousePos = new Vector2D((e.clientX - rect.x) / rect.width, 1 - (e.clientY - rect.y) / rect.height);
    sendUserInput();
}
document.addEventListener('mousedown', (e) => {
    if (e.button == 0) userInput.mouseActive = true;
    updateMouse(e);
});
document.addEventListener('mouseup', (e) => {
    if (e.button == 0) userInput.mouseActive = false;
    updateMouse(e);
});
document.addEventListener('mousemove', (e) => {
    updateMouse(e);
});
document.addEventListener('touchstart', (e) => {
    updateMouse(e.touches[0]);
    userInput.touchActive = true;
    sendUserInput();
});
document.addEventListener('touchend', () => {
    userInput.touchActive = false;
    sendUserInput();
});
document.addEventListener('touchcancel', () => {
    userInput.touchActive = false;
    sendUserInput();
});
document.addEventListener('touchmove', (e) => {
    updateMouse(e.touches[0]);
    e.preventDefault();
}, { passive: false });
const heldKeys: Record<string, number> = {};
function updateKeyboard() {
    userInput.appliedForce = new Vector2D(
        (heldKeys['d'] ?? 0) - (heldKeys['a'] ?? 0),
        (heldKeys['w'] ?? 0) - (heldKeys['s'] ?? 0)
    );
    sendUserInput();
}
document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && e.target.matches('input,button,textarea,select')) return;
    heldKeys[e.key.toLowerCase()] = 1;
    updateKeyboard();
});
document.addEventListener('keyup', (e) => {
    heldKeys[e.key.toLowerCase()] = 0;
    updateKeyboard();
});
document.addEventListener('blur', () => {
    userInput.mouseActive = false;
    sendUserInput();
});