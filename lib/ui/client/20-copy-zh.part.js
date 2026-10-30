		// ====================================================================
		// 文案（唯一语言集中点）
		// ====================================================================

		const zh = {
			nav: "AI 适配",
			title: "让 AI 更好地适配你",
			intro:
				"选一种方式告诉 AI 你希望它怎么和你协作。两种模式互斥，任何时刻只有一个生效。",

			modeLegend: "生效方式",
			modeAuto: "自动画像",
			modeAutoDesc: "由 AI 从你的历史会话里归纳，你只读。",
			modeCustom: "自定义",
			modeCustomDesc: "你自己写系统提示词。",
			effectiveNow: "当前生效：{name}",
			effectiveAuto: "自动画像",
			effectiveCustom: "自定义",
			switchWarnTitle: "切换到「自动画像」会以模式 1 为准",
			switchWarnBody:
				"模式 2 的文本会保留、不会丢，但不再注入。确定切换吗？",
			switchWarnConfirm: "仍然切换",
			switchWarnCancel: "取消",
			inactiveTag: "未生效",
			activeTag: "生效中",

			autoHeading: "模式 1 · 自动画像",
			autoUpdated: "上次更新：{time}",
			autoNever: "还没有生成过画像",
			autoSaturated: "画像已达增长上限（当前 {n} 条）",
			autoSaturatedBody:
				"新增条目会被拒绝。先删除、封印或合并一些条目，自动生成才会重新尝试。",
			autoSaturatedStreak: "已连续 {n} 轮没有变化，自动生成暂时停止。",
			autoBasedOn: "画像基于 {n} 条发言",
			autoEvidence: "基于 {n} 条发言",
			autoQuotes: "引文 {n} 处",
			autoConfidence: "置信度 {level}",
			autoVersion: "v{v}",
			autoExtraLabel: "补充说明（附加在画像之后，只读）",
			autoEmpty: "画像还没生成。攒够发言后会自动生成，也可以点「重新生成」。",
			autoEmptyHint:
				"还没有画像文本。可能是首次生成尚未完成，或上一次生成失败了——「上次生成」那张卡里有具体原因。" +
				"生成成功后画像会自动出现在这里；也可以直接切到模式 2 自己写。",
			copyEmpty: "现在没有可复制的内容：模式 1 还没有画像文本，原因见「上次生成」那张卡。",
			autoNotes: "归纳备注",
			autoRaw: "模型原始输出（排障用）",

			// —— 首跑引导与自动更新说明 ——
			// 为什么要有：空画像时界面只写“攒够发言后会自动生成”，但用户不知道
			// 要攒多少、现在攒到哪、自动生成是不是开着。这几行把判据当场说清。
			autoFirstRunTitle: "第一次使用：画像还没生成",
			autoFirstRunScanning: "正在读取本机会话记录（只读）…读完这里会显示进度。",
			autoFirstRunModeCustom: "当前是模式 2（自定义），画像不会自动生成；切回模式 1 后才会。",
			autoFirstRunAutoOff: "自动生成已关闭（profile.autoRun=false）：点右上角「重新生成」手动生成。",
			autoFirstRunNeed: "首版画像需要累计 {m} 条真人发言（已收集 {n} 条，还差 {d} 条）。",
			autoFirstRunEnough: "材料量已达标，画像会在下一轮扫描时生成；也可以点「重新生成」立即开始。",
			autoFirstRunAfter: "生成后这里会显示画像，每条都可以置顶 / 封印 / 删除。",
			autoTriggerLine: "自动更新：新增 {m} 条发言或 {s} 个新会话后（当前累计 {n} 条 / {k} 个会话）。",
			autoTriggerOff: "自动更新已关闭（profile.autoRun=false）；「重新生成」仍然可用。",
			autoTriggerCustom: "模式 2 生效时不会自动生成画像。",

			// —— 条目处置：置顶 / 封印 / 删除（每条的三个红色按钮）——
			// 语义由宿主落实（`lib/index.js` 的 markEntry/clearMark），这里只有文案。
			// ⚠️ zh / en 两套字典的 key 必须**一一对应**（test/client-marks-render.mjs 有断言）。
			pinEntry: "置顶",
			pinEntryHint: "置顶 = 界面置顶 + 一定进注入（豁免预算）。最多 {max} 条。",
			pinEntryLimit: "置顶已满 {max} 条：先取消一个再置顶。",
			unpinEntry: "取消置顶",
			sealEntry: "封印",
			sealEntryHint: "封印 = 拉进垃圾桶：不再注入，之后的更新也不会再产出它。",
			unsealEntry: "恢复",
			deleteEntry: "删除",
			deleteEntryHint:
				"删除只去掉这一版；下次总结若材料里还有依据，它可能再次出现（会记一次删除）。",
			pinnedHeading: "置顶（{n} 条）",
			pinnedHint: "你标记为重要的条目：这里置顶显示，并且一定进注入（不受预算限制）。",
			pinnedGone: "当前画像里已没有这条（模型认为材料里没有依据了）",
			deleteCountBefore: "曾删 {n} 次",
			omittedHeading: "未注入（{n} 条）",
			omittedHint:
				"完整画像里被注入预算裁掉、这次没进系统提示的条目。证据不足的 D 类在上面「证据不足」自己那个折叠里。",
			sealedHeading: "垃圾桶（{n} 条）",
			sealedHint: "被你封印的条目：不参与注入，之后的更新也不会再产出它们。封错了可以恢复。",
			deletedHeading: "已删除（{n} 条）",
			deletedHint:
				"你删过的条目。删除不禁止模型重新归纳，所以它们可能再次出现 —— 想彻底挡住请用「封印」。",
			deletedCount: "已删 {n} 次",
			deletedBack: "已再次出现在画像里",
			entryPinnedTag: "已置顶",
			entrySealedTag: "已封印",

			// —— 实际注入的系统提示（模式 1 卡片顶部，最显眼的位置）——
			// 宿主 `GET /state` 的 `injectedText` **原样**渲染，界面不重新拼。
			// 这就是"看到的 = 注入的"的落实方式：两边同一次函数调用。
			injectHeading: "实际注入的系统提示",
			injectHint:
				"以上是实际注入的系统提示（按预算裁剪，共 {m} 条）；下方是完整画像（{n} 条）。",
			injectCount: "共 {m} 条",
			// 各分类注入了几条 —— 数字**来自宿主的 `injection.injectedByCategory`**，
			// 界面不自己算（界面自己算就会出现"看到的 ≠ 注入的"）。
			// A 类有保底份额，用户要能在这里自己验证它没被 B/C 挤成 0。
			injectBreakdown: "A {a} 条 · B {b} 条 · C {c} 条",
			injectEmpty: "当前没有注入任何内容（还没有画像文本）。",
			ledgerHint:
				"注入账本 v{v}：当前 {n} 条从未进过系统提示（账本按条目 id 累计，跨版本）。",
			ledgerSeen: "已注入 {n} 版",
			ledgerNever: "从未注入",
			genWarnings: "本次生成警告（{n}）",
			workingNotesHeading: "工作笔记（{n}）",
			workingNotesHint:
				"项目 / 工具 / 路径 / 账号 / 仓库类事实。不占画像槽位，也不会被自动注入。",
			fullProfileLabel: "完整画像（注入时按预算取舍，这里始终是全量，共 {n} 条）",

			copy: "复制",
			copied: "已复制",
			copyFailed: "复制失败：请手动选中后复制",
			regenerate: "重新生成",
			regenerating: "生成中…",
			regeneratingHint:
				"生成已在后台开始，完成后这里会自动更新（需要几秒到几分钟）。",
			regenerateHint: "手动触发一次画像更新。",
			confidenceHigh: "高",
			confidenceMedium: "中",
			confidenceLow: "低",

			revHeadingDirty: "有 {n} 处修订",
			revHeadingClean: "与你上次复制时一致",
			revHeadingUnknown: "尚未记录比较基线",
			revHeadingStale: "基线是旧格式，暂不比较",
			revHintUnknown: "复制一次模式 1 的画像，之后这里会提示画像有没有实质变化。",
			revHintStale: "条目编号的格式变了。再复制一次即可重新建立基线。",
			revHintClean: "自上次复制以来，画像没有变化。",
			revHintDirty:
				"按条目编号比较：新增、删除、改写各算一处。",
			revDetail: "查看这 {n} 处",
			revKindAdded: "新增",
			revKindRemoved: "删除",
			revKindModified: "改写",
			revBaselineAt: "基线时间：{time}",
			revBaselineVersion: "基线画像版本：v{v}",
			revSpurious: "上次生成的措辞抖动率：{rate}",

			customHeading: "模式 2 · 自定义",
			customPlaceholder:
				"在这里写你希望 AI 遵守的系统提示词。\n\n可以先从模式 1 复制画像，粘贴进来再改。",
			customSave: "保存",
			customSaved: "已保存",
			customSaving: "保存中…",
			customDirty: "有未保存的修改",
			customClean: "已与宿主同步",
			customFill: "从模式 1 填入",
			customFillEmpty: "模式 1 还没有画像文本可填。",
			customFillConfirmTitle: "填入会覆盖当前文本框内容",
			customFillConfirmBody: "当前内容还没被覆盖，确认后才会替换。",
			customFillConfirm: "确认填入",
			customFillCancel: "取消",
			customChars: "{n} 字",


			privacyHeading: "私人会话权限",
			privacyDesc:
				"你的画像和自定义文本只注入你自己的会话，QQ 会话和子代理不注入，也不拿来学习。下面是 QQ 会话默认的工具权限。",
			privacyQqGroup: "QQ 群",
			privacyQqPrivate: "QQ 私聊",
			privacyTierChat: "仅聊天",
			privacyTierSafe: "受限（只能读写自己的工作区）",
			privacyTierFull: "完全（不加限制）",
			privacyFullWarnTitle: "确认给 QQ 会话「完全」权限？",
			privacyFullWarnBody:
				"能给机器人发消息的人，都能让它在你的电脑上执行命令、读写任意文件。只在 scope 里只放了你自己时才这样设。",
			privacyFullConfirm: "确认",
			privacyFullCancel: "取消",
			privacyNotEnforcing: "工具门控在插件配置里关掉了（privacy.enforceTools），现在只记录、不拦截。",
			privacyMore: "按单个会话、单个 QQ 会话的设置，以及审计记录，在本机控制台里。",
			privacySaved: "权限已保存。",
			consoleOpen: "打开控制台 ↗",
			consoleOpening: "正在打开…",
			consoleFallback: "没有自动打开的话，点这个一次性登录链接（60 秒内有效）：",
			consoleOff: "本机控制台没有启动（插件配置 console.enabled 关了，或者端口被占用，见 plugin.log）。",
			consoleAt: "控制台：{url}（只接受这台电脑上的访问）",

			statusLoading: "正在读取宿主状态…",
			statusDisconnected: "未连接宿主",
			statusDisconnectedBody:
				"读取 {url} 失败：{error}。界面可以看，但读写都不可用。请确认 dsh-whale-shall-adapt 装在当前使用的 profile 里，然后刷新页面或重启 DSH。",
			statusRetry: "重试",
			statusPreview: "预览数据（仅界面演示，未连接宿主）",
			statusPreviewOn: "载入预览数据",
			statusPreviewOff: "退出预览",
			statusContract: "契约版本 {v}",
			signalHeading: "四个计数信号",
			signalHint: "这四个数字是宿主从会话日志里数出来的事实，不是模型判断。",
			signalSessions: "参与会话",
			signalHuman: "真人发言",
			signalDelegate: "AI 把活推回给你",
			signalLongTool: "命令失控（超时）",
			signalRepeatFail: "同一工具反复失败",
			signalFreeform: "给了选项你却自己另说",
			signalUnpaired: "（另有 {n} 条工具结果配不上调用，未计入）",
			lastRunHeading: "上次生成",
			lastRunOk: "成功",
			lastRunFail: "失败",
			lastRunNone: "未触发",
			lastRunNoneHint: "还没到自动更新的阈值——这是正常状态，不是出错。",
			lastRunReason: "原因：{reason}",
			errorPrefix: "出错了：",
			unsetCategory: "其他",
			close: "关闭",
			openSettings: "打开设置",
		};

