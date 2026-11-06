/**
 * Browser half of dsh-notify: system notifications for finished DSH tasks.
 *
 * A task = one Session running interval. `ctx.sessions.list` is the Client's
 * Host-authoritative Session list; its rows carry `running`, so the watcher
 * keeps the set of Sessions observed running and posts a notification on each
 * `running: true → false` edge.
 *
 * The banner is suppressed only for the conversation the user is already
 * looking at, exactly like a chat app: the page must be in front
 * (`document.visibilityState === 'visible'` and `document.hasFocus()`) AND the
 * finished Session must be the one the main view retains
 * (`row.retainedBy.mainView > 0`, the same discriminator the shipped shell
 * uses for every "current Session" read). Everything else notifies: work that
 * finished in the background, and work that finished in another Session while
 * the user is busy in DSH.
 *
 * - Notifications use the browser `Notification` API, which Electron serves as
 *   a native OS notification (app icon, system sound, Notification Center).
 * - Clicking one focuses the window and opens the Session it names.
 * - Subagent / teammate Sessions (`parentId` / `origin: 'subagent'`) are
 *   skipped: they finish in bursts and their Lead Session reports completion.
 *
 * Plain-JavaScript client bundle: the factory registers one Cordis plugin, no
 * slots are occupied and no React is required. All text goes through the
 * Client locale service; this namespace falls back to the bundled tables when
 * the locale service has not registered it yet.
 *
 * @module dsh-notify/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory(require) {
    /** Services required before the watcher starts. */
    const inject = ['sessions', 'locale']

    const NS = 'dsh-notify'

    /** Copy for the two shipped locales. */
    const TEXT = {
      zh: {
        body: '任务完成 · 点击打开会话',
        bodyWithDuration: '任务完成 · 用时 {duration} · 点击打开会话',
        seconds: '{n} 秒',
        minutes: '{n} 分 {s} 秒',
        hours: '{n} 小时 {m} 分',
        fallbackTitle: 'DSH 会话',
      },
      en: {
        body: 'Task completed · Click to open',
        bodyWithDuration: 'Task completed in {duration} · Click to open',
        seconds: '{n}s',
        minutes: '{n}m {s}s',
        hours: '{n}h {m}m',
        fallbackTitle: 'DSH session',
      },
    }

    /** Fill `{name}` placeholders from `params`. */
    function format(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (
        params[name] === undefined ? match : String(params[name])
      ))
    }

    /** Collapse a title to one readable line of bounded length. */
    function tidy(text, limit) {
      const value = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
      return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
    }

    /** Trailing path segment of a POSIX or Windows path. */
    function basename(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]/).filter((part) => part !== '')
      return parts.length === 0 ? '' : parts[parts.length - 1]
    }

    /** The language whose bundled table backs the fallback path. */
    function backupLanguage(locale) {
      try {
        const active = String(locale.getSnapshot().active ?? '')
        if (active.startsWith('zh')) return 'zh'
        if (active !== '') return 'en'
      } catch {
        // The locale service is optional for this decision; fall through.
      }
      try {
        return String(navigator.language ?? '').startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    function apply(ctx) {
      const sessions = ctx.sessions
      const locale = ctx.locale

      const language = backupLanguage(locale)
      /** Localized text: namespace dictionary first, bundled table second. */
      function text(key) {
        try {
          const bound = locale.bind(NS)
          if (typeof bound === 'function') {
            const value = bound(key)
            if (typeof value === 'string' && value !== '') return value
          }
        } catch {
          // The namespace may not be registered yet; the bundled table still works.
        }
        return TEXT[language][key] ?? key
      }

      /** @type {Map<string, number | null>} observed running Sessions; `null` = run began before this page loaded. */
      const runningSince = new Map()
      /** Whether the session list was primed from its first snapshot. */
      let primed = false
      let warned = false

      function warnOnce(reason) {
        if (warned) return
        warned = true
        try {
          console.warn(`[dsh-notify] ${reason}`)
        } catch {
          // Console is best effort.
        }
      }

      /**
       * One best-effort breadcrumb in this page's localStorage: proves from the
       * Host side that the Client module ran, and leaves a short "why did (not)
       * a banner appear" record for later troubleshooting without DevTools.
       */
      function trace(event, detail) {
        try {
          localStorage.setItem(`${NS}:trace`, JSON.stringify({ event, at: Date.now(), ...detail }))
        } catch {
          // Storage is optional (private mode); tracing must never break the watcher.
        }
      }

      /** Human duration for the notification body. */
      function describeDuration(durationMs) {
        const total = Math.max(0, Math.round(durationMs / 1000))
        if (total < 60) return format(text('seconds'), { n: total })
        if (total < 3600) {
          return format(text('minutes'), { n: Math.floor(total / 60), s: total % 60 })
        }
        return format(text('hours'), { n: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) })
      }

      /** True while the user is actually looking at this page. */
      function pageInFront() {
        try {
          if (typeof document === 'undefined') return false
          if (document.visibilityState !== 'visible') return false
          return typeof document.hasFocus === 'function' ? document.hasFocus() : false
        } catch {
          return false
        }
      }

      /** Subagent / teammate rows report through their Lead Session instead. */
      function isSubagent(row) {
        return row.parentId !== undefined || row.origin === 'subagent'
      }

      /**
       * Whether the main view currently retains this Session. The shipped shell
       * reads the current conversation from this exact count
       * (`retainedBy.mainView`); it is the only public "what am I looking at"
       * discriminator on the Session list.
       */
      function mainViewSession(row) {
        try {
          const counts = row.retainedBy
          return counts !== null && typeof counts === 'object' && (counts.mainView ?? 0) > 0
        } catch {
          return false
        }
      }

      /** One human-facing name for the notification title. */
      function sessionTitle(id, row) {
        const candidates = [row.title, row.displayTitle, basename(row.cwd)]
        for (const candidate of candidates) {
          const value = tidy(candidate, 80)
          if (value !== '' && value !== id) return value
        }
        return tidy(text('fallbackTitle'), 80)
      }

      /** Raise one native notification for a finished Session. */
      function notify(id, row, durationMs) {
        if (typeof Notification !== 'function') {
          warnOnce('Notification API is unavailable in this page')
          return
        }
        try {
          if (Notification.permission === 'denied') {
            warnOnce('system notifications are denied for DSH; enable them in the OS settings')
            return
          }
        } catch {
          // Permission state is advisory here; try the constructor below.
        }
        const title = sessionTitle(id, row)
        const body = durationMs === null || durationMs === undefined
          ? text('body')
          : format(text('bodyWithDuration'), { duration: describeDuration(durationMs) })
        let notification
        try {
          notification = new Notification(title, { body, tag: `${NS}:${id}` })
        } catch (error) {
          warnOnce(`could not create a system notification: ${String(error)}`)
          return
        }
        trace('notified', { sessionId: id })
        notification.onclick = () => {
          try {
            notification.close()
          } catch {
            // Closing is best effort.
          }
          try {
            window.focus()
          } catch {
            // Focus is best effort; the OS may already activate DSH.
          }
          try {
            const controller = ctx.get('uiWorkspace')
            if (controller !== undefined && typeof controller.openSession === 'function') {
              controller.openSession(id)
            }
          } catch {
            // The Session may have been archived before the click.
          }
        }
        // The OS can refuse to display a notification while the renderer still
        // reports permission 'granted' (macOS app-level notification settings),
        // so this failure event is the only show-time signal the page receives.
        notification.onerror = () => warnOnce('the system refused to display a notification')
      }

      /**
       * Reconcile the observed running set against one Session list snapshot.
       * Called synchronously on every list change: unaffected Sessions cost a
       * map lookup, and only a real `true → false` edge produces a notification.
       *
       * The live list starts as `phase: 'pending', ids: []` and becomes
       * `'ready'` after the first Host list response. Priming therefore waits
       * for the first ready snapshot: a Session that is already running then is
       * marked with an unknown start (duration omitted) instead of reporting a
       * bogus duration measured from an empty baseline.
       */
      function reconcile() {
        let state
        try {
          state = sessions.list.getSnapshot()
        } catch {
          return
        }
        if (state === null || typeof state !== 'object' || !Array.isArray(state.ids)) return
        if (!primed && state.phase !== 'ready') return
        const byId = state.byId ?? {}
        const seen = new Set()
        for (const id of state.ids) {
          const row = byId[id]
          if (row === undefined || row === null) continue
          seen.add(id)
          if (row.running) {
            if (!runningSince.has(id)) runningSince.set(id, primed ? Date.now() : null)
            continue
          }
          if (!runningSince.has(id)) continue
          const startedAt = runningSince.get(id)
          runningSince.delete(id)
          const subagent = isSubagent(row)
          const foreground = pageInFront()
          // Silent only for the conversation the user is literally looking at:
          // another Session finishing while DSH is in front still announces,
          // which is what makes this feel like a chat app.
          const watching = foreground && mainViewSession(row)
          // Record every observed completion edge and why it did (not) announce,
          // so "no banner" is diagnosable from one localStorage key.
          trace('edge', { sessionId: id, subagent, foreground, watching })
          if (subagent) continue
          if (watching) continue
          notify(id, row, startedAt === null ? null : Date.now() - startedAt)
        }
        for (const id of runningSince.keys()) {
          if (!seen.has(id)) runningSince.delete(id)
        }
        primed = true
      }

      // One effect owns both the subscription and its cleanup. The priming call
      // runs after `apply`, so nothing is announced for a task already running
      // when this page loaded.
      ctx.effect(() => {
        let unsubscribe = () => {}
        try {
          reconcile()
          unsubscribe = sessions.list.subscribe(reconcile)
        } catch (error) {
          warnOnce(`could not watch the Session list: ${String(error)}`)
        }
        return () => {
          try {
            unsubscribe()
          } catch {
            // Disposal is best effort.
          }
        }
      }, `${NS}: watcher`)

      // Ship both dictionaries; a missing locale service registration is not fatal.
      ctx.effect(() => {
        const disposers = []
        for (const id of Object.keys(TEXT)) {
          try {
            disposers.push(locale.register(NS, id, TEXT[id]))
          } catch {
            // A duplicate namespace keeps serving the already registered table.
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // Disposal is best effort.
            }
          }
        }
      }, `${NS}: dictionaries`)

      trace('loaded')
    }

    return { inject, apply }
  },
})
