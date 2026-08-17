import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpc, restoreMcpConnections } from './ipc'
import { mcpManager } from './mcp-manager'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)

app.setName('Ollama MCP')

function resourcesDir(): string {
  // Dev / electron-vite preview: project root. Packaged: next to the app binary.
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
}

function resolveAppIconPath(): string | undefined {
  const dir = resourcesDir()
  const candidates =
    process.platform === 'darwin'
      ? [join(dir, 'icon.icns'), join(dir, 'icon.png')]
      : process.platform === 'win32'
        ? [join(dir, 'icon.ico'), join(dir, 'icon.png')]
        : [join(dir, 'icon.png')]
  return candidates.find((p) => existsSync(p))
}

function createWindow(): void {
  const iconPath = resolveAppIconPath()
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Ollama MCP',
    ...(iconPath ? { icon: iconPath } : {}),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 16 }
        }
      : process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: {
              color: '#121820',
              symbolColor: '#c5d0dc',
              height: 40
            }
          }
        : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  // Cmd+Option+I (macOS) / Ctrl+Shift+I (Windows/Linux)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isToggle =
      input.type === 'keyDown' &&
      input.key.toLowerCase() === 'i' &&
      ((process.platform === 'darwin' && input.meta && input.alt) ||
        (process.platform !== 'darwin' && input.control && input.shift))
    if (isToggle) {
      mainWindow.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  if (isDev) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Dock icon in dev (macOS ignores BrowserWindow.icon for the dock).
  if (process.platform === 'darwin' && app.dock) {
    const png = join(resourcesDir(), 'icon.png')
    const iconPath = existsSync(png) ? png : resolveAppIconPath()
    if (iconPath) {
      const image = nativeImage.createFromPath(iconPath)
      if (!image.isEmpty()) app.dock.setIcon(image)
    }
  }

  registerIpc(ipcMain)
  await restoreMcpConnections()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  void mcpManager.disconnectAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
