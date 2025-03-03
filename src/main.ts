import './assets/main.css';

export const main = document.getElementById('main') as HTMLDivElement;

export const canvas = document.getElementById('canvas') as HTMLCanvasElement;

import { WGPUSoftbodyEngine } from './engine';

const game = new WGPUSoftbodyEngine(canvas, 800);