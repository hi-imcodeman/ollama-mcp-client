/**
 * Dev builds launch node_modules/electron/dist/Electron.app, so the Dock
 * shows "Electron". Rename the .app, rewrite Info.plist + path.txt, and
 * refresh Launch Services so the tooltip reads "Ollama MCP".
 */
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const APP_NAME = 'Ollama MCP'
const BUNDLE_NAME = 'Ollama MCP.app'
const BUNDLE_ID = 'com.ollamamcp.app'

if (process.platform !== 'darwin') {
  process.exit(0)
}

const require = createRequire(import.meta.url)
let electronRoot
try {
  electronRoot = dirname(require.resolve('electron/package.json'))
} catch {
  console.warn('[patch-electron-app] electron not installed; skip')
  process.exit(0)
}

const dist = join(electronRoot, 'dist')
const electronApp = join(dist, 'Electron.app')
const namedApp = join(dist, BUNDLE_NAME)

if (existsSync(electronApp) && !existsSync(namedApp)) {
  renameSync(electronApp, namedApp)
} else if (!existsSync(namedApp) && !existsSync(electronApp)) {
  console.warn('[patch-electron-app] Electron.app missing; skip')
  process.exit(0)
}

// Prefer the renamed bundle; fall back if rename was blocked.
const appRoot = existsSync(namedApp) ? namedApp : electronApp
const plist = join(appRoot, 'Contents', 'Info.plist')
if (!existsSync(plist)) {
  console.warn('[patch-electron-app] Info.plist missing; skip')
  process.exit(0)
}

function setPlist(key, value) {
  execFileSync('plutil', ['-replace', key, '-string', value, plist])
}

setPlist('CFBundleName', APP_NAME)
setPlist('CFBundleDisplayName', APP_NAME)
setPlist('CFBundleIdentifier', BUNDLE_ID)

const icnsSrc = join(root, 'resources', 'icon.icns')
const icnsDst = join(appRoot, 'Contents', 'Resources', 'electron.icns')
if (existsSync(icnsSrc) && existsSync(dirname(icnsDst))) {
  copyFileSync(icnsSrc, icnsDst)
}

const relativeExe = `${BUNDLE_NAME}/Contents/MacOS/Electron`
if (existsSync(join(dist, relativeExe))) {
  writeFileSync(join(electronRoot, 'path.txt'), relativeExe)
} else {
  writeFileSync(
    join(electronRoot, 'path.txt'),
    'Electron.app/Contents/MacOS/Electron'
  )
}

// Force Launch Services to re-read the bundle identity.
try {
  const lsregister = join(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  )
  if (existsSync(lsregister)) {
    execFileSync(lsregister, ['-f', '-R', '-trusted', appRoot], {
      stdio: 'ignore'
    })
  }
} catch {
  // Non-fatal; Dock may still need a relaunch.
}

console.log(
  `[patch-electron-app] Dock bundle → "${BUNDLE_NAME}" (${BUNDLE_ID})`
)
console.log(
  '[patch-electron-app] Quit the app, then run: killall Dock  (optional if tooltip is stale)'
)
