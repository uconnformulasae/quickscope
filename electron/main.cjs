/**
 * QuickScope — Electron main process
 *
 * Spawns the PyInstaller-frozen Python backend as a sidecar, waits for it to
 * become ready, then opens a BrowserWindow loading the built Vite bundle.
 */

const { app, BrowserWindow, shell, dialog, Menu, protocol, screen, net: electronNet } = require('electron');
const { initialWindowBounds, fitBoundsToWorkArea } = require('./window-size.cjs');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const isDev = !app.isPackaged;
const BACKEND_HOST = '127.0.0.1';

// The built UI is served from app://quickscope/ rather than file://. Pages on
// file:// send `Origin: null`, which any website can also produce (sandboxed
// iframe), so the backend would have to trust every site. This origin is one
// only this app can send; backend/origins.py allows exactly it.
const APP_SCHEME = 'app';
const APP_HOST = 'quickscope';
const APP_INDEX_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
const RENDERER_DIR = path.join(__dirname, '..', 'dist', 'public');

// Must run before `ready`. `standard` gives the scheme a real origin;
// `secure` + `supportFetchAPI` let the page use fetch/WebSocket like https.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let backendProcess = null;
let backendPort = null;
let mainWindow = null;

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Find a free TCP port on localhost. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, BACKEND_HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Resolve the path to the frozen backend executable inside the packaged app. */
function resolveBackendExecutable() {
  if (isDev) {
    // Dev mode: expect a prebuilt backend in backend/dist/ (optional).
    // If absent, the dev user should run `./start.sh` instead.
    const devDist = path.join(
      __dirname,
      '..',
      'backend',
      'dist',
      'quickscope-backend',
      process.platform === 'win32' ? 'quickscope-backend.exe' : 'quickscope-backend',
    );
    return fs.existsSync(devDist) ? devDist : null;
  }

  // Packaged mode: electron-builder copies backend via extraResources.
  const exeName =
    process.platform === 'win32' ? 'quickscope-backend.exe' : 'quickscope-backend';
  return path.join(process.resourcesPath, 'backend', exeName);
}

/** Poll the backend's health route until it answers as QuickScope, or the timeout elapses.
 *
 *  The port was picked a moment before the backend bound it, so another
 *  program can get there first. Any reply at all used to count as "ready";
 *  now only the backend's own answer does. */
function waitForBackend(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      // One request can report failure twice (timeout, then the error from
      // destroying it); only the first may schedule the next try.
      let finished = false;
      const next = () => {
        if (finished) return;
        finished = true;
        if (Date.now() > deadline) reject(new Error('Backend did not start within timeout'));
        else setTimeout(attempt, 250);
      };
      const req = http.get(
        { host: BACKEND_HOST, port, path: '/api/health', timeout: 1000 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < 4096) body += chunk;
          });
          res.on('end', () => {
            let isBackend = false;
            try {
              isBackend = res.statusCode === 200 && JSON.parse(body).app === 'quickscope';
            } catch {
              // not JSON: not ours
            }
            if (!isBackend) return next();
            finished = true;
            resolve();
          });
          res.on('error', next);
        },
      );
      req.on('error', next);
      req.on('timeout', () => {
        req.destroy();
        next();
      });
    };
    attempt();
  });
}

// ─── Backend lifecycle ────────────────────────────────────────────────────────

async function startBackend() {
  const exe = resolveBackendExecutable();
  if (!exe || !fs.existsSync(exe)) {
    if (isDev) {
      // Dev fallback: assume `./start.sh` is running the backend on :8000
      backendPort = 8000;
      return;
    }
    throw new Error(`Backend executable not found at ${exe}`);
  }

  backendPort = await findFreePort();

  const userDataDir = app.getPath('userData');
  const dataDir = path.join(userDataDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const env = {
    ...process.env,
    QUICKSCOPE_HOST: BACKEND_HOST,
    QUICKSCOPE_PORT: String(backendPort),
    QUICKSCOPE_DATA_DIR: dataDir,
    // The backend exits when its stdin closes (see backend/entry.py). That is
    // the only signal it gets if this process dies without running any quit
    // handler: a crash, a force-kill, or a Windows logoff.
    QUICKSCOPE_EXIT_WITH_PARENT: '1',
  };

  if (!isDev) {
    // Installers ship libxrk only; MatLabXRK DLL is dev / CI-test tooling on Windows.
    env.QUICKSCOPE_PARSER = 'libxrk';
  }

  backendProcess = spawn(exe, [], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const logFile = path.join(userDataDir, 'backend.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  backendProcess.stdout.pipe(logStream);
  backendProcess.stderr.pipe(logStream);

  backendProcess.on('exit', (code, signal) => {
    logStream.end();
    backendProcess = null;
    // `code` is null when a signal killed it; that is just as unexpected.
    if (code !== 0 && !app.isQuitting) {
      dialog.showErrorBox(
        'QuickScope backend stopped',
        `The backend exited unexpectedly (code ${code}, signal ${signal}). See ${logFile} for details.`,
      );
      app.quit();
    }
  });

  await waitForBackend(backendPort);
}

function stopBackend() {
  if (!backendProcess) return;
  try {
    if (process.platform === 'win32') {
      // On Windows, SIGTERM doesn't cascade — use taskkill to end the tree.
      spawn('taskkill', ['/pid', String(backendProcess.pid), '/f', '/t']);
    } else {
      backendProcess.kill('SIGTERM');
      setTimeout(() => {
        if (backendProcess) backendProcess.kill('SIGKILL');
      }, 3000);
    }
  } catch (err) {
    console.error('Failed to stop backend:', err);
  }
}

// ─── Renderer protocol ────────────────────────────────────────────────────────

/** Serve files under RENDERER_DIR for app://quickscope/<path>; nothing else. */
function registerAppProtocol() {
  protocol.handle(APP_SCHEME, (request) => {
    const { host, pathname } = new URL(request.url);
    if (host !== APP_HOST) return new Response('Not found', { status: 404 });
    const relPath = decodeURIComponent(pathname) === '/' ? 'index.html' : decodeURIComponent(pathname);
    const filePath = path.resolve(RENDERER_DIR, `.${path.posix.normalize(`/${relPath}`)}`);
    const rel = path.relative(RENDERER_DIR, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('Forbidden', { status: 403 });
    }
    return electronNet.fetch(pathToFileURL(filePath).toString());
  });
}

// ─── Window ───────────────────────────────────────────────────────────────────

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Open a URL in the system browser, but only for web/mail links (never file:, smb:, javascript:, ...). */
function openExternalSafely(url) {
  try {
    if (SAFE_EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    // malformed URL: ignore
  }
}

/** Keep the window on-screen when the resolution or display layout changes
 *  (monitor unplugged, scaling changed, dock resized). */
function refitWindowToDisplay() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFullScreen() || mainWindow.isMaximized()) return;
  const bounds = mainWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  mainWindow.setMinimumSize(Math.min(1024, workArea.width), Math.min(640, workArea.height));
  const fitted = fitBoundsToWorkArea(bounds, workArea);
  if (fitted) mainWindow.setBounds(fitted);
}

function createWindow() {
  // Size to the display the user is on (where the cursor is), not a fixed size.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const initial = initialWindowBounds(workArea);
  mainWindow = new BrowserWindow({
    ...initial,
    backgroundColor: '#0b0d12',
    title: 'QuickScope',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // preload only needs contextBridge + process.argv, both available when sandboxed
      additionalArguments: [`--quickscope-backend=http://${BACKEND_HOST}:${backendPort}`],
    },
  });

  // External links open in the system browser, not a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  // The renderer must never navigate away from the app (it keeps preload access);
  // reloads and same-origin dev-server navigation are still allowed.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const current = new URL(mainWindow.webContents.getURL());
      // Compare scheme + host rather than URL.origin, which Node reports as
      // "null" for non-special schemes like app:.
      const sameApp = target.protocol === current.protocol && target.host === current.host;
      if (sameApp) return;
    } catch {
      // fall through and block
    }
    event.preventDefault();
    openExternalSafely(url);
  });

  mainWindow.webContents.on('will-frame-navigate', (event) => {
    event.preventDefault();
  });

  if (isDev && process.env.QUICKSCOPE_DEV_URL) {
    mainWindow.loadURL(process.env.QUICKSCOPE_DEV_URL);
  } else {
    mainWindow.loadURL(APP_INDEX_URL);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.on('before-quit', () => {
  app.isQuitting = true;
  stopBackend();
});

// `before-quit` only fires for a normal quit. Cover the other ways out so the
// backend is never left running on its port.
app.on('will-quit', stopBackend);
process.on('exit', stopBackend);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    app.isQuitting = true;
    stopBackend();
    app.quit();
  });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.whenReady().then(async () => {
  // Standard app menu (copy/paste/DevTools/etc.)
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
  registerAppProtocol();

  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox(
      'QuickScope failed to start',
      `Could not start the backend: ${err.message || err}\n\nSee the log at:\n${path.join(
        app.getPath('userData'),
        'backend.log',
      )}`,
    );
    app.quit();
    return;
  }

  createWindow();
  // `screen` is only usable after ready.
  screen.on('display-metrics-changed', refitWindowToDisplay);
  screen.on('display-removed', refitWindowToDisplay);
});

function buildMenuTemplate() {
  const isMac = process.platform === 'darwin';
  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
}
