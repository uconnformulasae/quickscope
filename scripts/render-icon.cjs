// Renders build/icon.svg to build/icon.png (1024x1024, transparent corners).
// Usage: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  let image = await win.webContents.capturePage();
  const { width, height } = image.getSize();
  if (width !== SIZE || height !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), image.toPNG());
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
