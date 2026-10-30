			// —— 首跑 / 自动更新进度 ——
			// `trigger` 来自宿主 `getState().trigger`（阈值 + 最近一次扫描的计数）。
			// 老宿主没有这个字段时整块不渲染，界面其余部分照旧 —— 不做兼容性猜测。
			const trigger =
				serverState.trigger && typeof serverState.trigger === "object"
					? serverState.trigger
					: null;
			const profileEmpty = entries.length === 0;
			// 宿主字段缺失/类型不对时一律当 0，避免界面出现 “undefined 条”。
			const triggerNumber = (value, fallback) =>
				Number.isFinite(Number(value)) ? Number(value) : fallback;
			const triggerTargetMessages = trigger
				? triggerNumber(trigger.triggerUserMessages, 0)
				: 0;
			const triggerTargetSessions = trigger
				? triggerNumber(trigger.triggerNewSessions, 0)
				: 0;
			const triggerHumanMessages = trigger
				? triggerNumber(trigger.humanMessages, 0)
				: 0;
			const triggerSessions = trigger ? triggerNumber(trigger.sessions, 0) : 0;
			let triggerHint = null;
			if (trigger && !profileEmpty) {
				if (!isAuto) triggerHint = t("autoTriggerCustom");
				else if (trigger.autoRun === false) triggerHint = t("autoTriggerOff");
				else
					triggerHint = t("autoTriggerLine", {
						m: triggerTargetMessages,
						s: triggerTargetSessions,
						n: triggerHumanMessages,
						k: triggerSessions,
					});
			}
			const firstRunLines = [];
			if (trigger && profileEmpty) {
				if (!isAuto) {
					firstRunLines.push(t("autoFirstRunModeCustom"));
				} else if (trigger.scanned !== true) {
					firstRunLines.push(t("autoFirstRunScanning"));
				} else if (trigger.autoRun === false) {
					firstRunLines.push(t("autoFirstRunAutoOff"));
				} else {
					const need = Math.max(0, triggerTargetMessages - triggerHumanMessages);
					firstRunLines.push(
						need > 0
							? t("autoFirstRunNeed", {
									m: triggerTargetMessages,
									n: triggerHumanMessages,
									d: need,
								})
							: t("autoFirstRunEnough"),
					);
				}
				firstRunLines.push(t("autoFirstRunAfter"));
			}

			// 模式 1 面板上的「复制」与「从模式 1 填入」用的**必须是画像文本本身**。
			//
			// ⚠️ 这里有个坑：宿主的 `effectiveText` 是"当前生效文本"，
			// 模式 2 生效时它等于自定义文本。如果直接用它，「从模式 1 填入」
			// 会把文本框里的内容原样填回文本框。
			// 所以：只有模式 1 生效时 `effectiveText` 才是画像（+补充说明），
			// 否则本地按宿主的 renderProfileText 格式重建画像文本。
			const portraitText =
				isAuto && typeof serverState.effectiveText === "string" && serverState.effectiveText
					? serverState.effectiveText
					: serializePortrait(entries);

			const grouped = {};
			for (const category of CATEGORY_ORDER) grouped[category] = [];
			grouped[CATEGORY_EXTRA] = [];
			for (const entry of entries) {
				const key = CATEGORY_ORDER.indexOf(entry.category) >= 0 ? entry.category : CATEGORY_EXTRA;
				grouped[key].push(entry);
			}

			// —— 实际注入的系统提示（模式 1 卡片最显眼的一块）——
			//
			// ⚠️ 界面**只渲染**宿主的 `injectedText`，绝不自己拼一遍。
			// 宿主那个字段就是 `renderSection()` 注入时用的同一个来源
			// （`store.effectiveForInjection().text` → 记忆层的注入器），
			// 自己拼就会再次出现"看到的 ≠ 注入的"（注入按预算裁剪，界面显示完整画像）。
			//
			// 条数说明取自宿主的 `injection` 摘要（最多 4 个数字，长文本不在里面）：
			//   · m = 实际进注入的条数 = `injectedEntries`
			//   · n = 完整画像条数 = `profile.entries.length`
			// 摘要缺失或形状不对时（老的宿主、预览数据）退化为"只显示文本、不报条数"。
			const injectedText =
				typeof serverState.injectedText === "string" ? serverState.injectedText : "";
			const injection = serverState.injection;
			const injectedCount =
				injection && typeof injection.injectedEntries === "number"
					? injection.injectedEntries
					: null;
			// 兜底用注释里那行"本次注入 m/n 条"里的 m —— 摘要里的 m 来自另一个
			// 调用点，理论上可能比这段文本晚一步；宁可少报也不要报错。
			const injectedCountFromText = (() => {
				const matched = /本次注入\s*(\d+)\s*\/\s*(\d+)\s*条/.exec(injectedText);
				return matched ? Number(matched[1]) : null;
			})();
			// 两个来源都只作"报数"用；不一致时以文本里那行为准（文本才是注入现场）。
			const injectedShown =
				injectedCountFromText !== null ? injectedCountFromText : injectedCount;
			const totalShown = entries.length;

			// 注入账本（宿主 `injectionLedger`，publicLedger 形状）：按条目 id 记录
			// "进过几版"，跨版本累计。老宿主没有这个字段 → 不加任何徽标，保持原界面。
			const ledger =
				serverState.injectionLedger && typeof serverState.injectionLedger === "object"
					? serverState.injectionLedger
					: null;
			const ledgerCounts =
				ledger && ledger.counts && typeof ledger.counts === "object" ? ledger.counts : null;
			const neverInjectedShown = ledgerCounts
				? entries.filter(entry => !(Number(ledgerCounts[entry.id]) > 0)).length
				: null;
			const ledgerVersion =
				ledger && ledger.version !== null && ledger.version !== undefined
					? ledger.version
					: "—";
			// 工作笔记：项目/工具/路径类事实，独立于画像条目（不占槽位、不注入）。
			const workingNotes = Array.isArray(serverState.workingNotes)
				? serverState.workingNotes.filter(
						note => note && typeof note.text === "string" && note.text.trim(),
					)
				: [];

			// 各分类注入条数：**直接取宿主的 `injection.injectedByCategory`**
			// （形如 `{A:13,B:13,C:0,D:0}`），界面自己**不**做任何计算 ——
			// 界面自己算就会出现"看到的 ≠ 注入的"（模式 1 的注入是宿主按预算
			// 裁剪出来的，界面这边只有完整画像，算不出同一个结果）。
			// 三个数字都必须是 number 才显示；缺一个就整体退化为老的"共 m 条"。
			// D 类按设计永不注入（宿主的 `injectedByCategory.D` 恒为 0），不占位置。
			const injectedByCategory =
				injection && injection.injectedByCategory &&
				typeof injection.injectedByCategory.A === "number" &&
				typeof injection.injectedByCategory.B === "number" &&
				typeof injection.injectedByCategory.C === "number"
					? injection.injectedByCategory
					: null;

			// 分类标题沿用宿主 renderProfileText 用的中文标题（两种界面语言下都一样）：
			// 复制出去的文本必须与注入系统提示的文本一致。
			const groupLabels = CATEGORY_TITLES;

