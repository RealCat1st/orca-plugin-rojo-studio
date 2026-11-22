# HOWTO: Rojo Studio — design, APIs and limits

How the plugin is built, which Orca APIs it uses (with sources), what was tested and what it
cannot do. Paths under `_ref/` refer to the reference checkouts in
`../copilot-chat-agent/_ref/` (Orca core `orca-main/`, official plugins, community catalog).

## 1. Shape of the plugin

| Part | File | Runs in |
| --- | --- | --- |
| Manifest | `orca-plugin.json` | — |
| Worker (all logic, all processes) | `src/worker.ts` + `src/jobs.ts`, `src/system.ts`, `src/net.ts`, `src/installer.ts` | Node process Orca starts (`trusted-worker`) |
| Pure logic (shared, unit-tested) | `src/core/*.ts` (ZIP reader, releases and versions, project linter and tree, output parsing, MessagePack) | worker; `output.ts` also in the panel |
| Panel | `src/panel.html` → `panel.css`, `panel.ts`, `src/panel/*.ts` | Orca's isolated plugin frame (`ui: "html"`) |
| Contract | `src/protocol.ts` (`PluginRequests`, `PluginPanelEvents`) | type-only, both sides |

No build step: Orca transpiles `.ts` for the worker and for frame scripts
(`docs/reference/plugin-authoring.md`, "A worker's `main` is an ES module…"; "With isolated
frames, scripts may be TypeScript…"). No npm dependencies.

### Why `trusted-worker`

Running `rojo` needs a process, downloading Rojo needs the network and unpacking it needs the
file system. Panels have none of these: frames "make no connections, requests or DNS lookups"
and have no Node (`plugin-isolated-frames.md`, "Network is denied at the session").
A `trusted-worker` `main` "runs in a separate Node process and can call every host method its
`capabilities` allow"; "This filter only keeps secrets held in Orca's environment out of plugins;
it is not a sandbox. A worker runs as you" (`plugin-authoring.md`). So:

- **Processes**: `node:child_process.spawn` (no shell, arguments as an array, `windowsHide`).
- **Network**: global `fetch` (GitHub API and downloads; `127.0.0.1` probe of a busy port).
- **Files**: `node:fs/promises` (project files, the data folder).

There is no manifest capability for processes, network or files: approving the plugin's
`trusted-worker` profile is the consent, and Orca's approval screen says so ("Runs its own code in
a separate Node.js process on the Orca host, with your user account's access").

### Why an HTML panel (not a components panel)

Components panels are drawn by Orca from a fixed catalog with semantic props only — no custom
layout, colours or animation (`plugin-declarative-ui.md`, "Props are semantic… never class names,
styles or colours"). The brief asked for a first-class, animated UI, so the panel is an HTML page
in the isolated frame that styles itself **only** from Orca's frame variables (`--orca-background`,
`--orca-foreground`, `--orca-card`, `--orca-border`, `--orca-primary`, `--orca-destructive`,
`--orca-radius`, `--orca-font-sans`, `--orca-font-mono`, …; `plugin-theme-tokens.md`, "Frame CSS
variables"). Orca updates those variables and the `light`/`dark` class on `<html>` in place on a
theme switch, so the panel follows every theme without reloading. Status hues (green / amber /
blue) are tuned per `light`/`dark` for contrast; motion respects `prefers-reduced-motion`.

Trade-off: `orca plugin check` can only render components panels, so the HTML panel is tested in
a browser harness instead (section 6).

The panel re-renders the whole view from state through a ~150-line keyed virtual DOM
(`src/panel/vdom.ts`), which keeps focus, selections, scroll and CSS transitions intact. The log
view is a DOM element the panel appends to directly (thousands of lines without re-rendering).

### Worker lifetime

"A plugin with `main` and status bar items has its worker started when it is enabled and kept
running while it stays enabled" (`plugin-host-api.md`, `statusBar.update`). Without that, an idle
worker may be stopped, which would kill running servers. The status bar item is therefore also
what keeps `rojo serve` alive while the panel is closed. `deactivate()` kills every child process,
so a disabled or updated plugin leaves no orphan `rojo` behind.

## 2. Orca APIs used

| Need | API | Capability | Source |
| --- | --- | --- | --- |
| Focused workspace | `workspace.readContext` | `workspace:read` | `plugin-host-api.md` |
| Its folder and host | `workspace.list` (`path`, `hostId`) | `workspace:read` | same; id match as in `copilot-chat-agent` |
| Follow focus | event `workspace.changed` (worker and panel) | `workspace:read` | `plugin-host-api.md`, Events |
| Open project/source file | `editor.open` (`path` relative to the workspace) | `workspace:write` | `src/shared/plugins/workers/plugin-host-api-workspace-methods.ts` `editorOpenParams` |
| Remote run | `terminal.create`, `terminal.read`, `terminal.close` | `terminal:send`, `terminal:read` | `plugin-host-api.md` |
| Failure alert | `notifications.show` | `notifications:show` | same |
| Status bar | `contributes.statusBarItems` + `statusBar.update` | none | same |
| Persist choices | `orca.storage` (`selected`, `prefs`, `recent`, `rojo.chosen`, `releases.cache`) | `storage:own` | `plugin-authoring.md`, "Panels, workers and data" |
| Settings | `contributes.settings` + `orca.settings` (`onDidChange`) | `settings:own` | same |
| Panel ↔ worker | `orca.panels.handle` / `orca.panels.post`; frame `orca.plugin.request` / `.on` | none | same |
| Save `Rojo.rbxm` | frame `orca.files.saveAs` (needs a click; desktop only) | none | `plugin-authoring.md`, "Frames" |
| Release notes | frame `orca.shell.openExternal` | none | same |

Command palette entries without `action` are worker commands (`orca.commands.register`); the
"show panel" entry uses the built-in `sidebar.right.toggle` action, so it works without the worker.

`workspace:write` is broader than needed (it also allows renaming workspaces); the plugin calls
only `editor.open` with it. Without the capability the panel still works; only "open file" is lost.

## 3. Rojo integration

### Finding Rojo (`src/system.ts`)

Order: the *Path to rojo* setting; plugin-managed versions in the data folder; `~/.rokit/bin`,
`~/.aftman/bin`, `~/.foreman/bin`, `~/.cargo/bin`; every `PATH` entry. Each candidate runs
`--version` **with the workspace as working directory**, because tool-manager shims resolve the
version from the project's `rokit.toml` / `aftman.toml` / `foreman.toml`. Duplicates (same path,
or `PATH` entries resolving to the same file) are merged.

"Automatic" picks: custom path → the shim of the manager that pins Rojo in the workspace → `PATH`
→ newest managed version. The person can choose any found install instead (stored per machine).

Orca's worker environment is an allowlist (`src/main/plugins/workers/parent-process/plugin-worker-env.ts`):
`PATH`, `HOME`, `USERPROFILE`, temp and locale variables, … — no `LOCALAPPDATA`/`APPDATA` on
Windows, and `ELECTRON_RUN_AS_NODE=1`. `childEnv()` removes `ELECTRON_RUN_AS_NODE`, rebuilds
`LOCALAPPDATA`/`APPDATA` from `USERPROFILE` (Rojo needs them to find Studio's plugins folder) and
appends the tool-manager bin folders to `PATH` (GUI-launched Orca often lacks them).

### Installing Rojo (`src/installer.ts`, `src/core/releases.ts`, `src/core/zip.ts`)

1. `GET https://api.github.com/repos/rojo-rbx/rojo/releases?per_page=40` with a generic
   `User-Agent` (no user data). Cached for an hour in plugin storage, because the anonymous API
   allows 60 requests per hour; a rate-limit answer says when to retry.
2. The asset for this machine: `rojo-<v>-<os>-<arch>.zip` (`linux|macos|windows`,
   `x86_64|aarch64`); Apple silicon and Windows on ARM fall back to the x86_64 build when no native
   one exists; Rojo 7.0–7.2 names (`-win64.zip`, `-macos.zip`, `-linux.zip`) are understood.
3. Download with progress (streamed `fetch`), then **SHA-256 check** against the `digest` GitHub
   publishes for each asset (`sha256:…`; skipped only for old assets that have none).
4. Unpack with the plugin's own ZIP reader (Node has no unzip, and `unzip` is not installed
   everywhere): central directory, stored or deflate (`zlib.inflateRawSync`), size check; refuses
   ZIP64, encryption and unsafe names (`..`, absolute paths).
5. Write `<data>/rojo/<version>/rojo(.exe)` via a temp file and rename, `chmod 755`, run
   `--version` to prove it works on this machine, record `install.json`, select it.

### Running Rojo (`src/jobs.ts`)

Every command is a *job* with status, exit code, a one-line summary and up to 3000 lines of
output. Commands (all with `--color never` on Rojo 7):

| Job | Command |
| --- | --- |
| serve | `rojo serve <project> --address 127.0.0.1\|0.0.0.0 --port N` |
| build / watch build | `rojo build <project> --output <file> [--watch]` |
| sourcemap / watch | `rojo sourcemap <project> --output <file> [--include-non-scripts] [--absolute] [--watch]` |
| new project | `rojo init <folder> --kind place\|model\|plugin [--skip-git]` |
| Studio plugin | `rojo plugin install` (Windows, macOS) |

A server counts as *running* when Rojo prints its `Rojo server listening: / Address: / Port:`
block (`ServeWatcher`). Errors are summarised from Rojo's `[ERROR rojo] …` lines. Stop sends
SIGTERM, then SIGKILL after 3 s.

**Port in use.** Before starting, the worker binds the port itself (`net.createServer().listen`,
exclusive) to see whether it is free. If not, it asks `http://127.0.0.1:<port>/api/rojo`: Rojo
7.7 answers with MessagePack (older versions JSON), decoded by `src/core/msgpack.ts`, which names
the other server's project and version. It then offers the next free port. The same check runs as
you type a port. If Rojo itself fails with "address already in use", the job gets the same fix.

**Connected Studio.** Rojo has no API for connected clients, so the worker counts distinct remote
hosts with an `ESTABLISHED` TCP connection to the server's port every 3 s: `/proc/net/tcp(6)` on
Linux, `netstat -an` on Windows and macOS. The Studio plugin keeps a connection open while
connected, so this is reliable for "connected or not"; several Studio windows on one computer
count as one host.

### Remote workspaces: the Orca-terminal route

The worker runs on the computer with the Orca desktop app, but an SSH workspace's files live on
another host. There, the plugin uses the closest supported route: `terminal.create({ workspaceId,
command })` opens a terminal **on the workspace's host** and runs
`cd <dir> && rojo … ; printf '\n[rojo-studio] exited with %s\n' "$?"`. The worker follows the
output with `terminal.read` once a second (it returns the newest lines, so `diffTerminalLines`
anchors on the last lines seen) and reads the exit code from the marker. Stop is
`terminal.close`. Trade-offs: a POSIX shell is assumed on the remote host, no port pre-check, no
client count, no tree or linter (the files are not local), and the project path is typed by hand.
The *Run Rojo in* setting can force either route.

## 4. The project inspector (`src/core/project.ts`)

- **Parsing**: Rojo accepts JSON with comments and trailing commas. `stripJsonc` blanks them out
  *in place* (offsets unchanged), so `JSON.parse` errors map back to the right line and column.
- **Tree**: each project node becomes an instance (`$className`, or a service name Rojo can infer
  under the DataModel, or `StarterPlayerScripts`/`StarterCharacterScripts`/`Terrain`); `$path`
  nodes are expanded from disk with Rojo's sync rules (`init.server.luau` → Script,
  `init.client.luau` → LocalScript, `init.luau` → ModuleScript, `*.server.luau`, `*.client.luau`,
  `*.luau`/`*.lua`, `*.json`/`*.toml` → ModuleScript, `*.txt` → StringValue, `*.csv` →
  LocalizationTable, `*.model.json` → its `ClassName`, `*.rbxm(x)`, nested `*.project.json` and
  folders with a `default.project.json`; `*.meta.json` and unknown files are skipped). Limits:
  1500 nodes, depth 12, 250 children per folder, 4 nested projects.
- **Linter**: invalid JSON (line/column), missing `name`/`tree`, unknown top-level and `$` keys
  with "did you mean" (edit distance), wrong types for `$className`, `$path`, `$properties`,
  `$attributes`, `$ignoreUnknownInstances`, `servePort`, place-id lists and `globIgnorePaths`,
  missing `$path` targets (info for `{ "optional": … }`), backslashes and absolute paths, a
  DataModel below the root, instances without `$className`/`$path`, and a `$className` that
  disagrees with the file it maps.

## 5. Decisions and limits

- **Data folder**: Orca gives workers no data-folder API (the `pluginRoot` a worker receives is
  internal, `plugin-authoring.md`, Stability), so the plugin uses the OS convention:
  `$XDG_DATA_HOME/rojo-studio` or `~/.local/share/rojo-studio`, `~/Library/Application
  Support/RojoStudio`, `%LOCALAPPDATA%\RojoStudio`. Uninstalling the plugin does not delete it.
- **Clipboard**: frames deny `navigator.clipboard`; copy buttons use `document.execCommand('copy')`
  inside the click, which the isolated frame allows (`plugin-isolated-frames.md`).
- **Saving `Rojo.rbxm`**: the worker downloads and caches the file (SHA-256 checked) and hands it
  to the panel in 192 KiB base64 chunks (a `plugin.request` answer is capped at 1 MiB). If that
  takes longer than the click's few-second activation window, the button turns into a second
  "Save" that opens the dialog immediately.
- **Studio plugin on Linux**: Rojo answers "Your platform is not currently supported" — Studio
  does not run on Linux — so the panel explains the VM / other-computer route instead.
- **Servers stop with the worker** (disable, update, restart, quitting Orca). They are not
  daemonised on purpose: no orphan servers holding ports after the plugin is gone.
- **Name**: "Rojo Studio" names what it works with; the README and manifest say it is unofficial
  (Orca listing policy, "No impersonation"). The icon is original.
- **Browser clients** (`orca serve`) are not supported: the panel relies on isolated-frame assets
  (separate CSS and modules) and `orca.files`.

## 6. How it was tested

| What | How | Result |
| --- | --- | --- |
| Types | `tsc -p .` with Orca's generated typings + `typings/node-shim.d.ts` | clean |
| Manifest | `orca plugin validate .` and on the packaged copy | ok |
| Pure logic | `orca plugin test .`: ZIP reader (built archives, stored/deflate, unsafe names), asset choice for 6 OS/arch pairs and legacy names, semver incl. prereleases, releases API parsing, MessagePack, serve output, error summaries, port-in-use texts, `/proc/net/tcp` and Windows/macOS `netstat` parsing, terminal diffing and exit marker, shell quoting, JSONC, linter (8 kinds of problems), tree for the place template, nested projects, toolchain pins | pass |
| Worker | `mountWorker` + `mockHost` + a temp workspace + a fake `rojo` script: project discovery, managed-Rojo detection, serve → running (state and log posts, status bar) → second start refused → build writes the file → wrong format refused → stop; busy port → error job with a suggested port; no Rojo / no workspace messages | pass |
| Real Rojo (`ROJO_STUDIO_E2E=1`) | Through the worker: download v7.7.1 for linux-x86_64 from GitHub, SHA-256 check, unpack, `--version`; `rojo init` place; inspect (no problems); serve on a free port; `/api/rojo` answers with the project name; one connected host counted; port check names the holder; build `.rbxl`; sourcemap; `Rojo.rbxm` download; stop and port closed | pass |
| Panel | Transpiled to JS and loaded in headless Chrome with a stand-in `window.orca`; driven over the DevTools protocol: rendering of all tabs, Stop/Start requests, output filter, `Alt+1…4`, `Ctrl+Enter`, output format switch, tree expand and arrow keys, New project, Install, choosing an install, the port fix button, empty states; no console errors. Screenshots in light and dark (`docs/screenshots/`) | pass (found and fixed one patcher bug) |

Not tested here: Windows and macOS (no machines), `rojo plugin install` (Linux has no Studio),
the Orca-terminal route against a real SSH host, and the panel inside the Orca desktop app itself
(this machine runs Orca's remote runtime only, no desktop window to load the panel into).
