		// ====================================================================
		// 样式：全部走 --dsw-* token，无任何颜色字面量
		// ====================================================================

		const CSS_TEXT = `
.pa_root{max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);font-family:var(--dsw-font-family)}
.pa_h2{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
.pa_intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.pa_card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill);padding:14px;display:flex;flex-direction:column;gap:10px}
.pa_card[data-inactive=true]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.pa_cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pa_cardTitle{margin:0;font:var(--dsw-font-s-strong-14);font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pa_cardHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pa_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pa_spacer{flex:1 1 auto}
.pa_seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.pa_segBtn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:7px 14px;cursor:pointer}
.pa_segBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pa_segBtn[data-active=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.pa_segBtn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pa_effective{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.pa_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:inline-block}
.pa_badge{display:inline-flex;align-items:center;gap:4px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);padding:2px 7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.pa_badge[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-secondary)}
.pa_badge[data-tone=warn]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-secondary)}
.pa_badge[data-tone=error]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.pa_badge[data-tone=business]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-tertiary)}
.pa_meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pa_btn{appearance:none;font:inherit;font-size:13px;line-height:20px;padding:6px 12px;border-radius:var(--dsw-radius-md);cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary)}
.pa_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pa_btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pa_btn[data-variant=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.pa_btn[data-variant=primary]:hover{background:var(--dsw-alias-button-primary-hover)}
.pa_select{appearance:auto;font:inherit;font-size:13px;line-height:20px;padding:5px 8px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.pa_select:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pa_tierRow{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pa_btn[disabled]{opacity:.55;cursor:not-allowed}
.pa_group{display:flex;flex-direction:column;gap:6px}
.pa_groupTitle{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.pa_groupBar{width:3px;height:14px;border-radius:var(--dsw-radius-xs);display:inline-block}
.pa_groupBar[data-tone=toneA]{background:var(--dsw-alias-state-business-primary)}
.pa_groupBar[data-tone=toneB]{background:var(--dsw-alias-state-warn-primary)}
.pa_groupBar[data-tone=toneC]{background:var(--dsw-alias-state-success-primary)}
.pa_groupBar[data-tone=toneD]{background:var(--dsw-alias-label-tertiary)}
.pa_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pa_entry{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.pa_claim{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
/* 每条条目旁的处置按钮（置顶 / 封印 / 删除）与折叠区里的（恢复 / 取消置顶）。 */
.pa_entryActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pa_entryActions .pa_spacer{flex:1 1 auto}
/* 危险动作（封印 / 删除）走"危险/错误"语义的 token：白天黑夜两套主题都跟着变。 */
.pa_btn[data-variant=danger]{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.pa_btn[data-variant=danger]:hover{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-label-primary-foreground)}
.pa_btn[data-variant=danger]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-error-primary));outline-offset:2px}
/* 已处置条目的标记徽标（复用 pa_badge 的取值，只是更小一号）。 */
.pa_markTag{font-size:10px;line-height:14px;padding:1px 6px}
.pa_evidenceRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pa_textarea{width:100%;box-sizing:border-box;min-height:180px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-base-16);font-family:var(--dsw-font-family);padding:10px;line-height:1.55}
.pa_textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-color:var(--dsw-alias-state-business-primary)}
.pa_textarea::placeholder{color:var(--dsw-alias-markdown-placeholder)}
.pa_notice{border-radius:var(--dsw-radius-md);padding:9px 11px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:6px}
.pa_notice[data-tone=warn]{border-color:var(--dsw-alias-state-warn-secondary);color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-bg-layer-2)}
.pa_notice[data-tone=error]{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.pa_noticeTitle{margin:0;font-weight:600;color:inherit}
/* 实际注入的系统提示：模式 1 卡片里最显眼的一块（颜色一律走 --dsw-*） */
.pa_inject{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
.pa_injectHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pa_injectLabel{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pa_injectText{margin:0;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-markdown-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-sm);padding:8px}
.pa_link{color:var(--dsw-alias-link);text-decoration:none;font-size:13px}
.pa_link:hover{text-decoration:underline}
.pa_link:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.pa_details{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px}
.pa_details>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);list-style:none}
.pa_details>summary::-webkit-details-marker{display:none}
.pa_details>summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-xs)}
.pa_pre{margin:6px 0 0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-markdown-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-sm);padding:8px}
.pa_signals{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.pa_signal{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.pa_signalValue{font:var(--dsw-font-m-18);font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pa_signalLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pa_sep{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}
.pa_hidden{display:none}
`;

		const CSS_TAG_ID = "dsh-whale-shall-adapt/client.css";
		if (
			typeof document !== "undefined" &&
			document.querySelector('style[data-plugin-css="' + CSS_TAG_ID + '"]') === null
		) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-whale-shall-adapt";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS_TEXT;
			document.head.appendChild(tag);
		}

		/**
		 * 把画像条目按宿主 `renderProfileText()` 的格式序列化，作为
		 * `effectiveText` 拿不到时的兜底。
		 * @param {Array<{category:string, claim:string}>} entries
		 * @returns {string}
		 */
		function serializePortrait(entries) {
			const list = (entries || []).filter(entry => entry && entry.claim);
			if (list.length === 0) return "";
			const lines = ["以下是这个用户已经确认的协作画像，请在本次会话中遵守：", ""];
			for (const category of ["A", "B", "C", "D"]) {
				const group = list.filter(entry => entry.category === category);
				if (group.length === 0) continue;
				lines.push("【" + (CATEGORY_TITLES[category] || category) + "】");
				for (const entry of group) lines.push("- " + entry.claim);
				lines.push("");
			}
			return lines.join("\n").trimEnd();
		}
		/**
		 * 解析 API 基地址。
		 *
		 * 解析顺序：
		 *   1. 宿主显式注入的 `__DSH_SHALL__.apiBase`（Web 形态的未来口子）
		 *   2. 桌面壳的 `__DSH_TRANSPORT__.streamBaseUrl`（它就是这个 Host 的
		 *      HTTP origin；页面从 file:// / dsh-app:// 加载，相对路径打不到 webServer）
		 *   3. 同源相对路径（Web 形态的默认路径）
		 *
		 * 每次调用都重新读，所以注入晚到也能生效。
		 *
		 * @returns {string}
		 */
		function resolveApiBase() {
			const injected = globalThis.__DSH_SHALL__;
			if (injected && typeof injected.apiBase === "string" && injected.apiBase) {
				return injected.apiBase.replace(/\/+$/, "");
			}
			const transport = globalThis.__DSH_TRANSPORT__;
			const streamBase =
				transport && typeof transport.streamBaseUrl === "string" ? transport.streamBaseUrl : "";
			if (streamBase) {
				try {
					const url = new URL(API_PATH, streamBase);
					// 某些宿主把 streamBaseUrl 写成 ws(s)://；fetch 只认 http(s)。
					if (url.protocol === "ws:") url.protocol = "http:";
					if (url.protocol === "wss:") url.protocol = "https:";
					return url.toString().replace(/\/+$/, "");
				} catch {
					// 解析不了就退回同源相对路径，让 refresh() 的 catch 给出可读错误。
				}
			}
			return API_PATH;
		}

		/**
		 * 一次 JSON 请求。
		 * @param {string} path 相对 API 基路径
		 * @param {object} [init] fetch init
		 * @returns {Promise<object>}
		 */
		async function requestJson(path, init) {
			const url = resolveApiBase() + path;
			const options = Object.assign({ headers: {} }, init || {});
			options.headers = Object.assign({}, options.headers || {});
			// 桌面端：宿主经 webserver/index-inject 注入的本机凭据。Web 同源形态
			// 通常没有它；有就带上（宿主两侧用同一条随机 token 比对）。
			const injected = globalThis.__DSH_SHALL__;
			// 头名必须和 lib/ui/http.js 的 AUTH_HEADER 一致：预检只放行它，名字不对浏览器直接 Failed to fetch
			if (injected && typeof injected.token === "string" && injected.token) {
				options.headers["x-shall-token"] = injected.token;
			}
			if (options.body !== undefined && options.body !== null) {
				options.headers = Object.assign(
					{ "Content-Type": "application/json" },
					options.headers,
				);
				options.body = JSON.stringify(options.body);
			}
			// AbortController：桌面壳跨源路径断掉时 fetch 可能永远不 settle，
			// 没有超时就会无限 loading（实测就是这个现象）。
			const controller =
				typeof AbortController === "function" ? new AbortController() : null;
			const timer = controller
				? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
				: null;
			try {
				const response = await fetch(
					url,
					controller ? Object.assign({}, options, { signal: controller.signal }) : options,
				);
				const text = await response.text();
				let payload = null;
				if (text) {
					try {
						payload = JSON.parse(text);
					} catch (error) {
						throw new Error("HTTP " + response.status + " 非 JSON 响应：" + text.slice(0, 120));
					}
				}
				if (!response.ok) {
					const message =
						(payload && (payload.error || payload.message)) || "HTTP " + response.status;
					throw new Error(String(message));
				}
				return payload || {};
			} catch (error) {
				if (error && error.name === "AbortError") {
					throw new Error(
						"请求宿主超时（" +
							Math.round(REQUEST_TIMEOUT_MS / 1000) +
							" 秒）：设置页读不到宿主状态",
					);
				}
				throw error;
			} finally {
				if (timer) clearTimeout(timer);
			}
		}

