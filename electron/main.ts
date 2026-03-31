import { app, BrowserWindow } from 'electron';
import path from 'path';

const createWindow = async (): Promise<void> => {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  const appPath = app.getAppPath();
  const preloadPath = devServerUrl
    ? path.join(appPath, 'electron', 'preload.ts')
    : path.join(appPath, 'dist-electron', 'preload.js');

  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(appPath, 'dist', 'index.html'));
  }
};

app.whenReady().then(async () => {
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
