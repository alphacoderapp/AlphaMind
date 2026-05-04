import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import { shell } from 'electron'

const RELEASES_BASE = 'https://github.com/alphacoderapp/AlphaMind/releases'

export function setupAutoUpdater(win: BrowserWindow): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    safeSend(win, 'updater:event', { type: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    safeSend(win, 'updater:event', {
      type: 'available',
      version: info.version,
      releaseUrl: `${RELEASES_BASE}/tag/v${info.version}`
    })
  })

  autoUpdater.on('update-not-available', () => {
    safeSend(win, 'updater:event', { type: 'not-available' })
  })

  autoUpdater.on('error', (err) => {
    safeSend(win, 'updater:event', {
      type: 'error',
      error: err instanceof Error ? err.message : String(err)
    })
  })

  // Run check after small delay so it doesn't block startup
  setTimeout(() => {
    autoUpdater
      .checkForUpdates()
      .catch((err) => console.error('Auto-update check failed:', err))
  }, 5000)
}

export function openReleasesPage(version?: string): void {
  const url = version ? `${RELEASES_BASE}/tag/v${version}` : RELEASES_BASE
  shell.openExternal(url)
}

export function manualCheck(): Promise<unknown> {
  return autoUpdater.checkForUpdates().catch((err) => {
    console.error('Manual update check failed:', err)
    throw err
  })
}

function safeSend(win: BrowserWindow, channel: string, payload: unknown): void {
  if (!win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}
