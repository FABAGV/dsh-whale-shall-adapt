/**
 * dsh-whale-shall-adapt —— 画像设置页（浏览器半边的客户端插件）。
 *
 * ============================================================================
 * 这是什么
 * ============================================================================
 * 「让 AI 更好地适配用户」的设置界面。挂在 `settings.section`（设置里的
 * 一个独立页面），而不是 `settings.general.item`（General 里的一行）——
 * 理由见 UI-IMPLEMENTATION.md 第二节。
 *
 * 两块内容：
 *   模式 1 · 自动画像   只读展示 LLM 归纳的画像（A/B/C/D 四类）+ 证据量，
 *                       提供「复制」与「重新生成」。
 *   模式 2 · 自定义     用户自己写系统提示词的多行文本框，
 *                       提供「从模式 1 填入」（点了才填，不自动覆盖）。
 *
 * 模式 1 与模式 2 **互斥**：由宿主侧 `state.mode` 单字段枚举保证，
 * 本界面只做选择器 + "切换后会以模式 1 为准"的提醒，不自己维护第二份真相。
 *
 * ============================================================================
 * 为什么这个文件长这样（拼出来的 bundle）
 * ============================================================================
 * DSH 的客户端插件 bundle 就是一个注册 factory 的脚本，格式见
 * `@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js`：
 *
 *     window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {...} });
 *
 * 宿主直接加载本文件，不跑任何构建。所以它是手写的同一格式：
 *   - 不用 JSX，改用 `react/jsx-runtime` 的 `jsx/jsxs`；
 *   - 只 `require("react")` 与 `require("react/jsx-runtime")`——这两个在
 *     外壳的静态模块基座里（PLATFORM_MODULES），因此 `dsh.client.external`
 *     留空即可；
 *   - `ctx.slots` / `ctx.locale` 一律从插件 ctx 拿，**不 import 任何
 *     @deepseek-ai/* 包**，避免依赖 `dsh.client.external` 的动态解析。
 *
 * ⚠️ 本文件由 lib/ui/client/*.part.js 按文件名顺序拼成（node tools/build-client.mjs），不要直接改它。
 *    每一段是同一个函数体里的一截，单独不是合法的 JS；改完分段要重新拼，
 *    test/client-build.mjs 会检查提交的 client.js 是不是最新。
 *
 * ============================================================================
 * 与宿主侧怎么通信（契约已实现，已验证）
 * ============================================================================
 * 宿主半边暴露了一个 cordis 服务（`lib/index.js`，`super(ctx, 'shallAdapt')`），
 * 并由 `lib/http.js` 用 `webServer.register({kind:'prefix'})` 把它暴露成
 * **一条 prefix 路由** `API_PREFIX = '/shall/api'`：
 *
 *     GET  /shall/api/state       → { contract:1, ...getState() }
 *     POST /shall/api/mode        { mode }        → 200 { ok, mode, state }
 *     PUT  /shall/api/custom      { text }        → 200 { ok, length, state }
 *     POST /shall/api/regenerate  {}              → **202** { ok, started }
 *     POST /shall/api/copied      { text }       → 200（基线条目由宿主自己存）
 *     POST /shall/api/rescan      {}              → 202（客户端目前不调用）
 *
 * 三个必须知道的实现细节（都是照着宿主的真实代码对齐的）：
 *
 *   1. `/regenerate` **立刻回 202**，生成在后台跑（`lib/http.js:252-270`）。
 *      所以不能等 POST 返回结果 —— 见 createAdaptStore 里的 watcher。
 *   2. 宿主的 `getState()` **没有 `running` 字段**（`lib/index.js` 的 `validate()`
 *      只要求 6 个方法）。于是"生成完没有"只能靠
 *      `profile.version` / `profile.generatedAt` / `lastRun.at` 的变化来判。
 *   3. “复制之后改了几处”由宿主按记忆 id 算好放在 `/state` 的 `revision` 里（lib/adapt/revision.js），
 *      界面只显示，不自己比较。
 *
 * 这一层的集成测试在 test/client-marks-render.mjs 和 test/httptest.mjs。
 *
 * ⚠️ 未确认：DSH 生成式 remote（`ctx.remote.<ns>.<method>()`）在这里的确切
 * 声明方式我没有查证，因此**没有**采用，也没有在代码里猜任何 remote API 名。
 * ============================================================================
 * 「有 N 处修订」是怎么来的
 * ============================================================================
 * 用户复制画像文本时，宿主（lib/adapt/revision.js）把当时的条目（记忆 id、分类、正文）存下来作为基线；
 * 之后每次 `/state` 都带一份现算的 `revision`：新增、删除、改写各算一处，改写（新记录 supersedes 旧记录）
 * 不算“删一条加一条”。条目 id 是稳定的记忆 id，所以不用猜“这条是不是同一条”，也没有任何文本相似度阈值。
 * 本界面只显示 `revision`；没有基线、基线是旧格式（id 不是记忆 id）时，宿主会在 `status` 里说明，界面提示再复制一次。
 *
 * ============================================================================
 * 主题与文案
 * ============================================================================
 * 颜色**全部**走 `--dsw-*` token（取自 @deepseek-ai/dsh-client-ui-theme），
 * 本文件不出现任何 hex/rgb/hsl 字面量。
 * 文案集中在 `COPY`，按 zh/en 两套；界面渲染时通过 ctx.locale 取。
 */

window.__ModuleLoader__.load({
	id: "dsh-whale-shall-adapt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

