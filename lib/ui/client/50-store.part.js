		// ====================================================================
		// 客户端 store
		// ====================================================================

		/**
		 * 轮询间隔（毫秒）。
		 *
		 * 可以被 `globalThis.__DSH_SHALL__.pollMs` 覆盖：
		 * 一是给自检用（把 3s 压到几十毫秒），二是宿主若有别的节奏偏好也能调。
		 * 每次开始观察时重新读，所以晚注入也生效。
		 * @returns {number}
		 */
		function resolvePollMs() {
			const injected = globalThis.__DSH_SHALL__;
			const value = injected && Number(injected.pollMs);
			if (Number.isFinite(value) && value >= 10) return value;
			return 3000;
		}

		/**
		 * 一次生成最多观察多少个 tick。
		 * 宿主 `profile.timeoutMs` 默认 300000（5 分钟），3s × 100 = 5 分钟，对齐。
		 */
		const MAX_WATCH_TICKS = 100;

		/**
		 * 建立 store。返回 getSnapshot/subscribe 对（喂给 slots 的 hooks 座位）
		 * 以及界面要用的动作。
		 *
		 * 硬约束：`getSnapshot()` 必须在两次变更之间返回**同一个引用**
		 * （uSES 契约，见 @deepseek-ai/dsh-client-ui-slots 的 HostObservable）。
		 *
		 * @param {object} ctx 客户端 cordis 上下文
		 * @returns {object}
		 */
		function createAdaptStore(ctx) {
			let snapshot = {
				phase: "loading",
				error: null,
				endpoint: "",
				preview: false,
				contract: null,
				localeRevision: 0,
				state: null,
				revision: { status: "unknown", count: 0 },
				busy: false,
				regenerating: false,
				flash: null,
			};
			const listeners = new Set();
			let pollTimer = null;
			let disposed = false;

			/**
			 * "生成进行中"的观察者。
			 *
			 * 为什么需要它：宿主的 `POST /regenerate` 立刻回 202 并在后台跑
			 * （`lib/http.js:252-270`），而 `getState()` **没有** `running` 字段
			 * （`lib/index.js:129-130` 的 `validate()` 只要求 6 个方法）。
			 * 所以只发一次请求 + 刷一次状态的话，用户点了「重新生成」以后
			 * 界面不会自己变 —— 得手动刷新页面。这里补上有限期的轮询。
			 *
			 * 完成判据：`profile.version` / `profile.generatedAt` / `lastRun.at`
			 * 任一变化。**但至少要看满 2 个 tick** —— 万一宿主在生成**开始时**
			 * 就写了 `lastRun.at`，第 1 个 tick 就会看到"变化"而提前收工。
			 * 上限 `MAX_WATCH_TICKS`，到点无论如何停止（不会无限轮询）。
			 *
			 * 如果宿主以后补上 `running` 字段，这里也会尊重它：
			 * `running === false` 且我们已经看过 `true` → 立刻收工。
			 * @type {{baseRunAt:number, baseVersion:number, baseGeneratedAt:number, ticks:number, sawRunning:boolean}|null}
			 */
			let watcher = null;

			function emit(patch) {
				snapshot = Object.assign({}, snapshot, patch);
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						/* 一个订阅者炸了不能拖垮其余订阅者 */
					}
				}
			}

			/**
			 * 修订报告由服务端按记忆 id 算（lib/adapt/revision.js），`/state` 里的 `revision`；这里只取，不自己比。
			 * @param {object|null} state
			 * @returns {object}
			 */
			function revisionOf(state) {
				const report = state && state.revision;
				return report && typeof report === "object" ? report : { status: "unknown", count: 0 };
			}

			/**
			 * 拉取宿主状态并刷新快照。
			 * @returns {Promise<void>}
			 */
			async function refresh() {
				if (disposed) return;
				const url = resolveApiBase() + "/state";
				emit({ phase: snapshot.state ? snapshot.phase : "loading", endpoint: url });
				try {
					const payload = await requestJson("/state");
					if (disposed) return;
					const revision = revisionOf(payload);
					const hostRunning = !!(payload && payload.running);

					// 判定"生成是否还在进行"
					let regenerating = snapshot.regenerating;
					if (watcher) {
						watcher.ticks += 1;
						if (hostRunning) watcher.sawRunning = true;
						const runAt = (payload && payload.lastRun && payload.lastRun.at) || 0;
						const version = (payload && payload.profile && payload.profile.version) || 0;
						const generatedAt =
							(payload && payload.profile && payload.profile.generatedAt) || 0;
						const markerChanged =
							runAt !== watcher.baseRunAt ||
							version !== watcher.baseVersion ||
							generatedAt !== watcher.baseGeneratedAt;
						const hostSaysDone = watcher.sawRunning && !hostRunning;
						const finished =
							hostSaysDone ||
							(markerChanged && watcher.ticks >= 2) ||
							watcher.ticks >= MAX_WATCH_TICKS;
						if (finished) {
							watcher = null;
							regenerating = false;
						} else {
							regenerating = true;
						}
					} else if (hostRunning) {
						regenerating = true;
					} else {
						regenerating = false;
					}

					emit({
						phase: "ready",
						error: null,
						preview: false,
						contract: typeof payload.contract === "number" ? payload.contract : null,
						state: payload,
						revision,
						regenerating,
					});
					if (watcher || hostRunning) startPolling();
					else stopPolling();
				} catch (error) {
					if (disposed) return;
					emit({
						phase: "error",
						error: (error && error.message) || String(error),
						endpoint: url,
						busy: false,
					});
					// 读不到状态时不要把观察者也留着：否则会一直空轮询一个坏端点
					watcher = null;
					emit({ regenerating: false });
					stopPolling();
				}
			}

			/** 轮询：只在有观察者、或宿主报告 `running: true` 时跑。 */
			function startPolling() {
				if (pollTimer !== null || disposed) return;
				pollTimer = setInterval(() => {
					refresh().catch(() => {});
				}, resolvePollMs());
			}

			function stopPolling() {
				if (pollTimer === null) return;
				clearInterval(pollTimer);
				pollTimer = null;
			}

			/**
			 * 切换模式。模式 2 有内容时的提醒由界面负责，这里只发请求。
			 * @param {"auto"|"custom"} mode
			 * @returns {Promise<void>}
			 */
			async function setMode(mode) {
				emit({ busy: true });
				try {
					await requestJson("/mode", { method: "POST", body: { mode } });
					await refresh();
					emit({ flash: { kind: "ok", text: "mode:" + mode } });
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 保存模式 2 的文本。
			 * @param {string} text
			 * @returns {Promise<boolean>} 是否真的写进了宿主（失败时界面要保留脏标记）
			 */
			async function saveCustom(text) {
				emit({ busy: true });
				try {
					await requestJson("/custom", { method: "PUT", body: { text: String(text || "") } });
					await refresh();
					emit({ flash: { kind: "ok", text: "saved" } });
					return true;
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
					return false;
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 给一条画像条目打处置标记 / 撤销标记。
			 *
			 * ⚠️ **一律发到宿主、改完重新拉 `/state`**（`refresh()`），绝不只改本地状态：
			 * 只改本地会出现"界面删了但注入还在" —— 而注入才是真正生效的那一半。
			 * 宿主的处理见 `lib/http.js` 的 `/entry/*` 与 `lib/index.js` 的 markEntry。
			 *
			 * @param {"pin"|"unpin"|"seal"|"unseal"|"delete"} action
			 * @param {{id?:string, claim?:string, key?:string}} payload
			 * @returns {Promise<boolean>} 是否真的在宿主上生效
			 */
			async function entryAction(action, payload) {
				emit({ busy: true });
				try {
					await requestJson("/entry/" + action, { method: "POST", body: payload || {} });
					await refresh();
					emit({ flash: { kind: "ok", text: "entry:" + action } });
					return true;
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
					return false;
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 改一类会话（QQ 群 / QQ 私聊）的默认工具权限。先读最新的覆盖项再改一项，
			 * 不覆盖控制台里设过的其它项。宿主只认 DSH 自己的登录校验（见 lib/http.js）。
			 * @param {"qq-group"|"qq-private"} kind
			 * @param {"chat"|"safe"|"full"} tier
			 * @returns {Promise<boolean>}
			 */
			async function savePrivacyTier(kind, tier) {
				emit({ busy: true });
				try {
					const current = await requestJson("/privacy");
					const overrides = (current && current.policy && current.policy.overrides) || {};
					const classes = Object.assign({}, overrides.classes || {});
					classes[kind] = Object.assign({}, classes[kind] || {}, { tier });
					await requestJson("/privacy", {
						method: "PUT",
						body: { overrides: Object.assign({}, overrides, { classes }) },
					});
					await refresh();
					emit({ flash: { kind: "ok", text: "privacy" } });
					return true;
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
					return false;
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 要一张一次性控制台登录链接（60 秒内有效、只能用一次）。
			 * @returns {Promise<string|null>}
			 */
			async function openConsole() {
				try {
					const result = await requestJson("/console/ticket", { method: "POST", body: {} });
					return result && typeof result.url === "string" ? result.url : null;
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
					return null;
				}
			}

			/**
			 * 触发一次画像重新生成。
			 *
			 * 宿主立刻回 202 并在后台跑，所以这里发完请求就开始观察
			 * （见 watcher 的注释），而不是等 POST 返回结果。
			 * @returns {Promise<void>}
			 */
			async function regenerate() {
				emit({ busy: true });
				try {
					// 先记下"生成前"的三个水位，用作完成判据
					const before = snapshot.state || {};
					const baseRunAt = (before.lastRun && before.lastRun.at) || 0;
					const baseVersion = (before.profile && before.profile.version) || 0;
					const baseGeneratedAt = (before.profile && before.profile.generatedAt) || 0;

					await requestJson("/regenerate", { method: "POST", body: {} });
					watcher = {
						baseRunAt,
						baseVersion,
						baseGeneratedAt,
						ticks: 0,
						sawRunning: false,
					};
					emit({ regenerating: true });
					await refresh();
				} catch (error) {
					watcher = null;
					emit({
						flash: { kind: "error", text: (error && error.message) || String(error) },
						regenerating: false,
					});
					stopPolling();
				} finally {
					emit({ busy: false });
				}
			}

			/**
			 * 用户复制了画像文本：告诉宿主，宿主自己存下当时的条目作为基线（lib/adapt/revision.js），
			 * 之后 `/state` 里的 `revision` 就是“复制之后改了几处”。预览数据不发给宿主。
			 *
			 * @param {string} text 复制出去的全文
			 * @returns {Promise<void>}
			 */
			async function markCopied(text) {
				if (snapshot.preview) {
					emit({ flash: { kind: "ok", text: "copied" } });
					return;
				}
				try {
					await requestJson("/copied", { method: "POST", body: { text: String(text || "") } });
					await refresh();
					emit({ flash: { kind: "ok", text: "copied" } });
				} catch (error) {
					emit({ flash: { kind: "error", text: (error && error.message) || String(error) } });
				}
			}

			/** 载入预览数据（用户显式点击才走这里）。 */
			function loadPreview() {
				const payload = buildPreviewState();
				watcher = null;
				emit({
					phase: "ready",
					error: null,
					preview: true,
					contract: payload.contract,
					state: payload,
					revision: revisionOf(payload),
					regenerating: false,
				});
				stopPolling();
			}

			/** 退出预览。 */
			function exitPreview() {
				emit({ preview: false, state: null, phase: "loading" });
				refresh().catch(() => {});
			}

			function dispose() {
				disposed = true;
				watcher = null;
				stopPolling();
				listeners.clear();
			}

			// 语言切换要触发重渲染：把 locale revision 计入快照。
			// （t 本身在调用时读当前语言，这里只负责让组件重跑一次。）
			ctx.effect(
				() => ctx.locale.subscribe(() => emit({ localeRevision: ctx.locale.getSnapshot().revision })),
				"shall: locale revision bridge",
			);

			return {
				source: {
					getSnapshot: () => snapshot,
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
				actions: {
					refresh,
					setMode,
					saveCustom,
					regenerate,
					markCopied,
					loadPreview,
					exitPreview,
					/**
					 * 三个处置动作 + 两个撤销动作（界面按钮直接调它们）。
					 * `id`/`claim` = 画像里的那一条；`key` = 标记区里只有记录、
					 * 画像里已经没有的那一条（宿主按 key 找记录）。
					 */
					pinEntry: (id, claim, key) => entryAction("pin", { id, claim, key }),
					savePrivacyTier,
					openConsole,
					unpinEntry: key => entryAction("unpin", { key }),
					sealEntry: (id, claim, key) => entryAction("seal", { id, claim, key }),
					unsealEntry: key => entryAction("unseal", { key }),
					deleteEntry: (id, claim, key) => entryAction("delete", { id, claim, key }),
					/**
					 * 界面要写 flash 时用这个（**不是**直接写 `emit(...)`：
					 * `emit` 只在这个闭包里，组件作用域里根本没有这个名字，
					 * 直接写会 ReferenceError）。
					 */
					emit,
					/** 清掉当前 flash。没有它，错误提示会永久挂在页面顶部。 */
					clearFlash: () => {
						if (snapshot.flash) emit({ flash: null });
					},
				},
				dispose,
			};
		}

