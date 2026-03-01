# Adblocker Integration — Investigation Notes

## Current state

Ghostery (`@ghostery/adblocker-electron` + `@ghostery/adblocker-electron-preload`) replaces
the old Goodtube injection. Both packages are pinned to `2.14.1` and patched via
`patch-package` (see `patches/`). App-level integration in `src/index.ts` is thin — init,
cache, `enableBlockingInSession`, nothing else.

Two upstream bugs were fixed in the patches:

- **`@ghostery/adblocker-electron`** — scriptlet loop in `onInjectCosmeticFilters` was
  missing `await` (async rejections escaped the `try/catch`) and had no IIFE isolation
  (`let` redeclarations from `json-prune` etc. crashed rules 2–N in the same renderer
  global).
- **`@ghostery/adblocker-electron-preload`** — three `ipcRenderer.invoke()` calls had no
  `.catch()`, causing unhandled rejections on navigation-close races.

### Observable behavior (as of last test run, DevTools closed)

- ✅ Hard anti-adblock wall gone
- ✅ Main process errors gone
- ✅ SPA navigations between videos mostly work
- ⚠️ "Experiencing Interruptions?" soft notification on video load (non-blocking)
- ⚠️ Brief player stall before video plays
- ⚠️ Ads slip through on initial/hard page loads (including reload)
- ❓ Occasional `debugger;` break in renderer when DevTools is open (see below)

---

## Key finding: SPA navigation vs. initial/hard load asymmetry

This is the central diagnostic insight. The two code paths hit different interception
mechanisms:

**SPA navigation (works):**
YouTube fetches `/youtubei/v1/player` as a network request. The adblocker's `webRequest`
hooks in the main process intercept it synchronously before the response reaches JavaScript.
`json-prune` runs at the network layer. Timing is not a problem.

**Initial/hard load (fails):**
`ytInitialPlayerResponse` is embedded directly in the page HTML as an inline `<script>` tag:
```
var ytInitialPlayerResponse = JSON.parse('...')
```
The browser parser executes this synchronously as it processes the document. The ghostery
preload does run at `document_start` (before page JS), but it immediately fires an **async
IPC call** to the main process to fetch applicable scriptlets. The scriptlets arrive in the
renderer after the round-trip — by which time the inline script has already run, the player
has already read `ytInitialPlayerResponse`, and any ad placement is committed.

This explains why SPA navigations mostly work and initial/hard loads (including reload to a
video URL) do not.

---

## The `debugger;` break (DevTools-only, likely correlated)

When DevTools is open, the renderer occasionally pauses unconditionally — no exception, no
user breakpoint. This is a `debugger;` statement somewhere in the executing code. It is not
in ghostery's own library code (confirmed by grep). The most likely source is a scriptlet
being injected by the filter rules.

The break correlates with initial/hard page loads, not SPA navigations. This is consistent
with the IPC timing theory: the `debugger;` path is only exercised when the IPC-based
scriptlet injection path is active. On SPA navigation, the network hook handles things
instead.

The break is a **heisenbug** — `debugger;` is a no-op when DevTools is closed, confirmed by
running the full test sequence without DevTools. Behavior was identical. However, the
correlation between break frequency and observable degradation across earlier integration
iterations suggests it is a symptom of a real bug rather than noise.

Stack trace when it fires:
```
start (VM13:135)           ← DOMMonitor.start(), inside MutationObserver callback
(anonymous) (VM13:253)     ← ipcRenderer.invoke().then() → DOM_MONITOR.start(window)
Promise.then
window.addEventListener.once (VM13:253)   ← DOMContentLoaded handler
```

---

## Theories

### Theory A — IPC timing race (primary)

The async IPC round-trip for scriptlet delivery races against YouTube's synchronous inline
script execution on hard load. Scriptlets lose. `json-prune` is not in place when
`ytInitialPlayerResponse` is parsed, so ad placements are not stripped.

**Implication:** this is a structural limitation of ghostery's design for Electron. The
browser extension equivalent uses synchronous extension APIs; Electron always requires an
async IPC hop.

### Theory B — Ghostery preload / SPA lifecycle gap

Ghostery's preload registers its `DOMContentLoaded` listener once. For YouTube's SPA
navigation, `DOMContentLoaded` does not re-fire — only the MutationObserver path is active
after the initial load. If the MutationObserver path has any impairment (including the
`debugger;` issue), every video navigation after the first is less protected.

This is secondary to Theory A but not mutually exclusive.

---

## Proposed next steps

### 1. Confirm the timing race (Theory A diagnostic)

Add temporary main-process logging around the scriptlet dispatch:
- Timestamp when `injectCosmeticFilters` IPC is received
- Timestamp when scriptlets are sent back to the renderer
- Compare against renderer `DOMContentLoaded` timing

If scripts are dispatched after `DOMContentLoaded`, the race is confirmed.

### 2. Identify the `debugger;` source

With DevTools open when the break fires, the Sources panel should show which VM script
(which injected scriptlet) contains the `debugger;` statement. Identifying the specific
filter rule would confirm whether this is a Kenku code path issue (triggering a scriptlet
that shouldn't apply in this context) or a filter list issue.

### 3. Fix the timing race

Two options, not mutually exclusive:

**Option A — Kenku-owned synchronous preload for YouTube**
Add a preload that runs synchronously at `document_start` and installs a `JSON.parse`
intercept targeting YouTube's ad-related player response properties. This runs before any
IPC round-trip and before any inline script. Narrow and targeted — YouTube-specific — but
solves the race definitively for the initial load case.

**Option B — Explore ghostery pre-delivery**
Investigate whether the main process can pre-compute applicable scriptlets for a URL when
navigation starts (before the renderer is ready) and deliver them to the preload
synchronously on first access, bypassing the round-trip cost. More architectural, less
certain, but the right long-term fix if ghostery's design can support it.

### 4. Re-evaluate `fullLists` restriction

The current config uses `fullLists` only, excluding the live uBO `quick-fixes.txt`. This
exclusion was diagnosed before the IIFE and IPC patches existed, when the scriptlet runner
was broken. With both bugs now fixed, it's worth re-testing with the full list — the
original failure may have been a symptom of the broken execution environment rather than a
bad rule. `quick-fixes.txt` is uBO's rapid-response channel for YouTube changes; excluding
it is a meaningful coverage gap.

### 5. "Experiencing Interruptions?" notification

Separate from the ad slip-through. Likely caused by a filter rule disrupting a request that
YouTube's player depends on for normal buffering/QoS signaling. The network log from the
test run showed several `ERR_UNSAFE_REDIRECT` responses (rather than `ERR_BLOCKED_BY_CLIENT`)
on doubleclick domains — worth investigating whether those are related. Better diagnosed
after the timing race is addressed, since the current broken state makes it hard to isolate.

---

## Filter list reference

```typescript
// src/index.ts
// Ghostery's curated mirror of uBO/EasyList. Using fullLists only — the live
// uBO quick-fixes.txt was found to prevent /youtubei/v1/player from being
// called, likely due to a set-constant scriptlet zeroing out player state.
// NOTE: this exclusion predates the IIFE/IPC patches and should be re-tested.
const FILTER_LISTS = fullLists;
```
