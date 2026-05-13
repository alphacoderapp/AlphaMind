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

import { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Menu, desktopCapturer, screen } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync, renameSync } from 'fs'
import { homedir } from 'os'
import { PtyManager, type SpawnOptions } from './pty-manager'
import { loadProjects, saveProjects, type StoredProject } from './projects-store'
import { listSessions } from './sessions-store'
import { loadState, saveState, type StoredAppState } from './state-store'
import { loadWindowBounds, attachWindowState, setWindowStateSavePaused } from './window-state'
import { getProjectStats, clearProjectStatsCache } from './project-stats'
import { tabRegistry, type TabInfo } from './tab-registry'
import {
  createMasterAgent,
  type RendererControlAction,
  type RendererControlResult,
  type WorkerActivityEvent
} from './master-agent'
import { setupAutoUpdater, openReleasesPage, manualCheck } from './auto-updater'
import {
  loadMasterHistory,
  saveMasterHistory,
  type StoredMasterMessage
} from './master-history-store'
import { saveUpload, cleanupOldUploads, type SavedUpload } from './uploads-store'
import iconAsset from '../../resources/icon.png?asset'

// Swallow harmless EPIPE crashes from the main process. These happen when a
// PTY child exits, electron-vite reloads, or any other path where Node tries
// to write a process warning / log line after the receiving pipe (stdout,
// stderr, or another stream) has already closed. Without this handler
// Electron pops a "JavaScript error in main process" modal and the user
// thinks the app crashed even though nothing important failed. Real bugs
// still surface — only the specific EPIPE-on-write pattern is silenced.
process.on('uncaughtException', (err: Error & { code?: string; syscall?: string }) => {
  if (err && err.code === 'EPIPE' && (err.syscall === 'write' || !err.syscall)) {
    return
  }
  // Re-throw so dev sees real bugs and the default Electron handler runs.
  setImmediate(() => {
    throw err
  })
})
// Mirror for stdout/stderr — the streams themselves may emit 'error' before
// uncaughtException fires. Detaching listeners prevents the default crash.
const swallowStreamEpipe = (stream: NodeJS.WriteStream): void => {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e && e.code === 'EPIPE') return
  })
}
swallowStreamEpipe(process.stdout)
swallowStreamEpipe(process.stderr)

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
    title: 'Alphacod',
    icon: iconAsset,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      webviewTag: true
    }
  })

  attachWindowState(win)

  // Block accidental Cmd+R / Cmd+Shift+R reload — destructive for a desktop app
  // (would kill PTYs, lose master history buffer, etc). DevTools still allowed.
  win.webContents.on('before-input-event', (event, input) => {
    if (
      (input.meta || input.control) &&
      input.key.toLowerCase() === 'r'
    ) {
      event.preventDefault()
    }
  })

  // showInactive instead of show: app appears but does NOT activate / steal
  // focus from whatever the user is currently working in. macOS dock icon
  // still appears, user can switch to Alphacod when they're ready. Plain
  // show() was forcing the window forward on every launch — combined with
  // re-launches during dev / electron-updater this looked like the app was
  // "pulling itself into focus".
  win.on('ready-to-show', () => win.showInactive())

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

ipcMain.handle('path:exists', async (_event, p: string) => {
  try {
    const { stat } = await import('fs/promises')
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
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

ipcMain.on('shell:openExternal', (_event, url: string) => {
  void shell.openExternal(url)
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

// Mini Mode: shrink window to a 380×500 always-on-top float in the
// bottom-right, hide the macOS traffic lights so the titlebar reads as a
// pure drag handle. Frame can't be toggled at runtime in Electron, so we
// fake "frameless" by hiding the window buttons and letting the renderer
// collapse the chrome down to a thin draggable strip + MasterPane.
let preMiniBounds: Electron.Rectangle | null = null
let preMiniAlwaysOnTop = false
let isMiniMode = false

ipcMain.handle('window:setMiniMode', (_event, enabled: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
  const win = mainWindow
  if (enabled && !isMiniMode) {
    preMiniBounds = win.getBounds()
    preMiniAlwaysOnTop = win.isAlwaysOnTop()
    // Pause persistence so the mini bounds never overwrite the real
    // remembered size. We restore them on exit.
    setWindowStateSavePaused(true)
    win.setMinimumSize(320, 360)
    const display = require('electron').screen.getDisplayNearestPoint(
      win.getBounds()
    )
    const work = display.workArea
    const w = 420
    const h = 540
    const margin = 20
    win.setBounds({
      x: work.x + work.width - w - margin,
      y: work.y + work.height - h - margin,
      width: w,
      height: h
    })
    win.setAlwaysOnTop(true, 'floating')
    if (process.platform === 'darwin') {
      try {
        win.setWindowButtonVisibility(false)
      } catch {
        // older electron versions: ignore
      }
    }
    isMiniMode = true
    return { ok: true, mini: true }
  }
  if (!enabled && isMiniMode) {
    win.setMinimumSize(880, 540)
    if (preMiniBounds) win.setBounds(preMiniBounds)
    win.setAlwaysOnTop(preMiniAlwaysOnTop)
    if (process.platform === 'darwin') {
      try {
        win.setWindowButtonVisibility(true)
      } catch {
        // ignore
      }
    }
    isMiniMode = false
    // Resume persistence with the restored bounds.
    setWindowStateSavePaused(false)
    return { ok: true, mini: false }
  }
  return { ok: true, mini: isMiniMode }
})

ipcMain.on('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Restore from minimised, but never raise/show — both push the window in
    // front of whatever the user is currently using. The renderer can still
    // switch the active tab internally; bringing the OS window forward is
    // the user's choice via dock click.
    if (mainWindow.isMinimized()) mainWindow.restore()
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
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
    attachmentPaths?: string[]
  ): string => {
    const requestId = randomUUID()

    ;(async () => {
      try {
        for await (const evt of masterAgent.runQuery(message, history, attachmentPaths)) {
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

// Uploads: drag-drop file attachment storage shared by both chats.
ipcMain.handle(
  'uploads:save',
  async (
    _event,
    payload: { name: string; mimeType: string; data: ArrayBuffer }
  ): Promise<SavedUpload> => {
    return saveUpload(payload.name, payload.mimeType, new Uint8Array(payload.data))
  }
)

// Screen capture — snap primary display and save into uploads pipeline so
// the Master agent can receive it as an attachment exactly like a drag-drop
// image. macOS users get a Screen Recording permission prompt on first run.
ipcMain.handle('screen:capture', async (): Promise<SavedUpload | { error: string }> => {
  try {
    const primary = screen.getPrimaryDisplay()
    const { width, height } = primary.size
    const scale = primary.scaleFactor || 1
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * scale),
        height: Math.round(height * scale)
      }
    })
    const target =
      sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
    if (!target) {
      return { error: 'No screen source available' }
    }
    const png = target.thumbnail.toPNG()
    if (png.length === 0) {
      return {
        error:
          'Empty capture — likely missing Screen Recording permission in System Settings → Privacy & Security'
      }
    }
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19)
    return await saveUpload(`screen-${stamp}.png`, 'image/png', new Uint8Array(png))
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('master:history-load', async () => {
  return loadMasterHistory()
})

ipcMain.handle('master:history-save', async (_event, messages: StoredMasterMessage[]) => {
  await saveMasterHistory(messages)
})

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

// One-time rebrand migration: Simple Claude → Alphacod. Move existing data
// dirs over so users don't lose history/projects/state when upgrading.
function migrateRebrand(): void {
  const home = homedir()
  const oldDot = join(home, '.simple-claude')
  const newDot = join(home, '.alphacod')
  if (!existsSync(newDot) && existsSync(oldDot)) {
    try {
      renameSync(oldDot, newDot)
      console.log('Migrated ~/.simple-claude → ~/.alphacod')
    } catch (e) {
      console.error('dotfile migration failed:', e)
    }
  }
  if (process.platform === 'darwin') {
    const oldUd = join(home, 'Library/Application Support/Simple Claude')
    const newUd = app.getPath('userData')
    if (!existsSync(newUd) && existsSync(oldUd)) {
      try {
        renameSync(oldUd, newUd)
        console.log(`Migrated userData ${oldUd} → ${newUd}`)
      } catch (e) {
        console.error('userData migration failed:', e)
      }
    }
  }
}

app.whenReady().then(() => {
  migrateRebrand()
  // In dev mode the macOS dock shows the Electron default icon; force the
  // brand mark. Packaged builds get the icon from the embedded .icns and
  // calling setIcon there is a no-op anyway.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try {
      app.dock.setIcon(iconAsset)
    } catch (e) {
      console.warn('dock.setIcon failed:', e)
    }
  }
  setupMenu()
  createWindow()
  // Sweep stale uploads (older than 7 days) on every launch.
  void cleanupOldUploads().catch((e) => console.error('upload cleanup failed:', e))

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
