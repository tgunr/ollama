import { spawn, ChildProcess } from 'child_process'
import { app, autoUpdater, dialog, Tray, Menu, BrowserWindow, MenuItemConstructorOptions, nativeTheme, shell, nativeImage } from 'electron'
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

function createMenu() {
  const isMac = process.platform === 'darwin'
  
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            {
              label: 'Check for Updates',
              click: () => checkUpdate()
            },
            { type: 'separator' as const },
            { role: 'services' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { role: 'unhide' as const },
            { type: 'separator' as const },
            { role: 'quit' as const }
          ]
        }]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const },
              { type: 'separator' as const },
              {
                label: 'Speech',
                submenu: [
                  { role: 'startSpeaking' as const },
                  { role: 'stopSpeaking' as const }
                ]
              }
            ]
          : [
              { role: 'delete' as const },
              { type: 'separator' as const },
              { role: 'selectAll' as const }
            ])
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const }
            ]
          : [
              { role: 'close' as const }
            ])
      ]
    }
  ]

  logger.info('Creating application menu with template:', JSON.stringify(template, null, 2))
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  logger.info('Application menu created and set')
}

const updateURL = 'https://ollama.ai/download/app'

app.setName('Ollama')

// Disable hardware acceleration
app.disableHardwareAcceleration()

// Handle the 'will-finish-launching' event
app.on('will-finish-launching', () => {
  logger.info('App will finish launching')
})

let isQuitting = false

app.whenReady().then(async () => {
  logger.info('App is ready')
  
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    logger.info('Another instance is running, exiting')
    app.exit(0)
    return
  }

  app.on('second-instance', () => {
    if (proc) {
      proc.off('exit', restart)
      proc.kill()
    }
    app.exit(0)
  })

  // Show dock icon
  if (process.platform === 'darwin') {
    logger.info('Showing dock icon')
    app.dock.show()
  }

  // Create application menu
  logger.info('Creating application menu')
  createMenu()

  // Initialize tray
  logger.info('Initializing tray')
  createTray()

  // Initialize server
  logger.info('Starting server initialization')
  try {
    await startServer()
    logger.info('Server started successfully')

    // Initialize app only after server is ready
    logger.info('Initializing app')
    init()
  } catch (error) {
    logger.error(`Failed to start server during initialization: ${error.message}`)
    dialog.showErrorBox('Server Error', `Failed to start Ollama server: ${error.message}`)
    isQuitting = true
    app.quit()
    return
  }
})

// Handle activation
app.on('activate', () => {
  logger.info('App activated')
  if (process.platform === 'darwin') {
    app.dock.show()
  }
})

// Handle window-all-closed
app.on('window-all-closed', () => {
  logger.info('All windows closed')
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit()
  }
})

// Handle before-quit
app.on('before-quit', () => {
  logger.info('App is quitting')
  isQuitting = true
  if (proc) {
    proc.off('exit', restart)
    proc.kill('SIGINT')
  }
})

let tray: Tray | null = null
let updateAvailable = false
const assetPath = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'assets')

function createTray() {
  logger.info('Initializing tray')
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'iconDarkTemplate.png')
    : path.join(__dirname, '../assets/iconDarkTemplate.png')

  logger.info(`Using tray icon: ${iconPath}`)
  
  try {
    if (!fs.existsSync(iconPath)) {
      logger.error(`Tray icon not found at ${iconPath}`)
      const lightIconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'iconTemplate.png')
        : path.join(__dirname, '../assets/iconTemplate.png')
        
      if (fs.existsSync(lightIconPath)) {
        logger.info(`Using light tray icon instead: ${lightIconPath}`)
        tray = new Tray(nativeImage.createFromPath(lightIconPath))
      } else {
        logger.error('No tray icons found')
        throw new Error('No tray icons found')
      }
    } else {
      tray = new Tray(nativeImage.createFromPath(iconPath))
    }

    tray.setToolTip('Ollama')
    updateTrayMenu()
  } catch (error) {
    logger.error('Failed to create tray:', error)
    app.dock.show()
  }
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Ollama',
      enabled: false,
    },
    { type: 'separator' as const },
    {
      label: updateAvailable ? 'Update Available' : 'Check for Updates',
      click: () => {
        if (updateAvailable) {
          shell.openExternal(updateURL)
        } else {
          checkUpdate()
        }
      },
    },
    { type: 'separator' as const },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
}

let proc: ChildProcess = null

async function startServer(): Promise<ChildProcess> {
  logger.info('Starting server initialization')
  
  // Ensure ollama directories exist
  const ollamaDir = path.join(app.getPath('home'), '.ollama')
  const modelsDir = path.join(ollamaDir, 'models')
  
  try {
    if (!fs.existsSync(ollamaDir)) {
      fs.mkdirSync(ollamaDir, { recursive: true, mode: 0o755 })
    }
    if (!fs.existsSync(modelsDir)) {
      fs.mkdirSync(modelsDir, { recursive: true, mode: 0o755 })
    }
  } catch (error) {
    logger.error('Failed to create ollama directories:', error)
    throw error
  }

  const env = { ...process.env }
  env.OLLAMA_MODELS = modelsDir
  env.OLLAMA_ORIGINS = '*'
  env.OLLAMA_HOST = 'http://127.0.0.1:11434'
  env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  env.HOME = app.getPath('home')

  const binary = app.isPackaged
    ? path.join(process.resourcesPath, 'ollama')
    : path.resolve(process.cwd(), '..', 'ollama')

  logger.info(`Starting ollama server with binary: ${binary}`)
  logger.info(`Current working directory: ${process.cwd()}`)
  logger.info('Starting server with environment:', JSON.stringify(env, null, 2))

  // Ensure binary exists
  if (!fs.existsSync(binary)) {
    const error = new Error(`Ollama binary not found at ${binary}`)
    logger.error(error)
    throw error
  }

  // Ensure binary is executable
  try {
    fs.chmodSync(binary, 0o755)
  } catch (error) {
    logger.error('Failed to set binary permissions:', error)
    throw error
  }

  // Log binary info
  try {
    const stats = fs.statSync(binary)
    logger.info('Binary stats:', {
      size: stats.size,
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid
    })
  } catch (error) {
    logger.error('Failed to get binary stats:', error)
  }

  const proc = spawn(binary, ['serve'], { 
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  if (!proc.pid) {
    const error = new Error('Failed to start server process')
    logger.error(error)
    throw error
  }

  logger.info(`Server process started with PID: ${proc.pid}`)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timed out after 60 seconds'))
    }, 60000)

    let serverOutput = ''
    let errorOutput = ''

    proc.stdout.on('data', (data) => {
      const output = data.toString()
      serverOutput += output
      logger.info('[Server]', output)
      if (output.includes('Listening on')) {
        clearTimeout(timeout)
        resolve(proc)
      }
    })

    proc.stderr.on('data', (data) => {
      const output = data.toString()
      errorOutput += output
      // Some server messages come through stderr but aren't errors
      if (output.includes('level=INFO') || output.includes('[GIN-debug]')) {
        logger.info('[Server]', output)
      } else {
        logger.error('[Server Error]', output)
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      logger.error('Server process error:', err)
      logger.error('Server output:', serverOutput)
      logger.error('Error output:', errorOutput)
      reject(err)
    })

    proc.on('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code !== 0) {
        const error = new Error(`Server process exited with code ${code} and signal ${signal}`)
        logger.error('Server process exit:', error)
        logger.error('Server output:', serverOutput)
        logger.error('Error output:', errorOutput)
        reject(error)
      }
    })
  })
}

function restart() {
  setTimeout(startServer, 1000)
}

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

let latest = ''
autoUpdater.setFeedURL({ url: updateURL })

autoUpdater.on('error', e => {
  logger.error(`update check failed - ${e.message}`)
  console.error(`update check failed - ${e.message}`)
})

autoUpdater.on('update-downloaded', () => {
  updateAvailable = true
  updateTrayMenu()
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
