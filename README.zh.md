# dsh-notify

[English](README.md) · 简体中文

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-6C4CF1)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

> 一个 DSH 插件：会话在 DeepSeek Harness 不是前台应用时跑完，就弹一条系统原生通知——点一下横幅直接回到那个会话。

DSH 里的一次任务往往要跑好几分钟。切到别的 App 之后，你不应该反复回来检查窗口：**dsh-notify** 盯着会话列表，对每一个 `running: true → false` 的边沿判断「这个会话你是不是已经在看」。如果没在看，它通过浏览器 `Notification` API 发一条通知，DSH 桌面壳再把它落成真正的 macOS 通知中心 / Windows 操作中心 / Linux 桌面通知，带 DeepSeek Harness 的应用图标和系统提示音。

它不占用任何 UI slot，没有设置项，不往网络发数据，也不需要 Host 服务。

## 功能

### 什么时候会弹通知

| 场景 | 是否通知 |
| --- | --- |
| 任务在后台跑完（别的 App 在前台 / 窗口最小化 / 页面不可见） | ✅ 弹系统通知 |
| 任务跑完时你正看着这个会话（窗口在前台 **且** `retainedBy.mainView > 0`） | ❌ 不打扰，你看得到 |
| DSH 在前台，但跑完的是**另一个**会话 | ✅ 通知——微信式语义：别的会话完成也提醒 |
| 子代理 / Agent Teams 的 teammate 跑完 | ❌ 不通知，由 Lead 会话代表完成 |
| 页面加载时任务已经在跑 | ✅ 通知，但不带「用时」 |
| 页面加载之后才开始的任务 | ✅ 通知，正文带「用时」，例如 `任务完成 · 用时 3 分 5 秒 · 点击打开会话` |

「你正在看哪个会话」不是猜的：主视图会持有它正在展示的会话引用，会话列表行上的 `retainedBy.mainView > 0` 就是宿主自己判断「当前会话」用的同一个字段。同时窗口必须在前台：`document.visibilityState === 'visible'` **且** `document.hasFocus()`。

### 其他特性

- **点击直达。** 关闭横幅 → 聚焦 DSH 窗口 → 打开通知所指的会话（通过 Client 的 `uiWorkspace` 服务）。
- **不会堆叠。** 每个会话使用稳定的通知 `tag`（`dsh-notify:<session-id>`），同一会话再次完成会**替换**上一条横幅，而不是叠一条新的。
- **标题可读。** 依次尝试会话标题、显示标题、工作区目录名，最后退化为「DSH 会话」；连续空白会折叠，过长的标题会截断。
- **文案本地化。** 通知标题/正文跟随 DSH locale，内置简体中文和英文两套词典；其他语言回退英文。
- **零足迹。** 没有 Host 服务、不占 UI slot、无依赖、无网络请求、Host 侧不写任何状态。
- **可诊断。** 一个 localStorage key 记录 watcher 看到了什么、以及某次为什么（没）弹——见[疑难排查](#faq--疑难排查)。

## 安装

> 前置条件：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）带 Web UI，运行机器上 Node.js >= 20。

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile <profile> add github:ChenYichener/dsh-notify
```

### 从本地 clone 安装

```bash
git clone https://github.com/ChenYichener/dsh-notify.git
dsh plugin --profile <profile> add /path/to/dsh-notify
```

### DSH 桌面端

在 App 的**插件管理**页从本地目录安装。本插件是普通的 profile bundle，`dsh` 重启和升级后都还在。

安装完重启 `dsh web`（或刷新 DSH 窗口）。没有任何要配置的东西——watcher 会自动开始工作。

### 环境要求

| 要求 | 取值 |
| --- | --- |
| DSH | 在 `0.2.2-rc.1` 上验证；需要 Web UI 及其 Client 插件 API |
| Node.js | `>= 20` |
| 运行时依赖 | 无 |
| 系统通知 | 由 Electron 壳投递；需要在系统设置里允许 DeepSeek Harness 发通知 |

默认 profile 通常是 `web`（也就是 `dsh web` 用的那个）。不确定就跑 `dsh plugin --profile web list`。

## 使用

插件全自动工作：

1. 在某个会话里开始任务，然后切到别的 App（或最小化 DSH）。
2. 会话结束时，系统弹出以会话名作标题的通知，正文类似 `任务完成 · 点击打开会话`。
3. 点击通知，DSH 前置并打开跑完的那个会话。

| 操作 | 结果 |
| --- | --- |
| 后台任务完成 | 带应用图标和系统提示音的系统通知 |
| DSH 在前台时另一个会话完成 | 通知，和聊天 App 提醒别的会话一样 |
| 当前屏幕上的会话完成 | 静默，不打断 |
| 点击通知 | 关闭横幅、聚焦窗口、打开该会话 |
| 同一会话第二次完成 | 替换旧横幅（同一个 `tag`） |

macOS 第一次弹出 DeepSeek Harness 的通知时会询问是否允许，选**允许**。Windows 和 Linux 在系统设置里管理同一个按 App 的通知权限。

## 实现说明

- **Host 半边**（`index.js`）是刻意留空的。它的存在只是让 bundle patch 能挂上插件行并发布 Client 模块；全部行为都在浏览器端。
- **Client 半边**（`client.js`）注册一个 Cordis 插件，注入 `sessions` 与 `locale` 服务。
- 它订阅 `ctx.sessions.list`——Client 的、以 Host 为准的会话列表。行上带 `running`，所以 watcher 可以维护「观察到正在跑」的会话集合，并对每个 `true → false` 边沿做出反应。
- **预热（priming）：** 实时列表初始是 `phase: 'pending'` 且没有行。watcher 等第一个 `ready` 快照才建立基线；此时已经在跑的会话记为*未知开始时间*，避免拿页面加载时刻算出错误的「用时」。
- **抑制判断**在每个完成边沿做一次：
  - `parentId !== undefined` 或 `origin === 'subagent'` → 子代理/teammate，静默；
  - `pageInFront() && retainedBy.mainView > 0` → 你正看着它，静默；
  - 其余 → 通知。
- **投递：** 在 `dsh-app://app` 页面里 `new Notification(title, { body, tag })`。Electron 把浏览器通知交给系统，于是横幅出现在通知中心 / 操作中心 / 桌面通知守护进程里。
- **点击处理：** `notification.onclick` 关闭横幅、尽力 `window.focus()`，并让 `uiWorkspace` 服务打开该会话。
- **本地化：** 两套词典都注册在 `dsh-notify` 命名空间下；locale 服务还没就绪时直接用内置表兜底。
- **追踪：** 每一步都会往 `localStorage['dsh-notify:trace']` 写一个 JSON 对象——`loaded`、带 `subagent` / `foreground` / `watching` 标记的 `edge` 记录，或者 `notified`。

## 数据与隐私

- **不联网。** 插件从不调用 `fetch`、WebSocket 或任何 Host 路由，没有遥测。
- **不写 Host 状态。** Host 半边不声明服务，也不落任何数据。
- **只有一处本地写入。** `localStorage['dsh-notify:trace']` 保存一个不断被覆盖的诊断对象（见下），只存在于当前浏览器 profile，随时可删。
- **通知内容不离开本机。** 标题是会话标题（或工作区目录名），正文是固定的本地化文案加上观察到的用时。
- **不发布到任何地方。** 卸载插件只会留下那个 localStorage key，清掉无副作用。

想确认插件是否真的在跑、以及某次完成为什么没弹，最快的办法是读这条诊断面包屑：

```js
localStorage['dsh-notify:trace']
// {"event":"loaded","at":1730000000000}                  Client 模块已在本页执行
// {"event":"edge","sessionId":"…","subagent":false,
//  "foreground":true,"watching":true,"at":…}             观察到一次完成边沿，且被抑制
// {"event":"notified","sessionId":"…","at":…}           已创建系统通知
```

## 配置

插件本身没有设置项。可调的只有系统层：

| 开关 | 位置 |
| --- | --- |
| 是否允许 DeepSeek Harness 发通知 | macOS：系统设置 → 通知；Windows：设置 → 系统 → 通知；Linux：桌面通知设置 |
| 提示音 / 勿扰模式 | 同上，系统的通知设置 |

## 开发

```bash
node --check index.js
node --check client.js
node --check scripts/smoke-notify.mjs
node scripts/smoke-notify.mjs
```

`scripts/smoke-notify.mjs` 用假的 Cordis 服务和假的 `Notification` 驱动**真实的** `client.js`，不需要窗口，完全确定性。覆盖八个场景：

1. 真实启动顺序（`pending → ready`）：预先在跑的任务静默建立基线，结束后照常通知；
2. 后台完成恰好弹一条通知，标题是会话名、带可替换的 `tag`；点击会打开会话、聚焦页面并关闭横幅；
3. 前台：正在看的会话静默，另一个会话仍然提醒；
4. 子代理 / teammate 行静默；
5. 从开始就被观察到的任务，正文带格式化用时；
6. 切换 locale 后英文词典生效；
7. 消失的行被静默遗忘，同一 id 稍后复用会重新通知；
8. 通知权限被拒绝时不抛错。

通过时输出：

```text
dsh-notify smoke: all scenarios passed
```

## 项目结构

```text
dsh-notify/
├── README.md                 # 英文（默认）
├── README.zh.md              # 简体中文
├── LICENSE                   # MIT
├── .gitignore
├── package.json              # bundle patch + dsh.client 声明
├── cordis.patch.yml          # 插入 dsh-notify 插件行
├── index.js                  # Host 半边：空实现
├── client.js                 # Client 半边：完成边沿 → 系统通知
├── locale/                   # 插件管理页展示的标题与描述（en, zh）
│   ├── en.json
│   └── zh.json
├── icon.svg                  # 插件图标
└── scripts/
    └── smoke-notify.mjs      # 无窗口的确定性冒烟测试
```

## FAQ / 疑难排查

| 症状 | 处理 |
| --- | --- |
| 完全不弹横幅 | 检查系统设置是否允许 DeepSeek Harness 发通知。macOS 第一次会询问权限；如果曾拒绝过，需要到「系统设置 → 通知」重新打开。 |
| `Notification.permission` 是 `granted` 但什么都没出现 | 系统仍可能在展示时拒绝（按 App 的通知设置）。插件只能通过 `notification.onerror` 收到失败并在 console 留一条警告；去改系统设置。 |
| DSH 在前台也弹通知 | 除非弹的是当前屏幕上的会话，否则这是预期行为。只有 `retainedBy.mainView > 0` 的会话会被静默，别的会话完成照样提醒。 |
| 通知里没有「用时」 | 任务在页面加载时就已经在跑（或页面中途刷新过）。只有 watcher 从开始就观察到的任务才有用时。 |
| 退出 DSH App 后什么也不弹 | 没有渲染进程可以发通知了。插件只覆盖「页面还活着」期间完成的任务。 |
| 点击通知没反应 | 会话可能在点击前已被归档；窗口聚焦是尽力而为，通常系统点击通知就会激活 DSH。 |
| 插件到底有没有在跑？ | 在 DSH 页面打开 DevTools 读 `localStorage['dsh-notify:trace']`：`loaded` 表示 Client 模块执行过，`edge` 解释某次为什么被抑制。 |
| 通知文案语言不对 | 只内置 `zh` 和 `en` 两套词典，其他 locale 回退英文。把 DSH 语言切到这两种之一。 |

## 兼容性

- **平台：** 通过 DSH 桌面端支持 macOS、Windows、Linux。用普通浏览器打开 `dsh web` 时，则受浏览器通知权限和标签页存活状态约束。
- **页面存活：** 页面必须还活着。关掉窗口导致 App 退出后，就没有进程能发通知。
- **DSH 插件 API：** Client 侧读取 `ctx.sessions.list` 快照和每行的 `retainedBy.mainView`。这些结构当前是 DSH Web UI 的稳定结构，但属于内部 API：未来 DSH 版本若改名，需要更新插件。
- **无依赖：** 插件只有纯 ES module 和浏览器 API，没有构建步骤。

## 相关 DSH 插件

| 插件 | 用途 |
| --- | --- |
| [dsh-book](https://github.com/ChenYichener/dsh-book) | Markdown 草稿库 + 面向小红书 / 公众号 / 通用文案的 AI 写作工作台 |
| [dsh-notify](https://github.com/ChenYichener/dsh-notify) | 会话在后台跑完时弹系统原生通知 |
| [dsh-pomodoro](https://github.com/ChenYichener/dsh-pomodoro) | 侧栏里的沉浸式番茄钟 |
| [dsh-translate](https://github.com/ChenYichener/dsh-translate) | 中英翻译工作台，带常驻 AI 助教和神经朗读 |
| [dsh-nce](https://github.com/ChenYichener/dsh-nce) | 新概念英语第一册学习面板（课文、间隔重复闪卡、错题本） |

## 许可证

[MIT](LICENSE) © 2026 chenyichen
