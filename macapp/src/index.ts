import { spawn, ChildProcess, spawnSync } from 'child_process'
import { app, autoUpdater, dialog, Tray, Menu, BrowserWindow, MenuItemConstructorOptions, MenuItem, nativeTheme, shell, nativeImage } from 'electron'
import Store from 'electron-store'
import winston from 'winston'
import 'winston-daily-rotate-file'
import * as path from 'path'
import * as fs from 'fs'
import * as net from 'net'

import { v4 as uuidv4 } from 'uuid'
import { installed } from './install'

require('@electron/remote/main').initialize()

if (require('electron-squirrel-startup')) {
  app.quit()
}

const store = new Store({
  defaults: {
    listenAllInterfaces: false, // Default to localhost only for security
  }
})

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
            {
              label: 'Listen on All Interfaces',
              type: 'checkbox' as const,
              checked: store.get('listenAllInterfaces') as boolean,
              click: async (menuItem: MenuItem) => {
                store.set('listenAllInterfaces', menuItem.checked)
                await restart()
              }
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

async function killExistingProcesses(): Promise<void> {
  // Try normal kill first
  try {
    const portCheck = spawnSync('lsof', ['-i', ':11434'], { encoding: 'utf8' })
    if (portCheck.status === 0 && portCheck.stdout) {
      const pids = portCheck.stdout
        .split('\n')
        .slice(1)
        .filter(line => line.trim())
        .map(line => line.trim().split(/\s+/)[1])
        .filter(Boolean)

      if (pids.length > 0) {
        logger.info('Found existing Ollama processes:', pids)
        
        // Try normal kill first
        const killResult = spawnSync('kill', pids, { encoding: 'utf8' })
        if (killResult.status !== 0) {
          // If normal kill fails, try force kill with sudo
          logger.info('Normal kill failed, trying sudo force kill')
          const sudoKill = spawnSync('sudo', ['kill', '-9', ...pids], { encoding: 'utf8' })
          if (sudoKill.status === 0) {
            logger.info('Successfully force killed processes')
          } else {
            logger.error('Failed to kill processes:', sudoKill.stderr)
            throw new Error('Failed to kill existing processes')
          }
        }
        
        // Wait for processes to clean up
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  } catch (error) {
    logger.error('Error killing existing processes:', error)
    throw error
  }
}

async function waitForPort(port: number, host: string = '0.0.0.0', timeout: number = 15000): Promise<boolean> {
  const start = Date.now()
  
  while (Date.now() - start < timeout) {
    try {
      const socket = new net.Socket()
      
      const connected = await new Promise<boolean>((resolve) => {
        socket.once('connect', () => {
          socket.end()
          resolve(true)
        })
        
        socket.once('error', () => {
          socket.destroy()
          resolve(false)
        })
        
        socket.connect(port, host)
      })
      
      if (connected) {
        return true
      }
    } catch (error) {
      // Ignore errors and keep trying
    }
    
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  
  return false
}

async function setupModelDirectory(): Promise<string> {
  const ollamaDir = path.join(app.getPath('home'), '.ollama')
  const modelsDir = path.join(ollamaDir, 'models')
  const externalModelsDir = '/Volumes/ai/ollama/.ollama/models'

  try {
    // Create .ollama directory if it doesn't exist
    if (!fs.existsSync(ollamaDir)) {
      fs.mkdirSync(ollamaDir, { recursive: true })
      logger.info('Created .ollama directory')
    }

    // Check if external models directory exists and is accessible
    if (fs.existsSync(externalModelsDir)) {
      logger.info('Found external models directory')
      
      // If models directory exists, check if it's already the correct symlink
      if (fs.existsSync(modelsDir)) {
        const stats = fs.lstatSync(modelsDir)
        if (stats.isSymbolicLink()) {
          const target = fs.readlinkSync(modelsDir)
          if (target === externalModelsDir) {
            logger.info('Models directory already correctly symlinked')
            return externalModelsDir
          }
          // Wrong symlink, remove it
          fs.unlinkSync(modelsDir)
          logger.info('Removed incorrect models symlink')
        } else {
          // Regular directory, move it as backup
          const backupDir = `${modelsDir}.bak.${Date.now()}`
          fs.renameSync(modelsDir, backupDir)
          logger.info(`Backed up existing models directory to ${backupDir}`)
        }
      }
      
      // Create symlink to external models
      fs.symlinkSync(externalModelsDir, modelsDir)
      logger.info('Created symlink to external models directory')
      return externalModelsDir
    } else {
      logger.info('External models directory not found, using local directory')
      
      // Use local models directory
      if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true })
        fs.mkdirSync(path.join(modelsDir, 'blobs'), { recursive: true })
        fs.mkdirSync(path.join(modelsDir, 'manifests'), { recursive: true })
        logger.info('Created local models directory structure')
      }
      return modelsDir
    }
  } catch (error) {
    logger.error('Error setting up models directory:', error)
    throw error
  }
}

async function startServer(): Promise<ChildProcess> {
  logger.info('Starting server initialization')
  
  // Set up models directory
  const modelsPath = await setupModelDirectory()
  logger.info(`Using models directory: ${modelsPath}`)
  
  // Kill any existing processes
  try {
    const portCheck = spawnSync('lsof', ['-i', ':11434'], { encoding: 'utf8' })
    if (portCheck.status === 0 && portCheck.stdout) {
      const pids = portCheck.stdout
        .split('\n')
        .slice(1)
        .filter(line => line.trim())
        .map(line => line.trim().split(/\s+/)[1])
        .filter(Boolean)

      if (pids.length > 0) {
        logger.info('Found existing Ollama processes:', pids)
        spawnSync('sudo', ['kill', '-9', ...pids], { encoding: 'utf8' })
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  } catch (error) {
    logger.error('Error killing existing processes:', error)
  }
  
  const env = { ...process.env }
  env.OLLAMA_MODELS = modelsPath
  env.OLLAMA_ORIGINS = '*'
  env.OLLAMA_HOST = 'http://0.0.0.0:11434'
  env.PATH = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  env.HOME = app.getPath('home')
  env.OLLAMA_DEBUG = 'true'
  env.RUST_LOG = 'debug'
  env.RUST_BACKTRACE = '1'

  const binary = app.isPackaged
    ? path.join(process.resourcesPath, 'ollama')
    : path.resolve(process.cwd(), '..', 'ollama')

  logger.info(`Starting ollama server with binary: ${binary}`)
  logger.info('Starting server with environment:', JSON.stringify(env, null, 2))

  // Ensure binary exists and is executable
  if (!fs.existsSync(binary)) {
    throw new Error(`Ollama binary not found at ${binary}`)
  }
  
  try {
    fs.chmodSync(binary, 0o755)
  } catch (error) {
    logger.error('Failed to set binary permissions:', error)
    throw error
  }

  // Start the server process
  proc = spawn(binary, ['serve'], { 
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  if (!proc.pid) {
    throw new Error('Failed to start server process')
  }

  logger.info(`Server process started with PID: ${proc.pid}`)

  let serverOutput = ''
  let errorOutput = ''

  proc.stdout.on('data', (data) => {
    const output = data.toString()
    serverOutput += output
    logger.info('[Server Output]:', output)
  })

  proc.stderr.on('data', (data) => {
    const output = data.toString()
    errorOutput += output
    logger.error('[Server Error]:', output)
  })

  proc.on('error', (err) => {
    logger.error('Server process error:', {
      error: err,
      stdout: serverOutput,
      stderr: errorOutput
    })
    throw err
  })

  proc.on('exit', (code, signal) => {
    if (code !== 0) {
      const error = new Error(`Server process exited with code ${code} and signal ${signal}`)
      logger.error('Server process exit:', {
        error: error.message,
        stdout: serverOutput,
        stderr: errorOutput
      })
      throw error
    }
  })

  // Wait for server port to be open
  const isListening = await waitForPort(11434)
  if (!isListening) {
    proc.kill()
    throw new Error('Server failed to start listening after 15 seconds')
  }

  return proc
}

async function restart() {
  if (proc) {
    logger.info('Stopping server for restart')
    proc.kill()
    await new Promise<void>((resolve) => {
      proc.on('exit', () => {
        proc = null
        resolve()
      })
    })
  }
  
  logger.info('Starting server after restart')
  proc = await startServer()
  updateTrayMenu()
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
