// Ensure PATH includes common binary locations so Claude Code CLI is findable
process.env.PATH = [
  process.env.PATH ?? '',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  `${process.env.HOME ?? ''}/.local/bin`,
  `${process.env.HOME ?? ''}/.claude/local`
]
  .filter(Boolean)
  .join(':')

import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PtyManager, type SpawnOptions } from './pty-manager'
import { loadProjects, saveProjects, type StoredProject } from './projects-store'
import { listSessions } from './sessions-store'
import { loadState, saveState, type StoredAppState } from './state-store'
import { loadWindowBounds, attachWindowState } from './window-state'
import { getProjectStats, clearProjectStatsCache } from './project-stats'
import { tabRegistry, type TabInfo } from './tab-registry'
import {
  createMasterAgent,
  type RendererControlAction,
  type RendererControlResult,
  type WorkerActivityEvent
} from './master-agent'
import { setupAutoUpdater, openReleasesPage, manualCheck } from './auto-updater'

const ptyManager = new PtyManager()
let mainWindow: BrowserWindow | null = null

const masterControlPending = new Map<string, (result: RendererControlResult) => void>()

function rendererControl(req: RendererControlAction): Promise<RendererControlResult> {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve({ ok: false, error: 'No window' })
      return
    }
    const requestId = randomUUID()
    masterControlPending.set(requestId, resolve)
    mainWindow.webContents.send('master-control:request', { requestId, ...req })
    setTimeout(() => {
      if (masterControlPending.has(requestId)) {
        masterControlPending.delete(requestId)
        resolve({ ok: false, error: `${req.action} timeout` })
      }
    }, 15000)
  })
}

function broadcastWorkerActivity(event: WorkerActivityEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('master:worker-activity', event)
}

const masterAgent = createMasterAgent({
  ptyManager,
  rendererControl,
  broadcastWorkerActivity
})

function sendAction(action: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('window:action', action)
  }
}

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => sendAction('check-updates')
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        {
          label: 'Resize Clipboard Image',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => sendAction('resize-image')
        },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Map Mode',
          accelerator: 'CmdOrCtrl+M',
          click: () => sendAction('open-map')
        },
        {
          label: 'Quick Switcher',
          accelerator: 'CmdOrCtrl+P',
          click: () => sendAction('quick-switcher')
        },
        {
          label: 'Toggle Master',
          accelerator: 'CmdOrCtrl+J',
          click: () => sendAction('toggle-master')
        },
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'CmdOrCtrl+/',
          click: () => sendAction('help')
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize', accelerator: 'CmdOrCtrl+Alt+M' }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow(): Promise<BrowserWindow> {
  const bounds = await loadWindowBounds()

  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 880,
    minHeight: 540,
    show: false,
    backgroundColor: '#08080b',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    title: 'Simple Claude',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  attachWindowState(win)

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow = win
  setupAutoUpdater(win)
  return win
}

ipcMain.handle('pty:spawn', (event, cwd: string, options?: SpawnOptions) => {
  return ptyManager.spawn(cwd, event.sender, options ?? {})
})

ipcMain.on('pty:write', (_event, id: string, data: string) => {
  ptyManager.write(id, data)
})

ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) => {
  ptyManager.resize(id, cols, rows)
})

ipcMain.on('pty:kill', (_event, id: string) => {
  ptyManager.kill(id)
})

ipcMain.handle('projects:list', async () => {
  return loadProjects()
})

ipcMain.handle('projects:save', async (_event, projects: StoredProject[]) => {
  await saveProjects(projects)
})

ipcMain.handle('sessions:list', async (_event, projectPath: string) => {
  return listSessions(projectPath)
})

ipcMain.handle('stats:get', async (_event, path: string) => {
  return getProjectStats(path)
})

ipcMain.handle('stats:refresh', async (_event, path?: string) => {
  clearProjectStatsCache(path)
})

ipcMain.handle('state:load', async () => {
  return loadState()
})

ipcMain.handle('state:save', async (_event, state: StoredAppState) => {
  await saveState(state)
})

ipcMain.handle('dialog:pickFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = win
    ? await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Select project folder'
      })
    : await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select project folder'
      })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.on('shell:openPath', (_event, path: string) => {
  shell.openPath(path)
})

ipcMain.handle('clipboard:writeText', async (_event, text: string) => {
  clipboard.writeText(text)
})

const IMAGE_MAX_DIM = 1800

ipcMain.handle('clipboard:resizeImage', async () => {
  const img = clipboard.readImage()
  if (img.isEmpty()) {
    return { hadImage: false }
  }
  const size = img.getSize()
  if (size.width <= IMAGE_MAX_DIM && size.height <= IMAGE_MAX_DIM) {
    return {
      hadImage: true,
      resized: false,
      original: size,
      final: size
    }
  }
  const ratio = Math.min(IMAGE_MAX_DIM / size.width, IMAGE_MAX_DIM / size.height)
  const newWidth = Math.round(size.width * ratio)
  const newHeight = Math.round(size.height * ratio)
  const resized = img.resize({ width: newWidth, height: newHeight, quality: 'best' })
  clipboard.writeImage(resized)
  return {
    hadImage: true,
    resized: true,
    original: size,
    final: { width: newWidth, height: newHeight }
  }
})

ipcMain.on('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    app.focus({ steal: true })
  }
})

// Tab registry IPC
ipcMain.on('tab-registry:set', (_event, info: Omit<TabInfo, 'isActive'>) => {
  tabRegistry.set(info)
})
ipcMain.on('tab-registry:remove', (_event, tabId: string) => {
  tabRegistry.remove(tabId)
})
ipcMain.on('tab-registry:setActive', (_event, tabId: string | null) => {
  tabRegistry.setActive(tabId)
})
ipcMain.handle('tab-registry:getAll', () => tabRegistry.getAll())

// Master agent: streaming via webContents.send
ipcMain.handle(
  'master:send-start',
  (
    event,
    message: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): string => {
    const requestId = randomUUID()

    ;(async () => {
      try {
        for await (const evt of masterAgent.runQuery(message, history)) {
          if (event.sender.isDestroyed()) break
          event.sender.send('master:event', { requestId, event: evt })
        }
        if (!event.sender.isDestroyed()) {
          event.sender.send('master:event', { requestId, event: { type: 'done' } })
        }
      } catch (e) {
        if (!event.sender.isDestroyed()) {
          event.sender.send('master:event', {
            requestId,
            event: { type: 'error', error: e instanceof Error ? e.message : String(e) }
          })
        }
      }
    })()

    return requestId
  }
)

// Master-control: renderer responds to project/tab actions requested by master
ipcMain.on(
  'master-control:response',
  (_event, payload: { requestId: string; result: RendererControlResult }) => {
    const resolver = masterControlPending.get(payload.requestId)
    if (resolver) {
      masterControlPending.delete(payload.requestId)
      resolver(payload.result)
    }
  }
)

// Auto-updater IPC
ipcMain.on('updater:open-release', (_event, version?: string) => {
  openReleasesPage(version)
})

ipcMain.handle('updater:check', async () => {
  try {
    await manualCheck()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

app.whenReady().then(() => {
  setupMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  ptyManager.killAll()
  tabRegistry.clear()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
