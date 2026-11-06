# dsh-notify

English · [简体中文](README.zh.md)

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-6C4CF1)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

> A DSH plugin that raises a native desktop notification when a Session finishes while DeepSeek Harness is not the focused app — click the banner to jump straight back to that Session.

Sessions in DSH run for minutes at a time. When you switch to another app you should not have to keep checking the window: **dsh-notify** watches the Session list and, on every `running: true → false` edge, decides whether you are already looking at that conversation. If you are not, it posts a notification through the browser `Notification` API, which the DSH desktop shell turns into a real macOS Notification Center / Windows Action Center / Linux desktop notification, with the DeepSeek Harness app icon and the system sound.

It occupies no UI slots, has no settings, sends nothing over the network, and needs no host service.

## Features

### When a notification is raised

| Situation | Notifies? |
| --- | --- |
| A task finishes while DSH is in the background (another app focused / minimised / page hidden) | ✅ Yes — native system notification |
| A task finishes while you are literally looking at that conversation (window in front **and** `retainedBy.mainView > 0`) | ❌ No — you can already see it |
| DSH is in front, but **another** Session finishes | ✅ Yes — chat-app semantics: other conversations still announce |
| A subagent / Agent Teams teammate finishes | ❌ No — the Lead Session reports completion instead |
| A task was already running when the page loaded | ✅ Yes, but without duration text |
| A task started after the page loaded | ✅ Yes, with duration text such as `Task completed in 3m 5s · Click to open` |

"Which conversation am I looking at" is not guessed. The main view retains the Session it is showing, and the Session list row carries that knowledge as `retainedBy.mainView > 0` — the same field the shipped shell uses for every "current Session" read. The window must also be in front: `document.visibilityState === 'visible'` **and** `document.hasFocus()`.

### Everything else

- **Click to open.** Dismiss the banner, focus the DSH window, and open the Session it names (via the client `uiWorkspace` service).
- **No banner pile-up.** Each Session uses a stable notification `tag` (`dsh-notify:<session-id>`), so a repeat completion replaces the previous banner instead of stacking a second one.
- **Readable title.** The Session title, falling back to its display title, the workspace folder name, and finally "DSH session"; whitespace is collapsed and long titles are truncated.
- **Localized copy.** Notification title/body follow the DSH locale: 简体中文 and English dictionaries are shipped; other languages fall back to English.
- **Zero footprint.** No host service, no UI slot, no dependencies, no network, no state on the host.
- **Diagnosable.** One localStorage key records what the watcher saw and why it did (or did not) announce — see [Troubleshooting](#faq--troubleshooting).

## Install

> Prerequisite: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) with the Web UI, and Node.js >= 20 on the machine that runs it.

### From GitHub (recommended)

```bash
dsh plugin --profile <profile> add github:ChenYichener/dsh-notify
```

### From a local clone

```bash
git clone https://github.com/ChenYichener/dsh-notify.git
dsh plugin --profile <profile> add /path/to/dsh-notify
```

### DSH desktop app

Open the app's **Plugins** page and install the plugin from a local directory. This plugin is a regular profile bundle, so it survives `dsh` restarts and upgrades.

After installing, restart `dsh web` (or reload the DSH window). There is nothing to configure — the watcher starts automatically.

### Requirements

| Requirement | Value |
| --- | --- |
| DSH | Tested with `0.2.2-rc.1`; needs the Web UI and its Client plugin API |
| Node.js | `>= 20` |
| Runtime dependencies | None |
| OS notifications | Native notifications are delivered by the Electron shell; allow them for DeepSeek Harness in the OS settings |

The default profile is usually `web` (the one `dsh web` uses). Run `dsh plugin --profile web list` if you are unsure.

## Usage

The plugin is entirely automatic:

1. Start a task in a Session and switch to another app (or minimise DSH).
2. When the Session finishes, the OS shows a notification titled with the Session name and a body like `任务完成 · 点击打开会话` / `Task completed · Click to open`.
3. Click the notification. DSH comes forward and the finished Session opens.

| Interaction | Result |
| --- | --- |
| Task finishes in the background | System notification with app icon and system sound |
| Task finishes in another Session while DSH is in front | Notification, same as a chat app announcing a different conversation |
| Task finishes in the conversation on screen | Silent — no interruption |
| Click the notification | Closes the banner, focuses the window, opens the Session |
| Second completion in the same Session | Replaces the earlier banner (same notification `tag`) |

The first time macOS shows a notification from DeepSeek Harness it asks whether to allow it; choose **Allow**. Windows and Linux surface the same per-app notification permission in their system settings.

## How it works

- **Host half** (`index.js`) is intentionally inert. It exists so the bundle patch can mount the plugin row and publish its Client module; all behaviour lives in the browser.
- **Client half** (`client.js`) registers one Cordis plugin and injects the `sessions` and `locale` services.
- It subscribes to `ctx.sessions.list`, the Client's Host-authoritative Session list. Rows carry `running`, so the watcher can keep a map of the Sessions it has observed running and react to each `true → false` edge.
- **Priming:** the live list starts as `phase: 'pending'` with no rows. The watcher waits for the first `ready` snapshot; a Session that is already running then is recorded with an *unknown* start, so it never reports a bogus duration measured from page load.
- **The suppression decision** happens once per completion edge:
  - `parentId !== undefined` or `origin === 'subagent'` → subagent / teammate, stay silent;
  - `pageInFront() && retainedBy.mainView > 0` → you are looking at it, stay silent;
  - everything else → notify.
- **Delivery:** `new Notification(title, { body, tag })` inside the `dsh-app://app` page. Electron routes browser notifications to the OS, so the banner appears in Notification Center / Action Center / the desktop notification daemon.
- **Click handling:** `notification.onclick` closes the banner, calls `window.focus()` (best effort), and asks the `uiWorkspace` service to open the Session.
- **Localization:** both dictionaries are registered under the `dsh-notify` namespace; if the locale service is not ready yet, the bundled tables are used directly.
- **Tracing:** every interesting step writes one JSON object to `localStorage['dsh-notify:trace']` — `loaded`, an `edge` record with `subagent` / `foreground` / `watching` flags, or `notified`.

## Data & privacy

- **No network access.** The plugin never calls `fetch`, WebSocket, or any host route; there is no telemetry.
- **No host state.** The Host half declares no service and writes nothing.
- **One local write.** `localStorage['dsh-notify:trace']` holds a single overwritten diagnostic object (see below). It can be deleted at any time and only exists in that browser profile.
- **Notification content stays on the machine.** The title is the Session title (or the workspace folder name), and the body is fixed localized copy plus the observed duration.
- **Nothing is published anywhere.** Uninstalling the plugin leaves only that localStorage key behind; clearing it is harmless.

The diagnostic breadcrumb is the quickest way to confirm the plugin is running and why a given completion did or did not produce a banner:

```js
localStorage['dsh-notify:trace']
// {"event":"loaded","at":1730000000000}                  the client module ran in this page
// {"event":"edge","sessionId":"…","subagent":false,
//  "foreground":true,"watching":true,"at":…}             a completion was observed, and suppressed
// {"event":"notified","sessionId":"…","at":…}           a system notification was created
```

## Configuration

There are no plugin settings. The only knobs are OS-level:

| Knob | Where |
| --- | --- |
| Allow notifications for DeepSeek Harness | macOS: System Settings → Notifications; Windows: Settings → System → Notifications; Linux: desktop notification settings |
| Sound / Do Not Disturb | The same OS notification settings |

## Development

```bash
node --check index.js
node --check client.js
node --check scripts/smoke-notify.mjs
node scripts/smoke-notify.mjs
```

`scripts/smoke-notify.mjs` drives the **real** `client.js` against fake Cordis services and a fake `Notification`, so it needs no window and is fully deterministic. It covers eight scenarios:

1. real boot order (`pending → ready`): a pre-existing run is primed silently, then completion still notifies;
2. a background completion raises exactly one notification with the Session title and replacement `tag`, and clicking opens the Session, focuses the page and closes the banner;
3. foreground: the watched conversation stays silent, another Session still announces;
4. subagent / teammate rows stay silent;
5. a run observed from its start reports a formatted duration;
6. the English dictionary drives the body after a locale switch;
7. disappearing rows are forgotten silently and a later reuse of the same id notifies again;
8. a denied notification permission is handled without throwing.

A passing run prints:

```text
dsh-notify smoke: all scenarios passed
```

## Project layout

```text
dsh-notify/
├── README.md                 # English (default)
├── README.zh.md              # 简体中文
├── LICENSE                   # MIT
├── .gitignore
├── package.json              # bundle patch + dsh.client manifest
├── cordis.patch.yml          # inserts the dsh-notify plugin row
├── index.js                  # Host half: inert
├── client.js                 # Client half: completion edges → system notifications
├── locale/                   # plugin-manager title/description (en, zh)
│   ├── en.json
│   └── zh.json
├── icon.svg                  # plugin icon
└── scripts/
    └── smoke-notify.mjs      # headless deterministic smoke test
```

## FAQ / Troubleshooting

| Symptom | Fix |
| --- | --- |
| No banner at all | Check that notifications are allowed for DeepSeek Harness in the OS settings. On macOS the first notification asks for permission; if it was denied once, re-enable it in System Settings → Notifications. |
| `Notification.permission` is `granted` but nothing appears | The OS can still refuse at show time (per-app settings). The plugin only receives `notification.onerror` and logs a console warning; fix the OS setting. |
| Banner appears while DSH is in front | Expected unless it is the conversation on screen. Only the Session with `retainedBy.mainView > 0` is silenced — another Session finishing still announces. |
| The notification has no duration | The task was already running when the page loaded (or the page reloaded mid-task). Duration is only known for runs the watcher observed from the start. |
| Nothing appears after the DSH app is quit | There is no renderer process left to raise the notification. The plugin only covers tasks that finish while the page is alive. |
| Click does nothing | The Session may have been archived before the click; window focus is best effort and the OS usually activates DSH on click. |
| Is the plugin even running? | Open DevTools on the DSH page and read `localStorage['dsh-notify:trace']`; `loaded` means the client module ran, `edge` explains a suppression. |
| Notification copies are wrong language | Only `zh` and `en` dictionaries are shipped; other locales fall back to English. Change the DSH language to one of the two. |

## Compatibility

- **Platforms:** macOS, Windows and Linux through the DSH desktop app. In a plain browser (`dsh web` opened in a tab) browser notification permission and tab liveness apply instead.
- **Liveness:** the page must be alive. Closing the window so the app exits means no process can raise a notification.
- **DSH plugin API:** the client side reads `ctx.sessions.list` snapshots and the `retainedBy.mainView` field of each row. Those are stable DSH Web UI structures today, but they are internal APIs: a future DSH release could rename them and require a plugin update.
- **No dependencies:** the plugin is plain ES modules and browser APIs only; nothing to build.

## Related DSH plugins

| Plugin | What it does |
| --- | --- |
| [dsh-book](https://github.com/ChenYichener/dsh-book) | Markdown draft library + AI copywriting workspace for Xiaohongshu / WeChat / generic posts |
| [dsh-notify](https://github.com/ChenYichener/dsh-notify) | Native desktop notification when a session finishes while DSH is in the background |
| [dsh-pomodoro](https://github.com/ChenYichener/dsh-pomodoro) | Distraction-free Pomodoro timer in the sidebar |
| [dsh-translate](https://github.com/ChenYichener/dsh-translate) | Chinese/English translation workbench with an always-on AI tutor and neural read-aloud |
| [dsh-nce](https://github.com/ChenYichener/dsh-nce) | New Concept English Book 1 study panel (lessons, SRS flashcards, mistake notebook) |

## License

[MIT](LICENSE) © 2026 chenyichen
