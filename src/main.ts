import './assets/main.css';

export const main = document.getElementById('main') as HTMLDivElement;

export const canvas = document.getElementById('canvas') as HTMLCanvasElement;

import { WGPUSoftbodyEngine } from './engine';
import { Vector2D } from './engineMapping';

// oof
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

const game = new WGPUSoftbodyEngine(canvas, 800);

Object.defineProperty(window, 'save', {
    value: downloadSnapshot
})

document.getElementById('loadSnapButton')!.addEventListener('click', (e) => uploadSnapshot());
document.getElementById('saveSnapButton')!.addEventListener('click', (e) => downloadSnapshot());
async function downloadSnapshot() {
    const blob = new Blob([await game.saveSnapshot()]);
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
        await game.loadSnapshot(await file.arrayBuffer());
    });
    input.click();
}

// buh inputs
const userInput = {
    appliedForce: new Vector2D(0, 0),
    mousePos: new Vector2D(0, 0),
    mouseActive: false,
    touchActive: false
};
const sendUserInput = throttle(() => {
    game.setUserInput(userInput.appliedForce, userInput.mousePos, userInput.mouseActive || userInput.touchActive);
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