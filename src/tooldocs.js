// Long-form documentation of every tool, served as MCP resources (`tv-debug://docs/<tool>`).
//
// The tool list itself is sent to the model on every turn by some clients (Codex, OpenCode),
// so its descriptions are one or two sentences. What used to live there — the action tables of
// tv_network and tv_record, the step shapes of tv_sequence, the answer shapes — is here, and an
// agent reads it once, when it needs it, through resources/read.

const COMMON = `
## Answer shapes

Every answer is compact JSON (no indentation). Navigation tools report their cost: \`ms\` (wall
time) and \`evals\` (CDP calls made). Use them to tell a slow step from a slow TV.

## Devices

\`device\` on every tool is an id from devices.json; omit it for the default device. \`tv_devices\`
lists the park with reachability and the operations each device really supports.
`;

export const TOOL_DOCS = {
	tv_devices: `# tv_devices

List the configured TVs (devices.json / TV_DEBUG_CONFIG), their reachability (sdb / ares / the
inspector port / the dev server) and which operations each supports. Start here to see the park.

Answer: \`{configPath, devices: [{id, platform, name, engine, appId, target, status,
capabilities: {install, uninstall, killApp, relaunch, attach, navigate, screenshot?, inputMode}, default}]}\`.

Reachability is cached for 5 seconds; all Tizen devices share one \`sdb devices\` call.
${COMMON}`,

	tv_install: `# tv_install

Install an app package on a TV: \`.wgt\` for Tizen, \`.ipk\` for webOS. \`path\` must be absolute.
Set \`uninstallFirst:true\` when an app signed with a different certificate is already installed
("Author certificate not match"). Not applicable to \`pc\` and \`vidaa\` devices — the call is refused
with a reason.
${COMMON}`,

	tv_launch: `# tv_launch

Debug-launch the app and attach over CDP. Establishes the session every other tool uses.

Modes:
* default — kill any running instance, then a fresh debug launch (deterministic start);
* \`reload:true\` — reload the page in place (same process, keeps localStorage); only meaningful on
  an already-live connection;
* \`relaunch:true\` — force kill + launch even if already attached;
* \`attach:true\` — reuse the inspector of an app already running in debug, keeping its state;
* \`waitBoot:false\` — do not wait for the profile's \`bootReady\` condition (e.g. to watch the boot).

A fresh launch that does not reach \`bootReady\` is killed and launched once more before the
verdict stands (\`bootRetries: 1\` + a warning naming the first attempt): some sets hang every
other cold start. \`attach\` never retries.

Answer: \`{ok, device, engine, url, title, inputMode, freshLaunch, localPort?, rttMs, legacyEval?,
bootReady?: {ok, elapsedMs, condition}, warning?, reloadSkipped?}\`.
* \`inputMode\` — \`synthetic\` (page-side KeyboardEvent, always on a TV) or \`trusted\` (CDP Input
  domain, a local Chrome by default). It is a property of the device, reported once here.
* \`rttMs\` — one CDP round-trip on this device, measured at connect. ~5-10ms on a local Chrome,
  30-80ms on a TV over sdb/ares.
* \`legacyEval\` — the engine has no \`awaitPromise\` (Chrome 38/47/53, WebKit 538): page promises
  are settled by a host-side poll, so waits cost a few extra round-trips.
* \`bootReady\` — after a fresh launch the tool waits for the app profile's bootReady condition
  and reports whether the app actually came up. A boot that never completes does NOT fail the
  call: the attach worked, and tv_console / tv_network are exactly what you need next.
${COMMON}`,

	tv_press: `# tv_press

Send a remote key and wait for the focus to settle.

Key names: UP DOWN LEFT RIGHT ENTER BACK MENU INFO GUIDE SEARCH TOOLS CAPTION RED GREEN YELLOW
BLUE PLAY PAUSE PLAY_PAUSE STOP REWIND FAST_FORWARD TRACK_NEXT TRACK_PREV RECORD CHANNEL_UP
CHANNEL_DOWN PAGE_UP PAGE_DOWN VOLUME_UP VOLUME_DOWN VOLUME_MUTE EXIT DIGIT_0..9 (case-insensitive),
or a raw numeric keyCode.

* \`durationMs\` — hold the key (long-press): keydown, hold, keyup. The app's long-press timer runs
  between the two.
* \`repeat\` + \`intervalMs\` — a burst (move several tiles). Only the last press settles.
* \`settle:false\` — fire and forget; the answer carries no focus.

On a synthetic-input device the press, the settle and the focus read are ONE page-side call.
"Settled" means the focus signature changed from before the press (or the change window passed)
and then nothing moved for a quiet period — thresholds come from the app profile's \`settle\`
block (\`{quietMs, changeTimeoutMs}\`) or platform defaults.

Answer: \`{key, focus, changed, before?, repeat?, holdMs?, ms, evals}\`.
* \`focus\` — the focus signature after the press: \`path#index/total::text\`;
* \`changed\` — whether it differs from before; \`before\` is included only when it did not;
* \`repeat\` / \`holdMs\` appear only when they were not the defaults.
${COMMON}`,

	tv_screenshot: `# tv_screenshot

Capture the app frame via CDP and save a PNG. Answer: \`{ok, path, bytes}\`.

On Samsung/Tizen the secure video/overlay plane often makes captureScreenshot hang or return
black — for playback verdicts prefer tv_video_state and a human glance at the physical TV. UI
screens (menus, focus, tiles) usually capture fine. On an engine that renders no capturable
frame at all (old Tizen) the first call times out and every later call in the session refuses
instantly instead of hanging again; \`tv_launch relaunch:true\` retries on a fresh connection.
${COMMON}`,

	tv_console: `# tv_console

Console output, uncaught exceptions and failed network requests buffered since launch.

The three lists are deduplicated: an entry that repeated carries \`count\` and \`tLast\`; \`t\` is
seconds since the connection was made; \`at\` is \`file:line\` with the url cut to its basename.
The entries returned are the most recent DISTINCT ones (default 30 per list). \`filter\` is a
case-insensitive substring on the text (and on failed request URLs); \`levels\` picks console
levels.

Answer: \`{errors: [{text, at?, count?, t?, tLast?}], console: [{level, text, at?, …}],
networkFailures: [{url, errorText, blocked?, …}], totals: {console, exceptions, networkFailures,
networkRequests}, droppedFromBuffer}\`. \`totals\` are raw counts before deduplication.
${COMMON}`,

	tv_network: `# tv_network

The full request log since launch — the tool for "the request went out, but not the right one"
(analytics that lost a field, an API call with a parameter dropped, a stat event fired twice).
Reading the log needs no live connection: it survives the app dying.

Actions:
* \`list\` (default) — url, method, status, mime type, size and the POST body of each request,
  newest first. Filters: \`urlPattern\` (substring, or /regex/flags), \`method\`, \`status\` ("failed" |
  a number | {min,max}), \`limit\` (default 25). The answer carries \`matched\`, \`buffered\` and
  \`dropped\` (evicted from the ring buffer — the one way an assertion can be wrong silently).
* \`body\` — read one response body back by \`requestId\`. Bodies live in the ENGINE buffer only
  until the page navigates or the app is relaunched, so this answers "why is the catalog empty"
  right now and cannot re-read history; assert bodies at the moment of the case with a
  tv_sequence \`expectRequest\` step.
* \`curl\` — turn one request into a runnable command (Cookie/Authorization redacted unless
  \`raw:true\`). Real wire headers exist only on Chromium 63+; below that the command warns.
* \`har\` — write a HAR 1.2 file of the filtered log (importable into DevTools → Network → Import,
  Charles, Insomnia). It contains cookies and auth headers as they were — not for a public ticket.
  \`withBodies:false\` skips bodies.
* \`mark\` — move the assertion window used by \`expectRequest\` / \`{request}\` waits to now.

POST bodies carry tokens: the list cuts them to 1000 characters and full bodies never go into reports.
${COMMON}`,

	tv_video_state: `# tv_video_state

Programmatic \`<video>\` snapshot: whether currentTime is advancing (two samples \`sampleGapMs\`
apart, default 600), readyState, size, muted, src and the MediaError code. The reliable way to
confirm playback when a screenshot would be black.

On a page with no \`<video>\` at all it reads the Tizen object player instead (\`webapis.avplay\`) and
answers with the same advancing/paused/currentTime/duration fields plus \`source:"avplay"\`, the
AVPlay state, codec, bitrate and the available bitrate ladder.

Answer: \`{found, paused, ended, currentTime, advancedBy, advancing, duration, readyState,
networkState, videoWidth, videoHeight, muted, volume, playbackRate, src, errorCode}\`;
\`{found: 0}\` when there is no player.
${COMMON}`,

	tv_state: `# tv_state

Structured snapshot of the app right now: url, title, visible scenes, the focused element (text,
class, path, index/total among its siblings), whether the focus is inside the menu, visible popups
and element counts. Read-only — assert a step without pressing anything.

Default answer is text:

    "Title" http://…
    scenes: s-catalog
    focus: "Trailer" demo-list > demo-tile#3/6 testid=tile-3 [in menu]
    counts: tiles 6, menuItems 4, popups 0
    popup: demo-popup "Play Go to creator"

\`format:"json"\` returns the object: \`{url, title, scenes, focus: {text, className, tag, testid,
path, index, total, visible}, focusInMenu, popups: [{className, text}], counts: {tiles, menuItems, popups}}\`.
${COMMON}`,

	tv_snapshot: `# tv_snapshot

One structural read of the screen: the rows around the focus, their items, and where the focus
sits among them — so the next three to five moves are arithmetic instead of press-look-press-look.

Every item carries a ref (e1, e2, …) that \`tv_goto {ref}\` takes directly, and \`neighbours\` names
the nearest ref in each direction. IMPORTANT: neighbours is LAYOUT GEOMETRY (nearest centre among
the collected elements), not the app's navigation graph — it proves a move is one press away, it
does not know what the app does on that press.

Rows come either from the app profile's \`snapshot\` block (tier \`profile\`: named, precise) or,
with no app knowledge, from the focused element's siblings (tier \`generic\`); with neither the
answer has no rows and a warning, never invented structure. Off-screen rows and items are
dropped and counted; text is cut to 32 characters.

* \`detail\` — \`focus\` (cheapest: focus, scenes, popups), \`rows\` (default), \`full\` (no viewport filter).
* \`maxRows\` / \`maxItemsPerRow\` — caps centred on the focus (defaults 6 / 12 or the profile's).
* \`release:true\` — drop the ref store on the page now instead of waiting for the TTL.
* \`format:"json"\` — the object instead of the text rendering.

Refs expire: they are dropped by the next snapshot, by a navigation, and by a 60s TTL — a stale
one is REFUSED by tv_goto, never silently re-resolved.

Default answer is text:

    snapshot #3 http://…
    scenes: s-catalog
    focus: e1 "Trailer" demo-list > demo-tile#0/6
    r0 "Menu": [e7 "Main"] [e8 "Library"] [e9 "Settings"]
    r1*: [e1 "Trailer"]* [e2 "Second"] [e3 "Third"] (+3 off-screen)
    neighbours: RIGHT e2 DOWN e7
    tier: profile

JSON shape: \`{ok, g, url, scenes, popups, focus: {…, ref}, tier, rows: [{i, focused?, label?,
items: [{ref, i, t, focused?}], more?}], moreRows?, neighbours: {LEFT, RIGHT, UP, DOWN}, counts, bytes, warning?}\`.
${COMMON}`,

	tv_record: `# tv_record

Record what a person does with the PHYSICAL remote and compile it into a runnable tv_sequence
plus a checklist of what only a human can confirm.

Actions:
* \`start\` (default) — RELAUNCHES the app (so the recording begins in the state the compiled case
  will replay from; \`relaunch:false\` skips that and warns in the case), installs a page-side
  listener and puts a "● REC" badge on screen (\`overlay:false\` turns it off). Options: \`assert\`
  (\`minimal\` keys only | \`normal\` scene and popup changes | \`rich\` also video-advancing asserts),
  \`longPressMs\` (a hold at least this long becomes a longpress step, default 700), \`collapse\`
  (runs of one direction become goto steps, default true), \`heartbeatMs\` (self-check period between
  presses, default 1000).
* \`status\` — how many keys have reached the page; use it to check the remote reaches the page at all.
* \`stop\` — compile the case and RETURN it: steps inline plus the exact \`markdown\` that would be
  written — WITHOUT touching the disk. Show it to the human and ask: save, edit, or throw away.
* \`write\` — write the file \`stop\` compiled, after a human approved it. \`title\` / \`note\` / \`path\` /
  \`overwrite\` / \`steps\` override the draft — pass \`steps\` to save a corrected version; the checklist
  is kept and marked as belonging to the original recording. A file that already exists is NOT
  overwritten and NOT silently suffixed: you get \`{written:false, conflict}\` and ask the human.

Default path: \`<package>/cases/recorded/<slug>.md\` (gitignored) or \`TV_DEBUG_CASES_DIR\`.

The compiler collapses a run of the same direction into ONE goto (only while the focus actually
moved on every press — an overshoot at the edge of a list is dropped with a warning), turns
physical auto-repeat into \`{press, repeat}\` rather than a long-press, turns observed
scene/popup/video changes into waits and expects, and NEVER emits a sleep step. Network
assertions come only from the app profile's \`record.watch\` whitelist; \`bodyContains\` is never
inferred. The replay is NOT run automatically: on a live TV it starts the player and fires analytics.
${COMMON}`,

	tv_wait_for: `# tv_wait_for

Wait until a condition holds, instead of sleeping. Give exactly one condition:

* \`focusText\` — the focused element's text contains this (case-insensitive);
* \`element\` / \`elementGone\` — a visible element matches / no visible element matches this NAME from
  the app profile's \`elements\` registry (e.g. "player.play"); the answer echoes \`resolvedFrom\`;
* \`sceneName\` — a visible scene matches this NAME from the profile's \`scenes\` registry;
* \`selector\` / \`selectorGone\` — a visible element matches / none matches this CSS selector;
* \`scene\` — a visible scene's class contains this;
* \`text\` — the page's visible text contains this;
* \`expression\` — an ES5 expression that must evaluate truthy (the page-side helpers focusLeaf(),
  focusInfo(), scenes(), visible(el), txt(el) are in scope);
* \`videoAdvancing:true\` — playback position is moving (\`<video>\`, or AVPlay on old Tizen);
* \`request\` — a matching request was sent: \`{"urlPattern":"track","method":"POST",
  "bodyContains":"event_id","statusMax":399}\`. Matches requests received since this call (or since
  the last \`tv_network action:"mark"\`). \`"absent":true\` inverts it — succeeds only if nothing
  matched by the timeout (how a duplicated stat event is caught; it waits out the whole timeout).
  \`"count":{"min":1,"max":1}\` bounds how many matched.

Options: \`timeoutMs\` (default 15000; 8000 for a request condition), \`intervalMs\` (poll, default
250), \`stableMs\` (the condition must keep holding this long — avoids acting on a half-rendered
frame), \`withState:true\` (append a tv_state snapshot to the answer).

Answer: \`{ok, condition, elapsedMs, detail, polls, evals, timedOut?, resolvedFrom?, state?}\`.
An unknown element/scene name fails with the list of known ones.
${COMMON}`,

	tv_goto: `# tv_goto

Press a direction repeatedly until the FOCUSED element matches a target: \`ref\` (from tv_snapshot,
checked by identity — duplicate titles in a catalog are normal), \`element\` (a NAME from the app
profile's registry; an explicit text/selector/testid alongside narrows it), \`text\` (the focused
element's text contains it, case-insensitive), \`selector\`, \`testid\` (data-testid / data-export-id).

Bounded by \`maxSteps\` (default 30), \`deadlineMs\` (default 45000) and two structural stops: focus
that stopped moving (edge of a list) and focus that wrapped around to a position already visited.
Use this instead of guessing "press DOWN 7 times". \`select:true\` presses ENTER once the target has
focus, so arriving and entering is one call — the gap between two calls is where a lazily-loading
list moves the focus out from under you.

Each step is one page-side call (press, settle, match). Answer on success: \`{ok:true, presses,
trail: "DOWN×3", focus: {text, className, tag, testid, path, index, total, visible}, resolvedFrom?,
selected?, state?, ms, evals}\`. On failure: \`{ok:false, reason, presses, steps: [{press, focus,
matched}], focus?, ms, evals}\` — the per-press list is the evidence. A stale ref is refused with a
reason and \`presses: 0\`, never re-resolved.
${COMMON}`,

	tv_menu: `# tv_menu

Move focus into the app's main menu and pick a section by name (case-insensitive substring).
Omit \`item\` to just open the menu and list its sections. Requires a \`menu\` block in the app
profile (apps/<app>.json: openKey, root, item, title, exitKey) — the MCP itself knows nothing
about any particular app's markup.

Opening presses the menu key until the focus is inside the menu root (one press per column away
from the sidebar; \`maxOpenPresses\` default 20). Inside a section the open key may do nothing —
one \`exitKey\` press is tried as an escape. \`select:false\` stops on the item without ENTER.

Answer: \`{ok, chosen?, opened?, items: [titles], selected, presses, state, ms, evals}\`; on failure
\`{ok:false, reason, items?, openPresses?, goto?, state}\`.
${COMMON}`,

	tv_sequence: `# tv_sequence

Run a whole case body in ONE call, under the device lock so nothing interleaves, with a verdict
per step. \`stopOnFail\` (default true) stops at the first red step.

Steps are objects, one key each:

    {"launch": {"relaunch": true}}                 start from a known state (true = relaunch)
    {"press": "RIGHT", "repeat": 2, "intervalMs": 250, "durationMs": 0}
    {"longpress": "ENTER", "durationMs": 1500}
    {"goto": {"direction": "DOWN", "text": "…"}}   also {"element": "catalog.tile"}, {"ref": "e3"}, {"select": true}
    {"menu": "Settings"}                           {"menu": null} opens and lists; "options": {select, maxOpenPresses}
    {"wait": {"scene": "player"}, "timeoutMs": 30000, "stableMs": 300}
    {"expect": {"selector": "[class*=popup]"}}     same conditions as tv_wait_for; failing fails the step
    {"expectRequest": {"urlPattern": "track", "method": "POST", "bodyContains": "event_id", "timeoutMs": 8000}}
    {"networkMark": true}                          widen the expectRequest window to here
    {"eval": "ES5 expression"}
    {"sleep": 1000}
    {"videoState": true, "expectAdvancing": true, "sampleGapMs": 600}
    {"state": true}
    {"snapshot": {"detail": "focus"}}
    {"profileStart": {"samplingIntervalUs": 1000}}
    {"profileStop": {"path": "…", "sourceMap": "…", "topN": 20}}
    {"metrics": true}                              or {"collectGarbage": true}

\`wait\` / \`expect\` also take \`{"element": …}\` / \`{"elementGone": …}\` / \`{"sceneName": …}\` — names
from the app profile registry, echoed back as \`resolvedFrom\`. \`expect\` defaults to a 5s timeout
and matches from the step's start. \`expectRequest\` asserts on the network log (see tv_network) and
matches requests sent since the step began — put \`{"networkMark": true}\` before the action to widen
the window; use \`"absent": true\` or \`"count": {"max": 1}\` to catch a duplicate (both wait out the
whole timeout).

Answer: \`{ok, failedAt, ran, of, steps: [{i, step, ok, ms, brief? | result?}], finalState}\`. A green
navigation step (launch / press / goto / menu / wait / expect / sleep / networkMark) is one line in
\`brief\`; a reading (eval, state, snapshot, videoState, metrics, profileStart/Stop, expectRequest)
and every red step keep their full \`result\`. \`report:"full"\` keeps every result.
${COMMON}`,

	tv_evaluate: `# tv_evaluate

Run arbitrary JavaScript in the app page and return the value (escape hatch): custom assertions,
reading app state, restoring localStorage after a debug relaunch. Old TVs are Chrome 38 — keep the
expression ES5. \`awaitPromise\` (default true) awaits a returned promise; on engines without
awaitPromise the promise is settled by a host-side poll.

The answer is capped at 16 KB: \`{value, truncated: true, bytes, hint}\` when cut. Narrow the
expression (pick fields, slice strings) rather than reading a whole document.
${COMMON}`,

	tv_profile: `# tv_profile

Record a JS CPU profile on the device, and/or read memory & layout metrics.

* \`start\` — begin sampling (\`samplingIntervalUs\`, default 1000; raise it, e.g. 4000, for long
  recordings on a weak TV). \`collectGarbage:true\` forces a GC before the opening metrics reading.
* \`stop\` — write a \`.cpuprofile\` (\`path\`, or a scratch path; open it in Chrome DevTools →
  Performance → Load profile) and return a top-N summary of self time by function and by file
  (\`topN\`, default 20). On a minified production build pass \`sourceMap\` (the app.js.map of THAT
  build) to get readable names.
* \`metrics\` — one Performance.getMetrics reading, no recording.

start and stop each take a Performance.getMetrics reading, so stop reports before/after/diff per
metric (JSHeapUsedSize, Nodes, JSEventListeners, LayoutCount, RecalcStyleCount, cumulative Duration
counters) — how you catch growth the CPU profile cannot see. The CPU profile works on the whole
park (Profiler exists down to Chrome 38); the full metric set needs Chromium 60+. An older engine
falls back to Memory.getDOMCounters — Nodes, Documents, JSEventListeners and Timestamp, enough to
catch a DOM/listener leak, with a warning and no faked heap or layout numbers; where even that is
missing, \`metrics\` fails with a clear message while start/stop still return the profile.

Answer of stop: \`{ok, path, bytes, durationMs, format, summary: {sampleCount, totalMs, topFunctions,
topFiles, …}, metrics: {windowSec, values: {name: {before, after, diff}}}, warning?}\`.
${COMMON}`,

	tv_heap: `# tv_heap

Take a heap snapshot on the device and/or compare two of them — the tool for "the heap grew and
never came back".

Leak hunt: \`snapshot\` (before) → do the scenario (tv_press / tv_menu / tv_sequence) → \`snapshot\`
(after) → \`diff\` with the two paths.

* \`snapshot\` — writes a \`.heapsnapshot\` file (\`path\` or a scratch path; open it in Chrome DevTools
  → Memory → Load) and returns the Summary view in numbers: total nodes and shallow size, how many
  DETACHED DOM nodes are still retained, and the top-N constructors by shallow size. It forces a
  full GC and pauses V8 for a long time (a minute on a TV; \`timeoutMs\` default 120000), so it is
  refused while a tv_profile recording is running.
* \`diff\` — \`before\` and \`after\` paths; returns the deltas — which constructors gained objects and
  bytes (\`topGrowth\`) and which lost them (\`topShrink\`), like the DevTools Comparison view. A pure
  file operation: no device needed.

Retainer paths ("who holds this") and retained/dominator sizes are deliberately NOT computed —
load the saved files in DevTools for those. Needs the HeapProfiler domain (fine on modern Tizen /
webOS / pc, best-effort on webOS 3).
${COMMON}`,

	tv_resources: `# tv_resources

webOS only. CPU % and memory of the whole TV and of the app under test, sampled on the TV — the
half tv_profile / tv_heap cannot see: the renderer's RSS (decoded images, layer textures, <video>
buffers on top of the JS heap) and how much memory the system has left before it starts killing
apps. Same data as LG's Resource Monitor: it runs \`ares-device --resource-monitor\` over the
dev-mode SSH. Needs no tv_launch and does not touch the CDP session.

* \`start\` — spawns two background samplers (\`ares-device -r\` and \`-r -id <appId>\`), each writing
  a CSV (\`path\` = directory, default TMPDIR), and returns once the first system sample is in, with
  the current reading. \`intervalSec\` 1..60 (default 1); \`appId\` defaults to the device's appId.
  (\`appId\` and \`path\` are not in the tool schema — it is kept under 10 KB — but are accepted.)
  An unreachable TV fails here with the ares error.
* \`read\` — summary so far; sampling continues. Use it for checkpoints in a long scenario.
* \`stop\` — stops the samplers and returns the final summary. The CSVs stay on disk.

Scenario: \`start\` → act (tv_press / tv_menu / tv_sequence, or a human with the remote) → \`stop\`.
Pair it with tv_profile metrics: a JS heap that stays flat while \`app.rssMb.delta\` keeps growing
is native memory (images, video), not a JS leak.

Answer of read/stop: \`{ok, device, intervalSec, elapsedSec, running, window: {from, to},
system: {samples, memTotalMb, cpuPct, memAvailableMb, memUsedMb, swapUsedMb},
app: {id, samples, pids, cpuPct, rssMb}, csv: {system, app}, warnings?}\` where each series is
\`{min, max, avg, first, last, delta, maxAt}\` (MB for memory, maxAt = HH:MM:SS on the TV clock).

How to read the numbers: CPU % is a share of ALL cores (100 = every core busy), app memory is RSS,
system memory is \`free -k\` (memAvailableMb falls back to the "-/+ buffers/cache" free on an old
\`free\`). Resolution is one second. The per-app sampler reads every /proc/<pid>/stat each tick —
that load lands in the system CPU, not the app's. More than one entry in \`app.pids\` means the app
was restarted or killed mid-window. No app samples means it was not running, or
applicationManager/dev/running (the only way ares maps an app id to a pid) does not list it.
${COMMON}`
};

export const DOC_URI_PREFIX = 'tv-debug://docs/';

/**
 * @return {Array<{uri: string, name: string, description: string, mimeType: string}>}
 */
export function listDocResources() {
	return Object.keys(TOOL_DOCS).map((name) => ({
		uri: DOC_URI_PREFIX + name,
		name: `${name} — reference`,
		description: `Parameters, actions and answer shape of ${name}`,
		mimeType: 'text/markdown'
	}));
}

/**
 * @param {string} uri
 * @return {?string}
 */
export function readDocResource(uri) {
	if (!uri || !uri.startsWith(DOC_URI_PREFIX)) {
		return null;
	}
	const name = uri.slice(DOC_URI_PREFIX.length);
	return TOOL_DOCS[name] || null;
}
