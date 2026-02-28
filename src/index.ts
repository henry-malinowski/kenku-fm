import os from "os";
import {
  app,
  BrowserWindow,
  components,
  session,
  shell,
  ipcMain,
  powerSaveBlocker,
} from "electron";
import "./menu";
import icon from "./assets/icon.png";
import { getMalformedUserAgent, getUserAgent } from "./main/userAgent";
import path from "path";
import fs from "fs";
import { SessionManager } from "./main/managers/SessionManager";
import { runAutoUpdate } from "./autoUpdate";
import { getSavedBounds, saveWindowBounds } from "./bounds";
import { fetchGoodtubeCode, getGoodtubeCode } from "./main/goodtubeCache";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
let window: BrowserWindow | null = null;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  // eslint-disable-line global-require
  app.quit();
}

const createWindow = (): BrowserWindow => {
  const minWidth = 800;
  const minHeight = 600;

  // Create the browser window.
  const { bounds, maximized } = getSavedBounds(minWidth, minHeight);

  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    icon: icon,
    minWidth,
    minHeight,
    ...bounds,
  });

  if (maximized) {
    mainWindow.maximize();
  }

  // and load the index.html of the app.
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  let session = new SessionManager(mainWindow);

  mainWindow.webContents.on("did-start-loading", () => {
    // Restart the session on refresh
    session.destroy();
    session = new SessionManager(mainWindow);
  });

  // Spoof user agent for window.navigator
  mainWindow.webContents.setUserAgent(getUserAgent());

  // Prevent app suspension for Kenku FM to avoid playback issues
  const powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");

  mainWindow.on("close", () => {
    session.destroy();
    window = null;
    powerSaveBlocker.stop(powerSaveBlockerId);
  });

  saveWindowBounds(mainWindow);

  if (app.isPackaged) {
    runAutoUpdate(mainWindow);
  }

  return mainWindow;
};

const spoofUserAgent = () => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Google blocks sign in on CEF so spoof user agent for network requests
    details.requestHeaders["User-Agent"] = details.url.includes("google.com")
      ? getMalformedUserAgent()
      : getUserAgent();
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });
};

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  // Workaround to allow for webpack support with widevine
  // https://github.com/castlabs/electron-releases/issues/116
  const widevine = components;

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(async () => {
    let hasWidevineError = false;

    try {
      // Wait for widevine to load
      await widevine.whenReady();
      console.log("components ready:", components.status());
    } catch (e) {
      hasWidevineError = true;
      console.error("components failed to load:", JSON.stringify(e, null, 2));
    }

    // Ensure our browsing injector preload is registered BEFORE any windows/views are created
    const resolveInjectorPreloadPath = (): string | null => {
      const candidates = [
        // Dev / unpacked
        path.join(app.getAppPath(), "src", "preload", "managers", "YouTubeInjectorPreload.js"),
        // Packaged next to compiled files
        path.join(__dirname, "..", "preload", "managers", "YouTubeInjectorPreload.js"),
        // Packaged as extraResource
        path.join(process.resourcesPath || "", "YouTubeInjectorPreload.js"),
        path.join(process.resourcesPath || "", "preload", "managers", "YouTubeInjectorPreload.js"),
      ];
      try { console.log("[GoodTube] Resolving injector preload from candidates:", candidates); } catch {}
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate)) {
            try { console.log("[GoodTube] Using injector preload:", candidate); } catch {}
            return candidate;
          }
        } catch (e) {
          try { console.warn("[GoodTube] fs.existsSync error for", candidate, e); } catch {}
        }
      }
      return null;
    };

    const injector = resolveInjectorPreloadPath();
    if (injector) {
      try {
        // Electron 37 (castLabs): use registerPreloadScript/getPreloadScripts
        session.defaultSession.registerPreloadScript({
          id: "goodtube-injector",
          type: "frame",
          filePath: injector,
        });
        const scripts = session.defaultSession.getPreloadScripts();
        try { console.log("[GoodTube] Registered preload scripts:", scripts); } catch {}
      } catch (e) {
        console.warn("[GoodTube] Failed to register preload script:", e);
      }
    } else {
      console.warn("[GoodTube] Could not resolve injector preload path");
    }

    // Warm the GoodTube cache on startup; non-fatal if it fails
    try { await fetchGoodtubeCode(); } catch {}

    window = createWindow();

    spoofUserAgent();

    if (hasWidevineError) {
      window.once("ready-to-show", () => {
        window.webContents.send(
          "ERROR",
          "Widevine DRM Error: Licensed music playback is disabled",
        );
      });
    }
  });

  app.on("second-instance", () => {
    // Someone tried to run a second instance, we should focus our window.
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      window = createWindow();
    }
  });

  ipcMain.on("GET_VERSION", (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.on("GET_PLATFORM", (event) => {
    event.returnValue = os.platform();
  });

  ipcMain.handle("CLEAR_CACHE", async () => {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ["cookies", "shadercache", "cachestorage"],
    });
  });

  // Diagnostics from GoodTube preload
  ipcMain.on("GOODTUBE_PRELOAD_BOOTSTRAP", (_e, info) => {
    try { console.log("[GoodTube][Preload->Main] Bootstrap:", info); } catch {}
  });
  ipcMain.on("GOODTUBE_PRELOAD_CODE_LEN", (_e, len) => {
    try { console.log("[GoodTube][Preload->Main] Code length seen by preload:", len); } catch {}
  });
  ipcMain.on("GOODTUBE_PRELOAD_APPEND", (_e, ok) => {
    try { console.log("[GoodTube][Preload->Main] Append result:", ok); } catch {}
  });

  // Provide GoodTube code to preload synchronously if available
  ipcMain.on("GOODTUBE_GET_CODE", (event) => {
    try {
      const code = getGoodtubeCode() || "";
      if (!code) {
        try { console.warn("[GoodTube] Cache empty when requested by preload"); } catch {}
      } else {
        try { console.log("[GoodTube] Supplying cached code to preload (chars):", code.length); } catch {}
      }
      event.returnValue = code;
    } catch (e) {
      try { console.warn("[GoodTube] Failed to supply cached code:", e); } catch {}
      event.returnValue = "";
    }
  });
}
