# 书童 Pagekin 开发指南

本文件面向首次接触仓库的 AI 编码 Agent。项目 README、开发文档和多数代码注释使用中文；用户界面及用户文档同时维护中文和英文。

## 项目概览

书童 Pagekin（原名 AI Novel Writer，包名 `ai-novel-writer`）是一个本地优先的长篇小说写作桌面应用。它把设定、故事架构、章节蓝图、正文草稿、AI 审稿、修稿合并和定稿串成可持续的写作流程，也支持参考小说拆解、原稿续写、知识库、版本历史、项目备份和 WebDAV 云备份。

应用不捆绑模型或模型额度。用户在本地配置 OpenAI Chat Completions 兼容服务、Gemini 原生协议或 Ollama；只有用户发起生成时，相关提示词和作品上下文才会发往所选服务。桌面应用采用 GPL-3.0 许可证。

仓库还包含 `plugins/dsh-ai-novel-writer`：独立发布、冻结维护的 DeepSeek Harness Web 插件，使用 React 18、MIT 许可证和另一套依赖、构建及发布流程。它不读取桌面项目，也不定义桌面应用行为。修改或验收插件前必须阅读该目录自己的 `AGENTS.md` 和 `docs/v2-development-gates.md`。

## 文档与需求来源

- 当前源码和测试决定实际行为。稳定产品术语与数据边界见 `docs/product-domain.md`，补充领域语言见根目录 `GLOSSARY.md`；难以逆转的设计决定见 `docs/adr/`，较新的已接受 ADR 可以取代旧决定。
- `docs/README.md` 是文档导航。V3 写作流程、模型兼容或大规模界面任务还需阅读其中的现行规格索引及适用修订；冻结计划里的任务状态不等于当前进度。
- 界面任务阅读 `docs/design/2026-10-11-frontend-redesign/ia.md` 和同目录 `design-system.md`，分别核对信息架构与组件规则。
- 用户可见行为变化应同步更新中文 `README.md` 和英文 `README_en.md`，保持范围一致。`README_zh.md` 只是指向 `README.md` 的兼容链接，不维护第二份中文正文。
- 根目录 `AGENTS.md` 是入库的公共开发指南；`CONTEXT.md` 是被 Git 忽略的本机上下文。两者都不能覆盖产品领域词汇或已接受 ADR。
- 贡献流程以 Issue 为先，一个 PR 解决一个问题。提交说明应包含实际运行的检查、人工验证和未运行项，详见 `CONTRIBUTING.md`。

## 技术栈与运行时架构

- 工具链：Node.js 22.14 或更高版本，pnpm 11.11.0，TypeScript 6，Vite 8，ESM 源码。CI 当前使用 Node.js 22.23.1；依赖以 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 为准。
- 桌面层：Electron 44。`electron/main.ts` 是主进程入口，`electron/preload.ts` 通过 `contextBridge` 暴露 `window.aiNovelAPI`，渲染进程没有 Node.js 集成且启用了上下文隔离。
- 渲染层：React 19、Zustand、Tailwind CSS 4、Radix UI、CodeMirror 6 和 Lucide 图标。`src/main.tsx` 安装生成传输并挂载启动门 `RendererStartup`；`src/App.tsx` 挂载唯一的纸墨阶段式外壳及全局对话框。
- 通信：渲染进程经 `src/services/ipc-client.ts` 调用主进程。通道、参数、返回值和事件类型集中在 `src/shared/ipc-channels.ts`；主进程由 `electron/ipc-handlers.ts` 注册各控制器。
- 数据：每部作品有独立项目目录和 SQLite 数据库，使用 `better-sqlite3`、外键、WAL、版本化迁移和项目会话租约。知识库使用 LanceDB 与 Apache Arrow；无检索模型时可做全文检索，配置嵌入模型后可做全文与向量混合检索。
- 模型：主进程 `electron/llm/` 实现 OpenAI 兼容和 Gemini 提供商、流式输出、参数策略及诊断。渲染层工作流负责组织上下文、运行状态和用户确认，不把整本作品聊天历史直接交给模型。
- 构建：Vite 输出渲染资源到 `dist/`，主进程和 preload 到 `dist-electron/`。主进程构建为 CommonJS 以加载原生模块；`better-sqlite3`、`@lancedb/lancedb` 和 `yauzl` 保持外部依赖。

开发时 `pnpm dev` 先通过 `predev` 准备 macOS 安全文件助手，再启动绑定 `127.0.0.1:5180` 的 Vite 服务及 Electron。生产模式由主进程加载 `dist/index.html`。启动顺序包含全局数据目录解析、旧配置迁移、单实例锁和启动就绪门，业务 IPC 在全局数据就绪后注册。

## 关键配置文件

- `package.json`：包元数据、Node 与 pnpm 版本、桌面依赖及全部常用脚本；`main` 指向 `dist-electron/main.js`，版本号由 Vite 注入渲染层。
- `pnpm-lock.yaml`、`pnpm-workspace.yaml`：锁定依赖，并定义原生依赖构建许可和 pnpm overrides。修改 overrides 或原生依赖会影响 Electron ABI 和发布资格。
- `tsconfig.json`、`tsconfig.node.json`：严格 TypeScript 配置；主配置覆盖 `src/` 与 `electron/`，排除 `src/stories/`。
- `vite.config.ts`：React、Tailwind、Electron 主进程与 preload 构建，开发服务器、资源路径和默认 Vitest 配置。默认测试配置在此文件中，仓库没有独立的 `vitest.config.ts`。
- `vitest.browser.config.ts`：真实 Chromium 浏览器测试。`vitest.settings-browser.config.ts` 是保留的少量设置场景配置，不是 `test:browser` 使用的配置。
- `.eslintrc.cjs`：TypeScript、React Hooks、React Refresh 和 Storybook 规则；`scripts/check-color-literals.mjs` 与 `scripts/check-i18n-coverage.mjs` 补充项目专属检查。
- `electron-builder.json5`：安装包内容、原生模块解包、各平台目标、资产命名和更新源。
- `.release/release-profile.json`：正式发布的平台、精确资产、验收回执、保留期和签名政策；`.github/workflows/` 包含 PR CI、插件 CI、三平台资格验证及发布提升流程。

## 代码组织与模块职责

- `src/components/stage/`：当前唯一主界面，按设定、架构、蓝图、正文四个创作阶段组织。书房、角色、知识库、剧情、版本历史、设置和运行侧页也在此目录。
- `src/components/editor/`、`dialogs/`、`settings/`、`run/`、`ui/`：编辑器、全局对话框、设置、运行呈现和共享组件原语。复杂页面按需加载。
- `src/stores/`：Zustand 客户端状态，包括项目、工作流、模型、编辑器、主题、布局和导航。`navigation/` 负责阶段进度、标签页和导航意图。
- `src/services/`：渲染进程应用服务。`workflows/` 编排创作流程，`generation/` 管理生成传输，`prompts/` 与提示词相关模块组织模型输入，`ipc-client.ts` 是桌面入口的唯一客户端封装。
- `src/shared/`：主进程与渲染进程共享的类型和纯领域逻辑，包括 IPC 合同、项目会话、生成运行、来源引用、审稿周期、定稿、角色身份、写作语言和写作 Skill。
- `src/i18n/`：中英文目录、翻译函数、复数与错误文案。`src/styles/paper-ink/`：全局字体、组件原语和颜色令牌。
- `electron/controllers/`：IPC 用例入口，按项目、生成、数据库、知识库、导入、定稿、更新等职责拆分。
- `electron/services/`：主进程应用服务，包括项目访问、生成、归档恢复、WebDAV、全局数据迁移、更新、文件授权和发布烟测。
- `electron/repositories/`：SQLite 持久化；`electron/migrations/`：baseline、迁移注册表与执行器。schema 变更须进入版本化迁移体系并覆盖升级路径。
- `electron/database.ts`：当前项目数据库生命周期；`electron/knowledge-base.ts` 与 `electron/vector-store.ts`：知识语料、检索和版本化嵌入空间。
- `electron/llm/`：提供商实现和模型传输策略；`electron/mcp/`：保留的 MCP 接线；`electron/security/`：macOS 原生安全文件助手和 Windows PowerShell 对应实现。
- `scripts/`：Node.js、PowerShell 和 shell 形式的检查、Electron 旅程、真实环境验收、打包与发布工具。`test/` 提供 Vitest 全局设置、fixture 和源码合同测试。
- `.github/workflows/`、`.release/`：PR CI、三个桌面目标的资格验证、统一发布配置与发布脚本。`public/`、`build/` 保存静态资源和应用图标。

## 常用命令

安装和开发：

```sh
pnpm install --frozen-lockfile
pnpm dev
```

桌面应用检查：

```sh
pnpm run typecheck       # TypeScript strict/noEmit，覆盖 src 与 electron
pnpm run lint            # ESLint 零警告，并检查颜色字面量
pnpm run check:i18n      # 中英文可见文案、错误边界与复数规则
pnpm test                # 默认 Vitest 套件
pnpm run test:browser    # Playwright Chromium 中的 *.browser.tsx
pnpm run build           # tsc 后执行 Vite 构建，不生成安装包
```

定向运行 Node 测试可使用 `pnpm exec vitest run <测试文件路径>`。首次运行浏览器测试前安装浏览器：`pnpm exec playwright install chromium`。可用 `AI_NOVEL_VITEST_CHROMIUM` 指定 Chromium，用 `AI_NOVEL_VITEST_LOCALE=en-US` 复现英文运行器；默认浏览器语言固定为 `zh-CN`。

其他入口：

```sh
pnpm run storybook
pnpm run build-storybook
pnpm run clean:build
pnpm run verify:drive -- --scenario <场景名>
```

`verify:drive` 是带隔离数据目录的真实 Electron 场景驱动，场景清单和参数见 `scripts/redesign/drive.mjs`，输出默认写入被忽略的 `.runtime/`。它不是单个组件测试的替代品。

## 开发约定

### 代码与依赖

- 使用严格 TypeScript 和现有文件的模块、命名、缩进及分号风格。仓库以 ESLint 为强制检查，没有独立 Prettier 配置；`noUnusedLocals`、`noUnusedParameters` 和 fallthrough 检查均开启。
- 优先扩展现有控制器、服务、repository、store 和共享合同，不在组件里绕过应用边界直接访问数据库、文件系统或模型传输。
- 保持 PR 单一，避免无关格式化、生成文件和依赖变更。原生依赖及 pnpm override 会影响 Electron ABI、安装包和发布资格，修改时必须验证真实打包运行时。

### IPC、会话与数据事实

- 新增 IPC 时同步更新 `src/shared/ipc-channels.ts`、主进程控制器注册和渲染端 `ipc` 调用。preload 只暴露受控桌面 API，不向渲染进程开放原始 `ipcRenderer` 或 Node 能力。
- 项目级请求必须携带主进程签发的 `ProjectSessionContext`（项目 ID、租约 ID、规范根目录）。长时间工作流在启动时冻结会话并使用 `invokeWithProjectSession`；裸路径不构成访问权限，重新打开项目会使旧租约失效。
- 外部导入、导出和目录选择使用主进程发放的短期、限定操作和范围的文件授权。应用配置、项目内部文件及外部 URL 也由主进程控制。
- 区分作者事实和派生投影。模型推断、摘要、角色状态或剧情树不能静默覆盖作者确认的事实；审稿意见需经作者选择后进入修稿，修稿通过差异确认合并。
- SQLite 中的不可变定稿快照是定稿事实源，项目目录中的章节文本是可重试的原子发布投影。恢复候选不是正式草稿，来源变化后不能继续生成。
- 嵌入向量按模型指纹、维度、距离语义和代际隔离。模型或维度变化需要重建并验证新空间后原子切换，不能混写向量或破坏可用全文检索。
- 界面语言与项目写作语言相互独立。写作 Skill 只是按阶段冻结的提示词补充，不能覆盖作者事实、语言、结构化输出或工具协议，也不能安装执行脚本。

### 界面与文案

- 当前只有纸墨界面、浅色和深色主题。主入口保持设定、架构、蓝图、正文四阶段；运行、审稿、版本和资料使用既定侧页或浮层，避免增加重复入口。
- 在 `src/components` 与 `src/styles/paper-ink` 的非测试实现中，只有 `src/styles/paper-ink/tokens.css` 可以直接写十六进制、rgb、hsl 颜色值。组件使用令牌和共享 UI 原语，不新增平行设计系统。
- 样式选择器不得依赖元素位置、Tailwind 工具类组合或本地化文本。交互需覆盖键盘焦点、危险操作确认、空状态和减少动态效果偏好。
- 所有用户可见文案提供中英文。局部文案使用现有 `text`/`localize` 机制，共享文案进入 `src/i18n/messages/`；主进程错误在显示前映射为当前界面语言，不能向用户直接展示裸错误码。
- 仅内部日志、协议标识等不进入用户界面的字符串可用 `// i18n-exempt: <具体原因>` 豁免。数量后的英文名词和动词按 `pluralEn` 处理。
- 创作界面沿用产品术语，避免向作者暴露 LanceDB、FTS、MCP 等实现词汇。详细视觉和交互验收以纸墨设计文档为准。

## 测试策略与 CI

- 默认 `vitest run` 使用 Node 环境，测试主要与源码共置于 `__tests__/`，也包括 `test/` 下的设置和合同测试。全局设置固定语言环境并统一 Buffer 比较；默认套件排除 `plugins/`、历史 worktree、运行时输出和冻结计划脚本。
- 先运行覆盖改动的定向测试，再按影响范围运行完整 `pnpm test`、`typecheck`、`lint`、`check:i18n` 和 `build`。数据库、导入恢复、生成和发布改动应覆盖真实入口、失败路径及升级路径，不能只测纯 fixture 或编译成功。
- 浏览器测试只收集 `src/**/*.browser.tsx`，使用真实 Chromium DOM，文件串行执行。涉及真实 DOM、焦点、键盘或样式行为的改动应运行该套件。
- Electron 旅程、安装、升级、DMG 和原生权限验证使用 `scripts/` 中的真实环境驱动。模型 mock 证明编排行为，不证明真实模型兼容性或文学质量；真实提供商资格有独立脚本和证据要求。
- PR CI 在 Windows 2022 上将默认测试分成四片，并在首片执行类型检查、lint、i18n、浏览器测试和构建。CI 不向不受信 PR 提供仓库写权限或模型凭据。
- 插件修改在其目录单独执行 `pnpm install --frozen-lockfile`、`pnpm run typecheck`、`pnpm run build` 和 `pnpm exec vitest run`；插件 CI 还检查 npm tarball 内容。根目录测试和 lint 不覆盖插件。

## 打包与发布

常用本地打包入口：

```sh
pnpm run build:win-dir
pnpm run build:win:artifacts
pnpm run build:mac:arm64:artifacts
pnpm run build:mac:x64:artifacts
pnpm run smoke:win-app
pnpm run smoke:win-installer
pnpm run smoke:mac-dmg
```

Windows 的 `pnpm run build:win` 实际执行完整 `release:win:verify` 资格门禁，不只是编译。`build:win:artifacts` 要求已有发布门禁证据；macOS 打包会用 `clang` 编译 `electron/security/darwin-safe-file-system.m`。Windows 烟测需要 PowerShell，macOS DMG 烟测需要对应平台和架构。

`electron-builder.json5` 将安装包写入 `release/<version>/`，并解包原生模块；`npmRebuild` 为 false。正式发布目标只有 Windows x64 NSIS、macOS ARM64 DMG 和 macOS x64 DMG，精确资产及验收回执由 `.release/release-profile.json` 定义。虽保留 Linux electron-builder 配置，但它不属于当前正式发布合同。

正式安装包由 GitHub Actions 手动触发构建和资格验证。三个平台必须基于同一不可变源码 SHA 分别通过测试、打包、安装或挂载烟测及签名检查，再由 `cross-platform-runtime-artifact-promotion.yml` 校验并发布同一字节的资产；发布流程不重新构建。Windows 应用内更新经用户确认后下载，macOS 只提醒并打开官方 Release 页面。

`dist/`、`dist-electron/`、`release/`、`.runtime/`、`.vitest-attachments/`、日志和浏览器失败截图均是可再生的本地输出，不应提交。

## 安全与隐私

- 不把 API Key、Token、完整小说正文、未公开资料、私人路径、完整项目数据库或整包日志提交到仓库、Issue 或 PR。复现材料使用虚构内容、最小片段和必要日志。
- 保持 `nodeIntegration: false`、`contextIsolation: true` 和主进程文件权限边界。新窗口与导航只能走现有官方 URL 白名单，不能让渲染内容导航到任意外部页面。
- 模型配置和 API Key 保存在本机应用数据目录。避免把密钥写进提示词日志、测试快照、嵌入空间身份或发布证据；云端生成会把所选上下文发送给用户配置的服务商。
- 导入和恢复必须保留原数据并生成受控副本；删除、迁移和定稿操作需要遵守现有事务、租约、确认和恢复边界。
- 写作 Skill 只支持经用户审阅的自包含提示词内容，不执行脚本、hook、子代理或工具要求。
- 当前 Windows 安装包未签名，macOS 安装包为 ad-hoc 签名且未公证；发布资产必须保留对应披露和签名验收，不能把本地成功打包描述为已完成正式发布资格。

## Agent 协作入口

### Issue tracker

Issue 和规格由 `shengchen1998/AI-Novel-Writer` 的 GitHub Issues 管理，通过 `gh` CLI 操作。具体命令、目标仓库核对和发布边界见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human` 和 `wontfix` 五个默认状态标签；已完成 triage 的 Issue 还应有 `bug` 或 `enhancement` 类别标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context 布局：公共产品术语见 `docs/product-domain.md`，补充词汇见根目录 `GLOSSARY.md`，ADR 位于 `docs/adr/`。新术语和架构决定的记录规则见 `docs/agents/domain.md`。
