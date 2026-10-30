		// ====================================================================
		// 组件
		// ====================================================================

		/**
		 * 错误 flash 在顶部停留多久（毫秒）。
		 *
		 * store 里**没有任何地方**会把 `flash` 清掉（只有 setMode/saveCustom/
		 * regenerate 在失败时写新的），所以不清就是永久横幅：问题修好了、
		 * 状态刷新成功了，那条红字还在。这里给一个有限期的自动消失。
		 */
		const FLASH_AUTO_DISMISS_MS = 8000;

		/**
		 * 一个证据量徽标行。
		 * @param {object} props
		 * @returns {object}
		 */
		function EvidenceRow(props) {
			const { t, entry } = props;
			const parts = [];
			const basedOn =
				typeof entry.lastEvidenceMessages === "number" ? entry.lastEvidenceMessages : null;
			if (basedOn !== null) parts.push(t("autoEvidence", { n: basedOn }));
			if (typeof entry.evidenceQuoteCount === "number" && entry.evidenceQuoteCount > 0) {
				parts.push(t("autoQuotes", { n: entry.evidenceQuoteCount }));
			}
			if (entry.confidence) {
				const key =
					entry.confidence === "high"
						? "confidenceHigh"
						: entry.confidence === "low"
							? "confidenceLow"
							: "confidenceMedium";
				parts.push(t("autoConfidence", { level: t(key) }));
			}
			return jsx("div", {
				className: "pa_evidenceRow",
				children: parts.map((text, index) => jsx("span", { children: text }, "e" + index)),
			});
		}

		/**
		 * 一条条目旁的处置按钮组（置顶 / 封印 / 删除）。
		 *
		 * ⚠️ 这个组件**不许用 Hook**：测试里的 jsx 桩会把函数组件
		 * **就地展开**（直接调用），在那种渲染路径下用 Hook 会踩乱 Hook 游标。
		 * 所有回调与状态都由 `AdaptSection`（真正由迷你 React 渲染的那个）传进来。
		 *
		 * 三个按钮的语义差别就写在 title 里（用户最容易混的就是"删除 vs 封印"）：
		 *   · 置顶 → 界面置顶 + 豁免预算、保证注入（有上限 `maxPinned`）
		 *   · 封印 → 拉进垃圾桶，之后的更新也不许再产出
		 *   · 删除 → 只去掉这一版，下一轮材料有依据时还可能回来
		 *
		 * @param {object} props
		 * @returns {object|null}
		 */
		function EntryActions(props) {
			const { t, entry, mark, busy, pinDisabled, onPin, onUnpin, onSeal, onDelete } = props;
			if (!entry) return null;
			const pinned = !!(mark && mark.status === "pinned");
			// 异常但真的会发生：这条在 entries 里，却带着 sealed 标记（外部手改过
			// state.json、或旧版本留下的画像）。如实打个徽标 —— 用户能看出"它为什么
			// 没进注入"，而不是对着一堆按钮猜。
			const sealed = !!(mark && mark.status === "sealed");
			const maxPinned = props.maxPinned;
			const pinTitle = pinned
				? t("unpinEntry")
				: pinDisabled
					? t("pinEntryLimit", { max: maxPinned })
					: t("pinEntryHint", { max: maxPinned });
			return jsxs("div", {
				className: "pa_entryActions",
				children: [
					pinned
						? jsx("span", {
								className: "pa_badge pa_markTag",
								"data-tone": "business",
								children: t("entryPinnedTag"),
							})
						: null,
					sealed
						? jsx("span", {
								className: "pa_badge pa_markTag",
								"data-tone": "error",
								children: t("entrySealedTag"),
							})
						: null,
					jsx("div", { className: "pa_spacer" }),
					jsx("button", {
						type: "button",
						className: "pa_btn",
						disabled: busy || (pinDisabled && !pinned),
						title: pinTitle,
						onClick: () => {
							if (pinned) onUnpin(mark.key);
							else onPin(entry);
						},
						children: pinned ? t("unpinEntry") : t("pinEntry"),
					}),
					jsx("button", {
						type: "button",
						className: "pa_btn",
						"data-variant": "danger",
						disabled: busy,
						title: t("sealEntryHint"),
						onClick: () => onSeal(entry),
						children: t("sealEntry"),
					}),
					jsx("button", {
						type: "button",
						className: "pa_btn",
						"data-variant": "danger",
						disabled: busy,
						title: t("deleteEntryHint"),
						onClick: () => onDelete(entry),
						children: t("deleteEntry"),
					}),
				],
			});
		}

		/**
		 * 模式 1 的一个分类分组。
		 *
		 * `props.actions` 存在时每条条目多一行处置按钮（置顶 / 封印 / 删除）——
		 * 「完整画像」区用它；折叠区（垃圾桶 / 已删除）传自己的按钮，走 MarkList。
		 *
		 * ⚠️ 与 EntryActions 同理：**不许用 Hook**（测试里的 jsx 桩会就地展开本组件）。
		 *
		 * @param {object} props
		 * @returns {object}
		 */
		function CategoryGroup(props) {
			const { t, category, label, entries } = props;
			if (!entries || entries.length === 0) return null;
			const actions = props.actions || null;
			const counts = props.counts || null;
			return jsxs("div", {
				className: "pa_group",
				children: [
					jsxs("h4", {
						className: "pa_groupTitle",
						children: [
							jsx("span", {
								className: "pa_groupBar",
								"data-tone": CATEGORY_TONE[category] || "toneD",
							}),
							jsx("span", { children: label }),
							jsx("span", {
								className: "pa_meta",
								children: "(" + entries.length + ")",
							}),
						],
					}),
					jsx("ul", {
						className: "pa_list",
						children: entries.map((entry, index) =>
							jsxs(
								"li",
								{
									className: "pa_entry",
									children: [
										jsx("p", { className: "pa_claim", children: entry.claim }),
										counts && entry.id
											? jsx("div", {
													className: "pa_evidenceRow",
													children: jsx("span", {
														className: "pa_badge",
														"data-tone":
															Number(counts[entry.id]) > 0 ? "business" : "warn",
														children:
															Number(counts[entry.id]) > 0
																? t("ledgerSeen", { n: counts[entry.id] })
																: t("ledgerNever"),
													}),
												})
											: null,
										jsx(EvidenceRow, { t, entry }),
										actions
											? jsx(EntryActions, {
													t,
													entry,
													mark: actions.markOf(entry),
													busy: actions.busy,
													pinDisabled: actions.pinDisabled,
													maxPinned: actions.maxPinned,
													onPin: actions.onPin,
													onUnpin: actions.onUnpin,
													onSeal: actions.onSeal,
													onDelete: actions.onDelete,
												})
											: null,
									],
								},
								(entry.id || "entry") + "-" + index,
							),
						),
					}),
				],
			});
		}

		/**
		 * 一组"处置条目"的列表（置顶区与三个折叠区共用）。
		 *
		 * ⚠️ 不许用 Hook（测试里的 jsx 桩会就地展开本组件）。
		 *
		 * @param {object} props
		 * @returns {object|null}
		 */
		function MarkList(props) {
			const { t, items } = props;
			if (!items || items.length === 0) return null;
			return jsx("ul", {
				className: "pa_list",
				children: items.map((item, index) =>
					jsxs(
						"li",
						{
							className: "pa_entry",
							children: [
								jsx("p", { className: "pa_claim", children: item.claim }),
								item.meta && item.meta.length > 0
									? jsx("div", {
											className: "pa_evidenceRow",
											children: item.meta.map((text, metaIndex) =>
												jsx("span", { children: text }, "m" + metaIndex),
											),
										})
									: null,
								item.entryObj ? jsx(EvidenceRow, { t, entry: item.entryObj }) : null,
								item.actions || null,
							],
						},
						item.key || "mark-" + index,
					),
				),
			});
		}

		/**
		 * 一个折叠区（④ 未注入 / ⑤ 垃圾桶 / ⑥ 已删除）。
		 *
		 * 复用既有的折叠组件 `pa_details`（`details/summary`），**不新造折叠组件** ——
		 * 项目里已经有 11 处在用它，样式与键盘行为都验过了。默认收起，不占屏幕。
		 *
		 * @param {object} props
		 * @returns {object|null}
		 */
		function MarkFold(props) {
			const { t, heading, hint, items } = props;
			if (!items || items.length === 0) return null;
			return jsxs("details", {
				className: "pa_details",
				children: [
					jsx("summary", { children: heading }),
					jsx("p", { className: "pa_cardHint", children: hint }),
					jsx(MarkList, { t, items }),
				],
			});
		}

		/**
		 * 折叠区里**一条标记**的按钮组（① 置顶 / ⑤ 垃圾桶 / ⑥ 已删除）。
		 *
		 * 与 `EntryActions` 分开是必要的：这些区里的条目**可能已经不在画像里**
		 * （只剩记录），所以动作按标记的 `key` 走，不依赖画像里的 id。
		 *
		 * ⚠️ 同样不许用 Hook。
		 *
		 * @param {object} props
		 * @returns {object}
		 */
		function MarkActions(props) {
			const { t, mark, busy, pinDisabled, maxPinned, onPin, onUnpin, onSeal, onDelete, onUnseal } = props;
			const buttons = [];
			if (mark.status === "pinned") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							disabled: busy,
							onClick: () => onUnpin(mark.key),
							children: t("unpinEntry"),
						},
						"unpin",
					),
				);
			}
			if (mark.status === "sealed") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							disabled: busy,
							onClick: () => onUnseal(mark.key),
							children: t("unsealEntry"),
						},
						"unseal",
					),
				);
			}
			if (mark.status === "deleted") {
				// 删除区里"升级成封印"是最常用的一步：它老回来，就把它挡住。
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							disabled: busy || pinDisabled,
							title: pinDisabled
								? t("pinEntryLimit", { max: maxPinned })
								: t("pinEntryHint", { max: maxPinned }),
							onClick: () => onPin(mark.key),
							children: t("pinEntry"),
						},
						"pin",
					),
				);
			}
			if (mark.status !== "sealed") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							"data-variant": "danger",
							disabled: busy,
							title: t("sealEntryHint"),
							onClick: () => onSeal(mark.key),
							children: t("sealEntry"),
						},
						"seal",
					),
				);
			}
			if (mark.status === "pinned") {
				buttons.push(
					jsx(
						"button",
						{
							type: "button",
							className: "pa_btn",
							"data-variant": "danger",
							disabled: busy,
							title: t("deleteEntryHint"),
							onClick: () => onDelete(mark.key),
							children: t("deleteEntry"),
						},
						"delete",
					),
				);
			}
			return jsxs("div", {
				className: "pa_entryActions",
				children: [jsx("div", { className: "pa_spacer" }), ...buttons],
			});
		}

