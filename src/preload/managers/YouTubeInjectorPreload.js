(function bootstrapInjectorPreload() {
  if (typeof window === "undefined" || window !== window.top) {
    return;
  }

  const TRACE_ENABLED =
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    process.env.ADBLOCK_TRACE === "1";

  const trace = (...args) => {
    if (TRACE_ENABLED) {
      console.info("[AdblockTrace][injector][isolated]", ...args);
    }
  };

  // Global runtime: common page-world injection mechanics and TT handling.
  let trustedScriptPolicy;
  const runtime = {
    bootstrapScriptId: "kenku-injector-bootstrap",
    createTrustedScript(scriptSource) {
      const tt = window.trustedTypes;
      if (!tt || typeof tt.createPolicy !== "function") {
        return scriptSource;
      }

      try {
        if (!trustedScriptPolicy) {
          trustedScriptPolicy = tt.createPolicy("kenku-injector", {
            createScript(value) {
              return value;
            },
          });
        }
        return trustedScriptPolicy.createScript(scriptSource);
      } catch (err) {
        trace("trusted types policy creation failed", err);
        return null;
      }
    },
    injectPageWorldBootstrap(scriptSource) {
      const root = document.documentElement || document.head;
      if (!root) {
        return false;
      }

      if (document.getElementById(this.bootstrapScriptId)) {
        return true;
      }

      const scriptPayload = this.createTrustedScript(scriptSource);
      if (scriptPayload === null) {
        return false;
      }

      try {
        const script = document.createElement("script");
        script.id = this.bootstrapScriptId;
        script.type = "text/javascript";
        script.textContent = scriptPayload;
        root.prepend(script);
        script.remove();
        return true;
      } catch (err) {
        trace("page-world injection failed", err);
        return false;
      }
    },
    injectWithDeferredObserver(scriptSource) {
      if (this.injectPageWorldBootstrap(scriptSource)) {
        trace("page-world bootstrap injected");
        return;
      }

      trace("document root unavailable; waiting to inject");
      const observer = new MutationObserver(() => {
        if (!this.injectPageWorldBootstrap(scriptSource)) {
          return;
        }
        trace("page-world bootstrap injected (deferred)");
        observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });

      // Stop retrying forever if we cannot inject after a short window.
      setTimeout(() => {
        observer.disconnect();
        trace("stopped deferred injection observer");
      }, 5000);
    },
  };

  // Site adapter: YouTube watch policy only.
  const youtubeAdapter = {
    id: "youtube-watch",
    matches(location) {
      if (!location || typeof location.hostname !== "string") {
        return false;
      }
      return location.hostname.endsWith("youtube.com") && location.pathname === "/watch";
    },
    buildPageWorldBootstrap(traceEnabled) {
      return `(function pageWorldYoutubeWatchAdapter() {
        if (typeof window === "undefined" || window !== window.top) return;
        var TRACE_ENABLED = ${traceEnabled ? "true" : "false"};
        var trace = function () {
          if (!TRACE_ENABLED) return;
          var args = Array.prototype.slice.call(arguments);
          args.unshift("[AdblockTrace][yt-adapter][page]");
          console.info.apply(console, args);
        };
        var looksLikeYoutubeWatchPath = function (location) {
          if (!location || typeof location.hostname !== "string") return false;
          return location.hostname.endsWith("youtube.com") && location.pathname === "/watch";
        };
        if (!looksLikeYoutubeWatchPath(window.location)) return;
        var YT_AD_KEYS = new Set(["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"]);
        var sanitizePlayerResponse = function (value, seen) {
          if (seen === void 0) seen = new WeakSet();
          if (value === null || typeof value !== "object") return 0;
          if (seen.has(value)) return 0;
          seen.add(value);
          var removed = 0;
          var keys = Object.keys(value);
          for (var i = 0; i < keys.length; i += 1) {
            var key = keys[i];
            if (YT_AD_KEYS.has(key)) {
              delete value[key];
              removed += 1;
              continue;
            }
            removed += sanitizePlayerResponse(value[key], seen);
          }
          return removed;
        };
        var looksLikeYoutubePlayerResponse = function (value) {
          if (value === null || typeof value !== "object") return false;
          return ("videoDetails" in value ||
            "playabilityStatus" in value ||
            "streamingData" in value ||
            "responseContext" in value ||
            "adPlacements" in value ||
            "playerAds" in value);
        };
        trace("installing watch guard", window.location.href);
        var initialPlayerResponse;
        try {
          Object.defineProperty(window, "ytInitialPlayerResponse", {
            configurable: true,
            enumerable: true,
            get: function () { return initialPlayerResponse; },
            set: function (value) {
              var removed = sanitizePlayerResponse(value);
              if (removed > 0) trace("sanitized ytInitialPlayerResponse keys", removed);
              initialPlayerResponse = value;
            },
          });
        } catch (err) {
          trace("failed to define ytInitialPlayerResponse", err);
        }
        var originalParse = JSON.parse.bind(JSON);
        JSON.parse = function patchedParse(text, reviver) {
          var parsed = originalParse(text, reviver);
          if (!looksLikeYoutubePlayerResponse(parsed)) return parsed;
          var removed = sanitizePlayerResponse(parsed);
          if (removed > 0) trace("sanitized JSON.parse payload keys", removed);
          return parsed;
        };
        trace("watch guard installed");
      })();`;
    },
  };

  // Adapter registry: only runtime uses this list to compose payload.
  // We still match at preload runtime (instead of only in main) because the same
  // BrowserView can navigate across many URLs after creation.
  const adapters = [youtubeAdapter];
  const activeAdapters = adapters.filter((adapter) => adapter.matches(window.location));

  trace("preload bootstrap", window.location.href);
  if (activeAdapters.length === 0) {
    trace("no matching adapters for location");
    return;
  }

  trace(
    "active adapters",
    activeAdapters.map((adapter) => adapter.id).join(", ")
  );

  const pageWorldBootstrap = activeAdapters
    .map((adapter) => adapter.buildPageWorldBootstrap(TRACE_ENABLED))
    .join("\n");

  runtime.injectWithDeferredObserver(pageWorldBootstrap);
})();
