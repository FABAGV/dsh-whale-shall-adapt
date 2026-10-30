			// —— 模式 1 面板 ——
			const revision = snap.revision || {};
			const autoPanel = jsxs("div", {
				className: "pa_card",
				"data-inactive": isAuto ? "false" : "true",
				children: [
					jsxs("div", {
						className: "pa_cardHead",
						children: [
							jsx("h3", { className: "pa_cardTitle", children: t("autoHeading") }),
							jsxs("span", {
								className: "pa_badge",
								"data-tone": isAuto ? "ok" : "warn",
								children: isAuto ? t("activeTag") : t("inactiveTag"),
							}),
							jsx("div", { className: "pa_spacer" }),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								disabled: snap.busy,
								onClick: onCopy,
								children: copiedFlash ? t("copied") : t("copy"),
							}),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								"data-variant": "primary",
								disabled: snap.busy || snap.regenerating || !!serverState.running,
								onClick: () => actions.regenerate(),
								title: t("regenerateHint"),
								children:
									snap.regenerating || serverState.running
										? t("regenerating")
										: t("regenerate"),
							}),
						],
					}),
					snap.regenerating
						? jsx("div", {
								className: "pa_notice",
								children: jsx("p", { children: t("regeneratingHint") }),
							})
						: null,
					jsxs("p", {
						className: "pa_meta",
						children: [
							jsx("span", {
								children: profile
									? t("autoUpdated", {
											time: formatTime(profile.generatedAt, t("autoNever")),
										})
									: t("autoNever"),
							}),
							profile && typeof profile.version === "number"
								? jsx("span", { children: " · " + t("autoVersion", { v: profile.version }) })
								: null,
							profile && typeof profile.evidenceMessages === "number"
								? jsx("span", {
										children: " · " + t("autoBasedOn", { n: profile.evidenceMessages }),
									})
								: null,
						],
					}),
					triggerHint && !profileEmpty
						? jsx("p", { className: "pa_cardHint", children: triggerHint })
						: null,
					firstRunLines.length > 0
						? jsxs("div", {
								className: "pa_notice",
								children: [
									jsx("p", { className: "pa_noticeTitle", children: t("autoFirstRunTitle") }),
									...firstRunLines.map((line, index) =>
										jsx("p", { children: line }, "first-run-" + index),
									),
								],
							})
						: null,
					jsx(RevisionNotice, { t, revision, spuriousRate: serverState.lastRun && serverState.lastRun.spuriousRate }),
					capacity && capacity.saturated
						? jsxs("div", {
								className: "pa_notice",
								"data-tone": "warn",
								children: [
									jsx("p", {
										className: "pa_noticeTitle",
										children: t("autoSaturated", { n: capacity.entries }),
									}),
									jsx("p", { children: t("autoSaturatedBody") }),
									Number(capacity.zeroChangeStreak) >= 2
										? jsx("p", {
												children: t("autoSaturatedStreak", {
													n: capacity.zeroChangeStreak,
												}),
											})
										: null,
								],
							})
						: null,
					// —— ① 置顶（pin）：常显，排在最上面 ——
					// 用户："重要（pin）的效果就是直接进 A 区保证显示"。这些条目同时
					// 也照旧出现在下面的「完整画像」里（状态跟着走），这里只是把它们
					// 提到最显眼处，并且它们**一定进注入**（豁免预算，宿主保证）。
					pinnedItems.length > 0
						? jsxs("div", {
								className: "pa_group",
								children: [
									jsx("h4", {
										className: "pa_groupTitle",
										children: t("pinnedHeading", { n: pinnedItems.length }),
									}),
									jsx("p", { className: "pa_cardHint", children: t("pinnedHint") }),
									jsx(MarkList, { t, items: pinnedItems }),
								],
							})
						: null,
					// —— ② 实际注入的系统提示（显眼位置：紧跟卡片头部与更新时间）——
					// 只渲染宿主的 `injectedText`。下面那行说明把"注入的"与
					// "完整画像"的关系一次讲清：上面是按预算裁剪后真正进了
					// 系统提示的那段，下面是全量画像。
					jsxs("div", {
						className: "pa_inject",
						children: [
							jsxs("div", {
								className: "pa_injectHead",
								children: [
									jsx("h4", { className: "pa_injectLabel", children: t("injectHeading") }),
									// 各分类注入条数（宿主 `injectedByCategory`）优先显示：
									// 它比"共 m 条"信息量大 —— 用户要在这里验证 A 类没被挤成 0。
									// 摘要缺这一块（老宿主 / 预览数据）时退回"共 m 条"。
									injectedByCategory
										? jsx("span", {
												className: "pa_badge",
												"data-tone": "business",
												children: t("injectBreakdown", {
													a: injectedByCategory.A,
													b: injectedByCategory.B,
													c: injectedByCategory.C,
												}),
											})
										: injectedShown === null
											? null
											: jsx("span", {
													className: "pa_badge",
													"data-tone": "business",
													children: t("injectCount", { m: injectedShown }),
												}),
								],
							}),
							injectedText
								? jsx("pre", { className: "pa_injectText", children: injectedText })
								: jsx("p", { className: "pa_cardHint", children: t("injectEmpty") }),
							jsx("p", {
								className: "pa_cardHint",
								children: t("injectHint", { m: injectedShown ?? 0, n: totalShown }),
							}),
						],
					}),
					// —— ③ 完整画像（下面这一整段都是它）——
					// 每条条目旁三个按钮：置顶 / 封印 / 删除（`actions` 就是那三个回调）。
					jsx("h4", {
						className: "pa_groupTitle",
						children: t("fullProfileLabel", { n: totalShown }),
					}),
					ledgerCounts && neverInjectedShown !== null
						? jsx("p", {
								className: "pa_cardHint",
								children: t("ledgerHint", { n: neverInjectedShown, v: ledgerVersion }),
							})
						: null,
					entries.length === 0
						? jsx("p", { className: "pa_cardHint", children: t("autoEmptyHint") })
						: jsx("div", {
								className: "pa_group",
								children: CATEGORY_ORDER.map(category =>
									jsx(
										CategoryGroup,
										{
											t,
											category,
											label: groupLabels[category],
											entries: grouped[category],
											actions: entryMarkActions,
											counts: ledgerCounts,
										},
										"g" + category,
									),
								),
							}),
					grouped[CATEGORY_EXTRA].length > 0
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", {
										children:
											groupLabels[CATEGORY_EXTRA] +
											" (" +
											grouped[CATEGORY_EXTRA].length +
											")",
									}),
									jsx(CategoryGroup, {
										t,
										category: CATEGORY_EXTRA,
										label: groupLabels[CATEGORY_EXTRA],
										entries: grouped[CATEGORY_EXTRA],
										actions: entryMarkActions,
										counts: ledgerCounts,
									}),
								],
							})
						: null,
					// —— 工作笔记：项目/工具/路径类事实，独立于画像条目（不占槽位、不注入）——
					workingNotes.length > 0
						? jsxs("div", {
								className: "pa_group",
								children: [
									jsx("h4", {
										className: "pa_groupTitle",
										children: t("workingNotesHeading", { n: workingNotes.length }),
									}),
									jsx("p", {
										className: "pa_cardHint",
										children: t("workingNotesHint"),
									}),
									jsx("ul", {
										className: "pa_list",
										children: workingNotes.map((note, index) =>
											jsx(
												"li",
												{
													className: "pa_entry",
													children: jsx("p", {
														className: "pa_claim",
														children: note.text,
													}),
												},
												"note-" + index,
											),
										),
									}),
								],
							})
						: null,
					// —— ④ 未注入（折叠）：按规则没进系统提示的条目 ——
					// 折叠区一律复用 pa_details（不新造折叠组件），默认收起。
					jsx(MarkFold, {
						t,
						heading: t("omittedHeading", { n: omittedItems.length }),
						hint: t("omittedHint"),
						items: omittedItems,
					}),
					// —— ⑤ 垃圾桶（折叠）：被封印的条目，可恢复 ——
					jsx(MarkFold, {
						t,
						heading: t("sealedHeading", { n: sealedItems.length }),
						hint: t("sealedHint"),
						items: sealedItems,
					}),
					// —— ⑥ 已删除（折叠）：删过的条目 + 各删了几次 ——
					jsx(MarkFold, {
						t,
						heading: t("deletedHeading", { n: deletedItems.length }),
						hint: t("deletedHint"),
						items: deletedItems,
					}),
					serverState.autoExtraText
						? jsxs("div", {
								className: "pa_group",
								children: [
									jsx("h4", { className: "pa_groupTitle", children: t("autoExtraLabel") }),
									jsx("p", { className: "pa_claim", children: serverState.autoExtraText }),
								],
							})
						: null,
					profile && profile.notes
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", { children: t("autoNotes") }),
									jsx("pre", { className: "pa_pre", children: profile.notes }),
								],
							})
						: null,
					profile && profile.raw
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", { children: t("autoRaw") }),
									jsx("pre", { className: "pa_pre", children: profile.raw }),
								],
							})
						: null,
				],
			});

