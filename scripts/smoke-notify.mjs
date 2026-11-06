/**
 * Deterministic smoke test for dsh-notify's browser half.
 *
 * The Client bundle is a classic script that registers a factory on
 * `window.__ModuleLoader__`. This harness installs that facade, imports the
 * real `client.js`, and drives the factory with fake Cordis services and a
 * fake `Notification` so every completion-edge rule can be checked without a
 * window: priming, `running: true → false` edges, focus suppression, subagent
 * suppression, duration formatting, click-to-open and locale switching.
 *
 * Run with: node scripts/smoke-notify.mjs
 */

import assert from 'node:assert/strict'

/** @type {{ id: string, factory: (require: (name: string) => unknown) => { inject: string[], apply: (ctx: unknown) => void } } | undefined} */
let definition
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
  focus() {
    globalThis.__focusCalls += 1
  },
}
globalThis.__focusCalls = 0

await import(new URL('../client.js', import.meta.url))
assert.equal(definition.id, 'dsh-notify', 'client bundle registers its package id')
const moduleExports = definition.factory((name) => {
  throw new Error(`unexpected synchronous require: ${name}`)
})
assert.deepEqual(moduleExports.inject, ['sessions', 'locale'], 'client plugin declares its service injects')
assert.equal(typeof moduleExports.apply, 'function', 'client plugin exports apply')

/** Fake `Notification`; instances collect into `sent`. */
function installNotification(permission = 'granted') {
  const sent = []
  class FakeNotification {
    static permission = permission
    constructor(title, options = {}) {
      assert.equal(typeof title, 'string')
      this.title = title
      this.body = options.body
      this.tag = options.tag
      this.closed = false
      this.onclick = null
      sent.push(this)
    }
    close() {
      this.closed = true
    }
  }
  globalThis.Notification = FakeNotification
  return sent
}

/** Put the page in front (or not). */
function setPage({ visible = false, focused = false } = {}) {
  globalThis.document = {
    visibilityState: visible ? 'visible' : 'hidden',
    hasFocus: () => focused,
  }
}

/**
 * Build a fake Cordis Client context with a live Session list snapshot store.
 * @param {{ active?: string, phase?: string }} options
 */
function createHarness({ active = 'zh', phase = 'ready' } = {}) {
  const state = { ids: [], byId: {}, phase, projectionsBySession: {} }
  const listeners = new Set()
  const opened = []
  const dictionaries = new Map()
  const cleanups = []

  const sessions = {
    list: {
      getSnapshot: () => state,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
  const locale = {
    register(ns, id, dict) {
      if (dictionaries.has(id)) throw new Error(`duplicate locale ${id}`)
      dictionaries.set(id, dict)
      return () => {
        dictionaries.delete(id)
      }
    },
    bind(ns) {
      return (key) => dictionaries.get(active)?.[key]
    },
    getSnapshot() {
      return { active, locales: [], revision: 1 }
    },
  }
  const uiWorkspace = {
    openSession(id) {
      opened.push(id)
    },
  }
  const ctx = {
    sessions,
    locale,
    effect(callback) {
      cleanups.push(callback())
    },
    get(name) {
      return name === 'uiWorkspace' ? uiWorkspace : undefined
    },
  }

  /** Publish the current snapshot to subscribers. */
  function publish() {
    for (const listener of listeners) listener()
  }

  /** Add or replace one Session row and publish. */
  function row(summary) {
    if (!state.ids.includes(summary.id)) state.ids.push(summary.id)
    state.byId[summary.id] = summary
    publish()
  }

  /** Remove one Session row and publish. */
  function remove(id) {
    state.ids = state.ids.filter((candidate) => candidate !== id)
    delete state.byId[id]
    publish()
  }

  return {
    state,
    ctx,
    opened,
    listeners,
    row,
    remove,
    publish,
    dispose() {
      for (const cleanup of cleanups) {
        if (typeof cleanup === 'function') cleanup()
      }
    },
  }
}

function createSession(id, patch = {}) {
  return {
    id,
    displayTitle: `会话 ${id}`,
    title: `任务 ${id}`,
    running: true,
    blank: false,
    updatedAt: Date.now(),
    // Local reference sources; `mainView` marks the conversation on screen.
    retainedBy: {},
    ...patch,
  }
}

const sent = installNotification('granted')

// ---------------------------------------------------------------------------
// 1. Real boot order: the list is still `pending` and empty when the plugin
//    applies, then becomes ready with a Session already running. That run is
//    primed as unknown-start: no banner for the past, no bogus duration.
// ---------------------------------------------------------------------------
{
  setPage({ visible: false })
  globalThis.__focusCalls = 0
  const harness = createHarness({ phase: 'pending' })
  const before = sent.length
  moduleExports.apply(harness.ctx)
  harness.state.phase = 'ready'
  harness.row(createSession('a'))
  assert.equal(sent.length, before, 'priming on the first ready snapshot is silent')
  harness.row(createSession('a', { running: false }))
  assert.equal(sent.length, before + 1, 'completion after boot still notifies')
  assert.equal(sent[sent.length - 1].body, '任务完成 · 点击打开会话', 'unknown start omits the duration')
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 2. A late-loaded (HMR) page with a Session already running: prime silently,
//    then a running → finished edge while the page is behind raises one native
//    notification with the Session title, localized body and replacement tag.
// ---------------------------------------------------------------------------
{
  setPage({ visible: false })
  globalThis.__focusCalls = 0
  const harness = createHarness()
  harness.row(createSession('a'))
  moduleExports.apply(harness.ctx)
  const before = sent.length
  harness.row(createSession('a', { running: false }))
  assert.equal(sent.length, before + 1, 'finished task raises one notification')
  const notification = sent[sent.length - 1]
  assert.equal(notification.title, '任务 a', 'notification title is the Session title')
  assert.equal(notification.body, '任务完成 · 点击打开会话', 'body has no duration for a run that began before load')
  assert.equal(notification.tag, 'dsh-notify:a', 'tag lets a repeat completion replace the same banner')

  // Clicking opens the session, focuses the window and closes the banner.
  notification.onclick?.()
  assert.deepEqual(harness.opened, ['a'], 'click opens the finished Session')
  assert.equal(globalThis.__focusCalls, 1, 'click focuses the page')
  assert.equal(notification.closed, true, 'click closes the banner')
  harness.dispose()
  assert.equal(harness.listeners.size, 0, 'disposal unsubscribes the watcher')
}

// ---------------------------------------------------------------------------
// 3. While the page is in front, only the conversation actually on screen is
//    silent; another Session finishing in DSH still announces (chat-app feel).
// ---------------------------------------------------------------------------
{
  setPage({ visible: true, focused: true })
  const harness = createHarness()
  harness.row(createSession('b', { retainedBy: { mainView: 1 } }))
  harness.row(createSession('g'))
  moduleExports.apply(harness.ctx)
  const before = sent.length
  harness.row(createSession('b', { retainedBy: { mainView: 1 }, running: false }))
  assert.equal(sent.length, before, 'the watched conversation stays silent')
  harness.row(createSession('g', { running: false }))
  assert.equal(sent.length, before + 1, 'another Session finishing while DSH is in front notifies')
  assert.equal(sent[sent.length - 1].title, '任务 g', 'the other Session is named in the banner')
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 4. Subagent / teammate rows stay silent; their Lead Session reports.
// ---------------------------------------------------------------------------
{
  setPage({ visible: false })
  const harness = createHarness()
  harness.row(createSession('child', { parentId: 'lead', origin: 'subagent' }))
  moduleExports.apply(harness.ctx)
  const before = sent.length
  harness.row(createSession('child', { parentId: 'lead', origin: 'subagent', running: false }))
  assert.equal(sent.length, before, 'subagent completion stays silent')
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 5. A run observed from its start reports a duration.
// ---------------------------------------------------------------------------
{
  setPage({ visible: false })
  const harness = createHarness()
  moduleExports.apply(harness.ctx)
  const before = sent.length
  // The Session begins after load, so the watcher observes its start time.
  harness.row(createSession('c', { running: true }))
  // Complete the run; the watcher measures the duration from its own
  // observation and formats it into the body.
  harness.row(createSession('c', { running: false }))
  assert.equal(sent.length, before + 1, 'observed running edge notifies')
  assert.match(
    sent[sent.length - 1].body,
    /^任务完成 · 用时 \d+ 秒 · 点击打开会话$/u,
    'duration is formatted in the body',
  )
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 6. Locale switch: the registered English dictionary drives the body.
// ---------------------------------------------------------------------------
{
  setPage({ visible: false })
  const harness = createHarness({ active: 'en' })
  harness.row(createSession('d'))
  moduleExports.apply(harness.ctx)
  const before = sent.length
  harness.row(createSession('d', { running: false }))
  assert.equal(sent.length, before + 1)
  assert.equal(sent[sent.length - 1].body, 'Task completed · Click to open', 'English dictionary is used')
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 7. Disappearing rows are forgotten silently, and removal does not leak.
// ---------------------------------------------------------------------------
{
  setPage({ visible: false })
  const harness = createHarness()
  harness.row(createSession('e'))
  moduleExports.apply(harness.ctx)
  const before = sent.length
  harness.remove('e')
  assert.equal(sent.length, before, 'removal is silent')
  // A later reuse of the same id starts a fresh interval and can notify.
  harness.row(createSession('e'))
  harness.row(createSession('e', { running: false }))
  assert.equal(sent.length, before + 1, 'a new run of the same id notifies')
  harness.dispose()
}

// ---------------------------------------------------------------------------
// 8. Notification denial is handled without throwing.
// ---------------------------------------------------------------------------
{
  setPage({ visible: false })
  const denied = installNotification('denied')
  const harness = createHarness()
  harness.row(createSession('f'))
  moduleExports.apply(harness.ctx)
  assert.doesNotThrow(() => {
    harness.row(createSession('f', { running: false }))
  })
  assert.equal(denied.length, 0, 'denied notifications are skipped')
  harness.dispose()
}

installNotification('granted')
console.log('dsh-notify smoke: all scenarios passed')
