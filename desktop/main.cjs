const { app, BrowserWindow, dialog } = require('electron');
const { execFile } = require('node:child_process');
const { join } = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);
const cli = app.isPackaged ? join(process.resourcesPath, 'runtime', 'node_modules', 'rivet', 'dist', 'cli', 'main.js') : join(__dirname, '..', 'dist', 'cli', 'main.js');
const node = app.isPackaged ? join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : 'node';
const smoke = process.env.RIVET_DESKTOP_SMOKE === "1";
let window;

function configureUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('update-available', async info => {
    const result = await dialog.showMessageBox({
      type: 'info', buttons: ['Download', 'Later'], defaultId: 1, cancelId: 1,
      message: `Rivet ${info.version} is available. Download it?`,
    });
    if (result.response === 0) void autoUpdater.downloadUpdate().catch(() => {});
  });
  autoUpdater.on('update-not-available', () => {
    void dialog.showMessageBox({ message: 'This Rivet version is up to date.' });
  });
  autoUpdater.on('update-downloaded', async () => {
    const result = await dialog.showMessageBox({
      type: 'info', buttons: ['Install and restart', 'Later'], defaultId: 1, cancelId: 1,
      message: 'The update is ready. Stop your running work before restarting Rivet.',
    });
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', () => {
    void dialog.showMessageBox({ type: 'warning', message: 'Could not check or download the update. Try again later.' });
  });
  const { Menu } = require('electron');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Rivet', submenu: [
      { label: 'Check for updates', click: () => { void autoUpdater.checkForUpdates().catch(() => {}); } },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
  ]));
}

async function openWindow() {
  const { stdout } = await run(node, [cli, 'app', '--no-open'], { cwd: process.env.INIT_CWD || process.cwd(), windowsHide: true, timeout: 30_000 });
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('Rivet is at '));
  const url = new URL(line?.slice('Rivet is at '.length) ?? '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
    throw new Error('Rivet must serve the desktop window from its local daemon.');
  }

  window = new BrowserWindow({
    title: 'Rivet', show: !smoke, width: 1280, height: 850, autoHideMenuBar: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const allowLocal = (event, destination) => {
    try { if (new URL(typeof destination === "string" ? destination : destination?.url ?? event.url).origin === url.origin) return; } catch { /* reject invalid URLs */ }
    event.preventDefault();
  };
  window.webContents.on('will-navigate', allowLocal);
  window.webContents.on('will-redirect', allowLocal);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = undefined; });
  await window.loadURL(url.href);
  configureUpdates();
  if (smoke) {
    const loaded = await window.webContents.executeJavaScript("Boolean(document.querySelector('#root'))");
    if (!loaded) throw new Error("The desktop page did not load the Rivet app.");
    console.log("Rivet desktop app loaded from the local daemon");
    app.quit();
  }
}

function showError(error) {
  if (smoke) console.error(error.message);
  else dialog.showErrorBox('Rivet could not start', error.message);
  app.exit(1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(openWindow).catch(showError);
  app.on('activate', () => { if (!window) void openWindow().catch(showError); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
