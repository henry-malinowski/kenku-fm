import { BrowserWindow, ipcMain, shell, WebContentsView, WebFrameMain } from "electron";
import { getUserAgent } from "../userAgent";
import { getGoodtubeCode } from "../goodtubeCache";

/**
 * Manager to help create and manager browser views
 * This class is to be run on the main thread
 * For the render thread counterpart see `BrowserViewManagerPreload.ts`
 */
export class BrowserViewManagerMain {
  window: BrowserWindow;
  views: Record<number, WebContentsView>;
  topView: WebContentsView;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.views = {};

    ipcMain.on(
      "BROWSER_VIEW_CREATE_BROWSER_VIEW",
      this._handleCreateBrowserView
    );
    ipcMain.on(
      "BROWSER_VIEW_REMOVE_BROWSER_VIEW",
      this._handleRemoveBrowserView
    );
    ipcMain.on(
      "BROWSER_VIEW_REMOVE_ALL_BROWSER_VIEWS",
      this._handleRemoveAllBrowserViews
    );
    ipcMain.on("BROWSER_VIEW_HIDE_BROWSER_VIEW", this._handleHideBrowserView);
    ipcMain.on("BROWSER_VIEW_SHOW_BROWSER_VIEW", this._handleShowBrowserView);
    ipcMain.on(
      "BROWSER_VIEW_SET_BROWSER_VIEW_BOUNDS",
      this._handleSetBrowserViewBounds
    );
    ipcMain.on("BROWSER_VIEW_LOAD_URL", this._handleLoadURL);
    ipcMain.on("BROWSER_VIEW_GO_FORWARD", this._handleGoForward);
    ipcMain.on("BROWSER_VIEW_GO_BACK", this._handleGoBack);
    ipcMain.on("BROWSER_VIEW_RELOAD", this._handleReload);

    this.window.on("resize", this._resizeListener);
  }

  destroy() {
    ipcMain.off(
      "BROWSER_VIEW_CREATE_BROWSER_VIEW",
      this._handleCreateBrowserView
    );
    ipcMain.off(
      "BROWSER_VIEW_REMOVE_BROWSER_VIEW",
      this._handleRemoveBrowserView
    );
    ipcMain.off(
      "BROWSER_VIEW_REMOVE_ALL_BROWSER_VIEWS",
      this._handleRemoveAllBrowserViews
    );
    ipcMain.off("BROWSER_VIEW_HIDE_BROWSER_VIEW", this._handleHideBrowserView);
    ipcMain.off("BROWSER_VIEW_SHOW_BROWSER_VIEW", this._handleShowBrowserView);
    ipcMain.off(
      "BROWSER_VIEW_SET_BROWSER_VIEW_BOUNDS",
      this._handleSetBrowserViewBounds
    );
    ipcMain.off("BROWSER_VIEW_LOAD_URL", this._handleLoadURL);
    ipcMain.off("BROWSER_VIEW_GO_FORWARD", this._handleGoForward);
    ipcMain.off("BROWSER_VIEW_GO_BACK", this._handleGoBack);
    ipcMain.off("BROWSER_VIEW_RELOAD", this._handleReload);

    this.window.off("resize", this._resizeListener);
    this.removeAllBrowserViews();
  }

  _resizeListener = () => {
    if (!this.window || !this.topView) {
      return;
    }
    const bounds = this.window.getBounds();
    const viewBounds = this.topView.getBounds();

    this.topView.setBounds({
      x: viewBounds.x,
      y: viewBounds.y,
      width: bounds.width - viewBounds.x,
      height: bounds.height - viewBounds.y,
    });
  };

  _handleCreateBrowserView = (
    event: Electron.IpcMainEvent,
    url: string,
    x: number,
    y: number,
    width: number,
    height: number,
    preload?: string
  ) => {
    const id = this.createBrowserView(url, x, y, width, height, preload);
    this.views[id].webContents.on(
      "did-start-navigation",
      (_, url, __, isMainFrame) => {
        if (isMainFrame) {
          event.reply("BROWSER_VIEW_DID_NAVIGATE", id, url);
          try {
            if (this._shouldInjectURL(url)) {
              try { console.log("[GoodTube][Inject] did-start-navigation main-frame, url:", url); } catch {}
              this._injectGoodTubeIntoMainFrame(this.views[id].webContents);
            }
          } catch {}
        }
      }
    );
    this.views[id].webContents.on("page-title-updated", (_, title) => {
      event.reply("BROWSER_VIEW_TITLE_UPDATED", id, title);
    });
    this.views[id].webContents.on("page-favicon-updated", (_, favicons) => {
      event.reply("BROWSER_VIEW_FAVICON_UPDATED", id, favicons);
    });
    this.views[id].webContents.on("media-started-playing", () => {
      event.reply("BROWSER_VIEW_MEDIA_STARTED_PLAYING", id);
    });
    this.views[id].webContents.on("media-paused", () => {
      event.reply("BROWSER_VIEW_MEDIA_PAUSED", id);
    });
    this.views[id].webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    let loaded = false;
    this.views[id].webContents.on("did-finish-load", () => {
      if (!loaded) {
        event.reply("BROWSER_VIEW_LOADED", id);
        loaded = true;
      }
    });

    // Execute GoodTube in the main frame as early as possible once DOM is ready
    this.views[id].webContents.on("dom-ready", () => {
      try {
        const wc = this.views[id].webContents;
        const url = wc.getURL();
        if (this._shouldInjectURL(url)) {
          try { console.log("[GoodTube][Inject] dom-ready main-frame, url:", url); } catch {}
          this._injectGoodTubeIntoMainFrame(wc);
        }
      } catch (e) {
        try { console.warn("[GoodTube] Main-frame dom-ready injection failed:", e); } catch {}
      }
    });

    // Inject GoodTube into iframes after they finish loading.
    // The session-wide preload injects into the main frame at document-start.
    const tryInjectAllFrames = () => {
      try {
        const mainFrame = this.views[id].webContents.mainFrame;
        if (!mainFrame) return;
        const stack: WebFrameMain[] = [mainFrame];
        let traversed = 0;
        let injectedCount = 0;
        for (let i = 0; i < stack.length; i++) {
          const frame = stack[i];
          traversed++;
          // Queue children
          try {
            for (const child of frame.frames) stack.push(child);
          } catch {}
          // Inject only on target hosts
          const frameUrl = String((frame as any).url || "");
          // Skip main frame to avoid duplicate with preload injection
          const isMain = frame === mainFrame;

          if (!isMain && this._shouldInjectURL(frameUrl)) {
            try { console.log("[GoodTube][Inject] iframe candidate:", frameUrl); } catch {}
            this._injectGoodTubeIntoFrame(frame);
            injectedCount++;
          }
        }
        try { console.log("[GoodTube][Main] Frame traversal complete. traversed=", traversed, "injected=", injectedCount); } catch {}
      } catch (e) {
        try { console.warn("[GoodTube] Frame injection traversal failed:", e); } catch {}
      }
    };

    this.views[id].webContents.on("did-frame-finish-load", tryInjectAllFrames);
    this.views[id].webContents.on("did-navigate-in-page", () => {
      try {
        const wc = this.views[id].webContents;
        const url = wc.getURL();
        if (this._shouldInjectURL(url)) {
          try { console.log("[GoodTube][Inject] did-navigate-in-page main-frame, url:", url); } catch {}
          this._injectGoodTubeIntoMainFrame(wc);
        }
      } catch {}
    });
    event.returnValue = id;
  };

  _handleRemoveBrowserView = (_: Electron.IpcMainEvent, id: number) =>
    this.removeBrowserView(id);

  _handleRemoveAllBrowserViews = () => this.removeAllBrowserViews();

  _handleHideBrowserView = (_: Electron.IpcMainEvent, id: number) =>
    this.hideBrowserView(id);

  _handleShowBrowserView = (_: Electron.IpcMainEvent, id: number) =>
    this.showBrowserView(id);

  _handleSetBrowserViewBounds = (
    _: Electron.IpcMainEvent,
    id: number,
    x: number,
    y: number,
    width: number,
    height: number
  ) => this.setBrowserViewBounds(id, x, y, width, height);

  _handleLoadURL = (_: Electron.IpcMainEvent, id: number, url: string) =>
    this.loadURL(id, url);

  _handleGoForward = (_: Electron.IpcMainEvent, id: number) =>
    this.goForward(id);

  _handleGoBack = (_: Electron.IpcMainEvent, id: number) => this.goBack(id);

  _handleReload = (_: Electron.IpcMainEvent, id: number) => this.reload(id);

  /**
   * Create a new browser view and attach it to the current window
   * @param url Initial URL
   * @param xOffset Offset from the left side of the screen
   * @returns id of the created window
   */
  createBrowserView(
    url: string,
    x: number,
    y: number,
    width: number,
    height: number,
    preload?: string
  ): number {
    const view = new WebContentsView({
      webPreferences: {
        preload,
      },
    });
    this.window.contentView.addChildView(view);

    view.setBounds({
      x,
      y,
      width,
      height,
    });

    try {
      view.webContents.loadURL(url);
    } catch (err) {
      console.error(err);
    }

    // Ensure browser views have a white background to maintain compatibility with regular browsers
    view.webContents.on("dom-ready", () => {
      view.webContents.insertCSS("html { background-color: #fff; }");
    });

    // Spoof user agent to fix compatibility issues with 3rd party apps
    view.webContents.setUserAgent(getUserAgent());

    // Open DevTools in development to observe preload logs
    if ((process.env.NODE_ENV !== "production") && !process.mas) {
      try {
        if (!view.webContents.isDevToolsOpened()) {
          view.webContents.openDevTools({ mode: "detach" });
        }
      } catch {}
    }

    this.views[view.webContents.id] = view;
    this.topView = view;

    return view.webContents.id;
  }

  /** Returns true if we should inject GoodTube into the given URL */
  private _shouldInjectURL(url: string): boolean {
    try {
      const { hostname, protocol } = new URL(url);
      if (!protocol.startsWith("http")) return false;
      return (
        hostname === "youtube.com" ||
        hostname === "www.youtube.com" ||
        hostname === "m.youtube.com" ||
        hostname.endsWith(".youtube.com") ||
        hostname === "wikipedia.org" ||
        hostname.endsWith(".wikipedia.org")
      );
    } catch {
      return false;
    }
  }

  /** Inject cached GoodTube code into a specific frame context (idempotent). Does not fetch; relies on app-start warm. */
  private async _injectGoodTubeIntoFrame(frame: WebFrameMain) {
    try {
      const code = getGoodtubeCode();
      if (!code) return; // Only use cache warmed at app start
      const b64 = Buffer.from(String(code), 'utf8').toString('base64');
      const payload = `(() => { try { if (window.__GOODTUBE_INJECTED__) return; window.__GOODTUBE_INJECTED__ = true; try { if (window.trustedTypes && window.trustedTypes.createPolicy && !window.trustedTypes.defaultPolicy) { window.trustedTypes.createPolicy('default', { createHTML: s => s, createScriptURL: s => s, createScript: s => s }); } } catch {} const __g_b64__='${b64}'; let __g_code__ = atob(__g_b64__); try { if (window.trustedTypes && window.trustedTypes.defaultPolicy && window.trustedTypes.defaultPolicy.createScript) { __g_code__ = window.trustedTypes.defaultPolicy.createScript(__g_code__); } } catch {} (0, eval)(__g_code__); } catch (e) { try { console.warn('[GoodTube] execute userscript error:', e); } catch {} } })();`;
      await frame.executeJavaScript(payload, true);
    } catch (e) {
      try { console.warn('[GoodTube] executeJavaScript failed for frame:', (frame as any).url, e); } catch {}
    }
  }

  /** Inject GoodTube into the main frame via direct execution (avoids TT DOM sinks) */
  private async _injectGoodTubeIntoMainFrame(wc: Electron.WebContents) {
    try {
      const code = getGoodtubeCode();
      if (!code) return;
      const b64 = Buffer.from(String(code), 'utf8').toString('base64');
      const payload = `(() => { try { if (window.__GOODTUBE_INJECTED__) return; window.__GOODTUBE_INJECTED__ = true; try { if (window.trustedTypes && window.trustedTypes.createPolicy && !window.trustedTypes.defaultPolicy) { window.trustedTypes.createPolicy('default', { createHTML: s => s, createScriptURL: s => s, createScript: s => s }); } } catch {} const __g_b64__='${b64}'; let __g_code__ = atob(__g_b64__); try { if (window.trustedTypes && window.trustedTypes.defaultPolicy && window.trustedTypes.defaultPolicy.createScript) { __g_code__ = window.trustedTypes.defaultPolicy.createScript(__g_code__); } } catch {} (0, eval)(__g_code__); } catch (e) { try { console.warn('[GoodTube] execute userscript error (main):', e); } catch {} } })();`;
      await wc.mainFrame.executeJavaScript(payload, true);
    } catch (e) {
      try { console.warn('[GoodTube] mainFrame.executeJavaScript failed:', e); } catch {}
    }
  }

  removeBrowserView(id: number) {
    if (this.views[id]) {
      if (this.topView === this.views[id]) {
        this.topView = undefined;
      }
      this.views[id].webContents.close({ waitForBeforeUnload: false });
      this.window.contentView.removeChildView(this.views[id]);
      (this.views[id].webContents as any).destroy();
      delete this.views[id];
    }
  }

  removeAllBrowserViews() {
    for (let id in this.views) {
      this.views[id].webContents.close({ waitForBeforeUnload: false });
      this.window.contentView.removeChildView(this.views[id]);
      (this.views[id].webContents as any).destroy();
      this.topView = undefined;
      delete this.views[id];
    }
  }

  hideBrowserView(id: number) {
    if (this.views[id]) {
      if (this.topView === this.views[id]) {
        this.topView = undefined;
      }
      this.window.contentView.removeChildView(this.views[id]);
    }
  }

  showBrowserView(id: number) {
    if (this.views[id]) {
      this.window.contentView.addChildView(this.views[id]);
      this.topView = this.views[id];
    }
  }

  setBrowserViewBounds(
    id: number,
    x: number,
    y: number,
    width: number,
    height: number
  ) {
    try {
      this.views[id].setBounds({ x, y, width, height });
    } catch (err) {
      console.error(err);
    }
  }

  loadURL(id: number, url: string) {
    try {
      this.views[id].webContents.loadURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  goForward(id: number) {
    try {
      this.views[id].webContents.navigationHistory.goForward();
    } catch (err) {
      console.error(err);
    }
  }

  goBack(id: number) {
    try {
      this.views[id].webContents.navigationHistory.goBack();
    } catch (err) {
      console.error(err);
    }
  }

  reload(id: number) {
    try {
      this.views[id].webContents.reload();
    } catch (err) {
      console.error(err);
    }
  }
}
