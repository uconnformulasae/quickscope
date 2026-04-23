/**
 * QuickScope — Electron preload
 *
 * Runs before the renderer scripts load. Its only job is to expose the backend
 * URL (chosen by main.js and passed via --quickscope-backend=...) to the
 * renderer so api.ts can read it as window.__QUICKSCOPE_BACKEND__.
 */

const { contextBridge } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--quickscope-backend='));
const backendUrl = arg ? arg.slice('--quickscope-backend='.length) : null;

if (backendUrl) {
  contextBridge.exposeInMainWorld('__QUICKSCOPE_BACKEND__', backendUrl);
}
