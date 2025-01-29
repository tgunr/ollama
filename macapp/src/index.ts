import { spawn, ChildProcess } from 'child_process'
import { app, autoUpdater, dialog, Tray, Menu, BrowserWindow, MenuItemConstructorOptions, nativeTheme } from 'electron'
import Store from 'electron-store'
import winston from 'winston'
import 'winston-daily-rotate-file'
import * as path from 'path'
import * as fs from 'fs'

import { v4 as uuidv4 } from 'uuid'
import { installed } from './install'

require('@electron/remote/main').initialize()

if (require('electron-squirrel-startup')) {
  app.quit()
}

const store = new Store()

let welcomeWindow: BrowserWindow | null = null

declare const MAIN_WINDOW_WEBPACK_ENTRY: string

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(app.getPath('home'), '.ollama', 'logs', 'server.log'),
      maxsize: 1024 * 1024 * 20,
      maxFiles: 5,
    }),
  ],
  format: winston.format.printf((info: winston.Logform.TransformableInfo) => info.message as string),
})

app.on('ready', () => {
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.exit(0)
    return
  }

  app.on('second-instance', () => {
    if (app.hasSingleInstanceLock()) {
      app.releaseSingleInstanceLock()
    }

    if (proc) {
      proc.off('exit', restart)
      proc.kill()
    }

    app.exit(0)
  })

  app.focus({ steal: true })

  init()
})

function firstRunWindow() {
  // Create the browser window.
  welcomeWindow = new BrowserWindow({
    width: 400,
    height: 500,
    frame: false,
    fullscreenable: false,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  require('@electron/remote/main').enable(welcomeWindow.webContents)

  welcomeWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)
  welcomeWindow.on('ready-to-show', () => welcomeWindow.show())
  welcomeWindow.on('closed', () => {
    if (process.platform === 'darwin') {
      app.dock.hide()
    }
  })
}

let tray: Tray | null = null
let updateAvailable = false
const assetPath = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'assets')

function trayIconPath() {
  return nativeTheme.shouldUseDarkColors
    ? updateAvailable
      ? path.join(assetPath, 'iconDarkUpdateTemplate.png')
      : path.join(assetPath, 'iconDarkTemplate.png')
    : updateAvailable
    ? path.join(assetPath, 'iconUpdateTemplate.png')
    : path.join(assetPath, 'iconTemplate.png')
}

function updateTrayIcon() {
  if (tray) {
    tray.setImage(trayIconPath())
  }
}

function updateTray() {
  const updateItems: MenuItemConstructorOptions[] = [
    { label: 'An update is available', enabled: false },
    {
      label: 'Restart to update',
      click: () => autoUpdater.quitAndInstall(),
    },
    { type: 'separator' },
  ]

  const menu = Menu.buildFromTemplate([
    ...(updateAvailable ? updateItems : []),
    { role: 'quit', label: 'Quit Ollama', accelerator: 'Command+Q' },
  ])

  if (!tray) {
    tray = new Tray(trayIconPath())
  }

  tray.setToolTip(updateAvailable ? 'An update is available' : 'Ollama')
  tray.setContextMenu(menu)
  tray.setImage(trayIconPath())

  nativeTheme.off('updated', updateTrayIcon)
  nativeTheme.on('updated', updateTrayIcon)
}

let proc: ChildProcess = null

function server() {
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, 'ollama')
    : path.resolve(process.cwd(), '..', 'ollama')

  logger.info(`Starting ollama server with binary: ${binary}`)
  logger.info(`Current working directory: ${process.cwd()}`)

  // Ensure the .ollama directory exists with proper permissions
  const ollamaDir = path.join(app.getPath('home'), '.ollama')
  const modelsDir = path.join(ollamaDir, 'models')

  try {
    if (!fs.existsSync(ollamaDir)) {
      fs.mkdirSync(ollamaDir, { recursive: true, mode: 0o755 })
    }
    
    // Just ensure models directory has correct permissions
    if (fs.existsSync(modelsDir)) {
      fs.chmodSync(modelsDir, 0o755)
    }
  } catch (error) {
    logger.error(`Failed to setup ollama directories: ${error.message}`)
  }

  // Set environment variables
  const env = {
    ...process.env,
    OLLAMA_MODELS: modelsDir,
    OLLAMA_ORIGINS: '*',
    OLLAMA_HOST: 'http://127.0.0.1:11434',
    PATH: process.env.PATH,
    HOME: app.getPath('home')
  }

  logger.info(`Environment variables: ${JSON.stringify(env, null, 2)}`)

  try {
    // Ensure the binary is executable
    try {
      fs.chmodSync(binary, 0o755)
    } catch (error) {
      logger.error(`Failed to set binary permissions: ${error.message}`)
    }

    proc = spawn(binary, ['serve'], { 
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    if (!proc.pid) {
      throw new Error('Failed to start server process')
    }

    logger.info(`Server process started with PID: ${proc.pid}`)

    proc.stdout.on('data', data => {
      logger.info(`[stdout] ${data.toString().trim()}`)
    })

    proc.stderr.on('data', data => {
      logger.error(`[stderr] ${data.toString().trim()}`)
    })

    proc.on('error', (err) => {
      logger.error(`Failed to start server: ${err.message}`)
      if (err.message.includes('EACCES')) {
        logger.error('Permission denied. Please check file permissions.')
      }
    })

    proc.on('exit', (code, signal) => {
      logger.info(`Server process exited with code ${code} and signal ${signal}`)
      // Only restart if it wasn't intentionally killed
      if (signal !== 'SIGTERM' && signal !== 'SIGINT') {
        restart()
      }
    })

    // Add a cleanup handler
    process.on('exit', () => {
      if (proc) {
        proc.kill()
      }
    })
  } catch (error) {
    logger.error(`Exception while starting server: ${error.message}`)
    throw error
  }
}

function restart() {
  setTimeout(server, 1000)
}

app.on('before-quit', () => {
  if (proc) {
    proc.off('exit', restart)
    proc.kill('SIGINT') // send SIGINT signal to the server, which also stops any loaded llms
  }
})

const updateURL = `https://ollama.ai/api/update?os=${process.platform}&arch=${
  process.arch
}&version=${app.getVersion()}&id=${id()}`

let latest = ''
async function isNewReleaseAvailable() {
  try {
    const response = await fetch(updateURL)

    if (!response.ok) {
      return false
    }

    if (response.status === 204) {
      return false
    }

    const data = await response.json()

    const url = data?.url
    if (!url) {
      return false
    }

    if (latest === url) {
      return false
    }

    latest = url

    return true
  } catch (error) {
    logger.error(`update check failed - ${error}`)
    return false
  }
}

async function checkUpdate() {
  const available = await isNewReleaseAvailable()
  if (available) {
    logger.info('checking for update')
    autoUpdater.checkForUpdates()
  }
}

function init() {
  if (app.isPackaged) {
    checkUpdate()
    setInterval(() => {
      checkUpdate()
    }, 60 * 60 * 1000)
  }

  updateTray()

  if (process.platform === 'darwin') {
    if (app.isPackaged) {
      if (!app.isInApplicationsFolder()) {
        const chosen = dialog.showMessageBoxSync({
          type: 'question',
          buttons: ['Move to Applications', 'Do Not Move'],
          message: 'Ollama works best when run from the Applications directory.',
          defaultId: 0,
          cancelId: 1,
        })

        if (chosen === 0) {
          try {
            app.moveToApplicationsFolder({
              conflictHandler: conflictType => {
                if (conflictType === 'existsAndRunning') {
                  dialog.showMessageBoxSync({
                    type: 'info',
                    message: 'Cannot move to Applications directory',
                    detail:
                      'Another version of Ollama is currently running from your Applications directory. Close it first and try again.',
                  })
                }
                return true
              },
            })
            return
          } catch (e) {
            logger.error(`[Move to Applications] Failed to move to applications folder - ${e.message}}`)
          }
        }
      }
    }
  }

  server()

  if (store.get('first-time-run') && installed()) {
    if (process.platform === 'darwin') {
      app.dock.hide()
    }

    app.setLoginItemSettings({ openAtLogin: app.getLoginItemSettings().openAtLogin })
    return
  }

  // This is the first run or the CLI is no longer installed
  app.setLoginItemSettings({ openAtLogin: true })
  firstRunWindow()
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function id(): string {
  const id = store.get('id') as string

  if (id) {
    return id
  }

  const uuid = uuidv4()
  store.set('id', uuid)
  return uuid
}

autoUpdater.setFeedURL({ url: updateURL })

autoUpdater.on('error', e => {
  logger.error(`update check failed - ${e.message}`)
  console.error(`update check failed - ${e.message}`)
})

autoUpdater.on('update-downloaded', () => {
  updateAvailable = true
  updateTray()
})
