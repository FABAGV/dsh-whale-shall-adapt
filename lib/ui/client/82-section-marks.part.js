			// —— 条目处置标记（置顶 / 垃圾桶 / 已删除）——
			//
			// 三种状态是宿主记忆层里的用户裁决，`/state` 的 `entryMarks` 是现算的视图（用户的处置
			// 决定要比任何一版画像活得久）。界面这边只做三件事：分区、显示、发请求。
			const marks =
				Array.isArray(serverState.entryMarks)
					? serverState.entryMarks.filter(
							mark => mark && typeof mark === "object" && mark.entry && mark.entry.claim,
						)
					: [];
			const pinnedMarks = marks.filter(mark => mark.status === "pinned");
			const sealedMarks = marks.filter(mark => mark.status === "sealed");
			const deletedMarks = marks.filter(mark => mark.status === "deleted");
			// 真实画像条目 id → 标记：③ 区靠它知道"这条现在是什么状态"（宿主现算的 presentId）。
			const markByPresentId = new Map();
			for (const mark of marks) {
				if (mark.presentId) markByPresentId.set(mark.presentId, mark);
			}
			// 置顶上限由宿主给（`inject.maxPinned`），界面不写死数字。
			const maxPinned = typeof serverState.maxPinned === "number" ? serverState.maxPinned : 10;
			const pinFull = pinnedMarks.length >= maxPinned;
			/** ③ 区那组按钮的状态与回调（都发到宿主，见 store.actions）。 */
			const entryMarkActions = {
				busy: snap.busy,
				pinDisabled: pinFull,
				maxPinned,
				markOf: entry => (entry && entry.id ? markByPresentId.get(entry.id) || null : null),
				onPin: entry => actions.pinEntry(entry.id, entry.claim),
				onUnpin: key => actions.unpinEntry(key),
				onSeal: entry => actions.sealEntry(entry.id, entry.claim),
				onDelete: entry => actions.deleteEntry(entry.id, entry.claim),
			};
			/** 折叠区里按**标记**走的那组动作（条目可能已经不在画像里，只能靠 key）。 */
			const markKeyActions = {
				busy: snap.busy,
				pinDisabled: pinFull,
				maxPinned,
				onPin: key => actions.pinEntry(null, null, key),
				onUnpin: key => actions.unpinEntry(key),
				onSeal: key => actions.sealEntry(null, null, key),
				onUnseal: key => actions.unsealEntry(key),
				onDelete: key => actions.deleteEntry(null, null, key),
			};
			const foldActionsFor = mark =>
				jsx(MarkActions, { t, mark, ...markKeyActions });

			// —— ④ 未注入：完整画像里**被预算裁掉**的条目 ——
			//
			// 差集用**宿主给的** `injection.injectedIds`（就是那次裁剪的结果），
			// 界面**不自己重算**注入取舍 —— 那会退回"看到的 ≠ 注入的"
			// （界面上只有完整画像，算不出宿主按预算裁剪的结果）。
			//
			// ⚠️ 只收 A/B/C 里被裁掉的：证据不足的 D 类（以及分类识别不出的）
			//    **本来就不注入**，它们在 ③ 区自己那个折叠里，收进这里就是同一批条目
			//    在两个折叠里各显示一遍。用户要的是"都能被看到"，不是"看到两遍"。
			// 老宿主 / 预览数据没有 `injectedIds` 时整区不显示（宁可不显示，也不乱报）。
			const injectedIds =
				injection && Array.isArray(injection.injectedIds) ? injection.injectedIds : null;
			const injectedIdSet = injectedIds ? new Set(injectedIds) : null;
			const omittedEntries = injectedIdSet
				? entries.filter(
						entry => CATEGORY_ORDER.indexOf(entry.category) >= 0 && !injectedIdSet.has(entry.id),
					)
				: [];
			/** 折叠区条目的统一形状（`MarkList` / `MarkFold` 只认这个）。 */
			const foldItem = (key, claim, entryObj, meta, actions) => ({
				key,
				claim,
				entryObj,
				meta,
				actions,
			});
			/** ④ 区里那些条目的处置按钮：与 ③ 区同一套动作（就是位置不同）。 */
			const entryActionsFor = entry =>
				jsx(EntryActions, {
					t,
					entry,
					mark: entryMarkActions.markOf(entry),
					busy: snap.busy,
					pinDisabled: pinFull,
					maxPinned,
					onPin: entryMarkActions.onPin,
					onUnpin: entryMarkActions.onUnpin,
					onSeal: entryMarkActions.onSeal,
					onDelete: entryMarkActions.onDelete,
				});
			// —— ① 置顶 / ④ 未注入 / ⑤ 垃圾桶 / ⑥ 已删除 的条目 ——
			// meta 只放**事实**：这条现在还在不在画像里、被删过几次。
			const pinnedItems = pinnedMarks.map(mark =>
				foldItem(
					mark.key,
					mark.entry.claim,
					mark.entry,
					[
						mark.present ? null : t("pinnedGone"),
						mark.deleteCount > 0 ? t("deleteCountBefore", { n: mark.deleteCount }) : null,
					].filter(Boolean),
					foldActionsFor(mark),
				),
			);
			const omittedItems = omittedEntries.map(entry =>
				foldItem(entry.id || entry.claim, entry.claim, entry, [], entryActionsFor(entry)),
			);
			const sealedItems = sealedMarks.map(mark =>
				foldItem(mark.key, mark.entry.claim, mark.entry, [], foldActionsFor(mark)),
			);
			const deletedItems = deletedMarks.map(mark =>
				foldItem(
					mark.key,
					mark.entry.claim,
					mark.entry,
					[
						t("deletedCount", { n: mark.deleteCount > 0 ? mark.deleteCount : 1 }),
						mark.present ? t("deletedBack") : null,
					].filter(Boolean),
					foldActionsFor(mark),
				),
			);

			const onSelectMode = next => {
				if (next === mode) return;
				if (next === "auto" && customHasText) {
					setPendingMode("auto");
					return;
				}
				actions.setMode(next);
			};

			const confirmSwitch = () => {
				setPendingMode(null);
				actions.setMode("auto");
			};

			const onCopy = async () => {
				const text = portraitText;
				// 没有内容不再静默失败：按钮始终可点，点了就说明为什么没得复制。
				if (!text) {
					actions.emit({ flash: { kind: "error", text: t("copyEmpty") } });
					return;
				}
				const ok = await copyToClipboard(text);
				if (!ok) {
					setCopiedFlash(false);
					setCopyError(true);
					return;
				}
				setCopyError(false);
				setCopiedFlash(true);
				await actions.markCopied(text);
			};

			const onFillFromAuto = () => {
				if (!portraitText) {
					actions.emit({ flash: { kind: "error", text: t("copyEmpty") } });
					return;
				}
				if (draft.trim().length > 0) {
					setFillConfirm(true);
					return;
				}
				applyFill();
			};

			const applyFill = () => {
				dirtyRef.current = true;
				setDraftTouched(true);
				setDraft(portraitText);
				setFillConfirm(false);
			};

			const onDraftChange = event => {
				dirtyRef.current = true;
				setDraftTouched(true);
				setDraft(event.target.value);
			};

			const onSaveCustom = async () => {
				dirtyRef.current = false;
				setDraftTouched(false);
				const saved = await actions.saveCustom(draft);
				// 保存失败时恢复脏标记：宿主并没有这段文本，界面不能自称
				// "已与宿主同步"，而且「保存」按钮也不能被永久禁用（否则没法重试）。
				if (!saved) {
					dirtyRef.current = true;
					setDraftTouched(true);
				}
			};

