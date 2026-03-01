(function bootstrapYouTubeInjectorPreload() {
  if (typeof window === "undefined" || window !== window.top) {
    return;
  }

  const TRACE_ENABLED =
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    process.env.ADBLOCK_TRACE === "1";

  const trace = (...args) => {
    if (TRACE_ENABLED) {
      console.info("[AdblockTrace][yt-injector][isolated]", ...args);
    }
  };

  const PAGE_WORLD_BOOTSTRAP = `(function pageWorldYouTubeGuard() {
    if (typeof window === "undefined" || window !== window.top) return;
    var TRACE_ENABLED = ${TRACE_ENABLED ? "true" : "false"};
    var trace = function () {
      if (!TRACE_ENABLED) return;
      var args = Array.prototype.slice.call(arguments);
      args.unshift("[AdblockTrace][yt-injector][page]");
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

  let trustedScriptPolicy;
  const createTrustedScript = (scriptSource) => {
    const tt = window.trustedTypes;
    if (!tt || typeof tt.createPolicy !== "function") {
      return scriptSource;
    }

    try {
      if (!trustedScriptPolicy) {
        trustedScriptPolicy = tt.createPolicy("kenku-yt-injector", {
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
  };

  const injectPageWorldBootstrap = () => {
    const root = document.documentElement || document.head;
    if (!root) {
      return false;
    }

    if (document.getElementById("kenku-yt-injector-bootstrap")) {
      return true;
    }

    const scriptPayload = createTrustedScript(PAGE_WORLD_BOOTSTRAP);
    if (scriptPayload === null) {
      return false;
    }

    try {
      const script = document.createElement("script");
      script.id = "kenku-yt-injector-bootstrap";
      script.type = "text/javascript";
      script.textContent = scriptPayload;
      root.prepend(script);
      script.remove();
      return true;
    } catch (err) {
      trace("page-world injection failed", err);
      return false;
    }
  };

  trace("preload bootstrap", window.location.href);

  if (injectPageWorldBootstrap()) {
    trace("page-world bootstrap injected");
    return;
  }

  trace("document root unavailable; waiting to inject");
  const observer = new MutationObserver(() => {
    if (!injectPageWorldBootstrap()) {
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
})();
