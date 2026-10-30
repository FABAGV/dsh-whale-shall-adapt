			// —— 模式 2 面板 ——
			const customPanel = jsxs("div", {
				className: "pa_card",
				"data-inactive": isAuto ? "true" : "false",
				children: [
					jsxs("div", {
						className: "pa_cardHead",
						children: [
							jsx("h3", { className: "pa_cardTitle", children: t("customHeading") }),
							jsxs("span", {
								className: "pa_badge",
								"data-tone": isAuto ? "warn" : "ok",
								children: isAuto ? t("inactiveTag") : t("activeTag"),
							}),
							jsx("div", { className: "pa_spacer" }),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								disabled: snap.busy,
								onClick: onFillFromAuto,
								children: t("customFill"),
							}),
							jsx("button", {
								type: "button",
								className: "pa_btn",
								"data-variant": "primary",
								disabled: snap.busy || !draftTouched,
								onClick: onSaveCustom,
								children: snap.busy ? t("customSaving") : t("customSave"),
							}),
						],
					}),
					!portraitText
						? jsx("p", { className: "pa_cardHint", children: t("customFillEmpty") })
						: null,
					fillConfirm
						? jsxs("div", {
								className: "pa_notice",
								"data-tone": "warn",
								children: [
									jsx("p", {
										className: "pa_noticeTitle",
										children: t("customFillConfirmTitle"),
									}),
									jsx("p", { children: t("customFillConfirmBody") }),
									jsxs("div", {
										className: "pa_row",
										children: [
											jsx("button", {
												type: "button",
												className: "pa_btn",
												"data-variant": "primary",
												onClick: applyFill,
												children: t("customFillConfirm"),
											}),
											jsx("button", {
												type: "button",
												className: "pa_btn",
												onClick: () => setFillConfirm(false),
												children: t("customFillCancel"),
											}),
										],
									}),
								],
							})
						: null,
					jsx("label", {
						className: "pa_hidden",
						htmlFor: textareaId,
						children: t("customHeading"),
					}),
					jsx("textarea", {
						id: textareaId,
						className: "pa_textarea",
						value: draft,
						placeholder: t("customPlaceholder"),
						onChange: onDraftChange,
						spellCheck: false,
					}),
					jsxs("div", {
						className: "pa_row",
						children: [
							jsx("span", {
								className: "pa_meta",
								children: t("customChars", { n: draft.length }),
							}),
							jsx("div", { className: "pa_spacer" }),
							jsx("span", {
								className: "pa_badge",
								"data-tone": draftTouched ? "warn" : "ok",
								children: draftTouched ? t("customDirty") : t("customClean"),
							}),
						],
					}),
				],
			});

			// —— 私人会话权限 + 本机控制台 ——
			// 宿主没有这两个字段（老宿主）时整块不显示。
			const privacyInfo = serverState.privacy || null;
			const consoleInfo = serverState.console || null;
			const tierOf = kind =>
				(privacyInfo && privacyInfo.classes && privacyInfo.classes[kind] && privacyInfo.classes[kind].tier) || "chat";
			const onTierChange = (kind, tier) => {
				if (tier === tierOf(kind)) return;
				if (tier === "full") {
					setPendingTier({ kind, tier });
					return;
				}
				setPendingTier(null);
				actions.savePrivacyTier(kind, tier);
			};
			const tierRow = (kind, label) =>
				jsxs("div", {
					className: "pa_tierRow",
					children: [
						jsx("span", { children: label }),
						jsxs("select", {
							className: "pa_select",
							value: tierOf(kind),
							disabled: snap.busy || snap.preview,
							"aria-label": label,
							onChange: event => onTierChange(kind, event.target.value),
							children: [
								jsx("option", { value: "chat", children: t("privacyTierChat") }),
								jsx("option", { value: "safe", children: t("privacyTierSafe") }),
								jsx("option", { value: "full", children: t("privacyTierFull") }),
							],
						}),
					],
				});
			const onOpenConsole = async () => {
				setConsoleBusy(true);
				try {
					const url = await actions.openConsole();
					if (url) {
						setConsoleLink(url);
						try {
							window.open(url, "_blank", "noopener");
						} catch (error) {
							// 打不开新窗口时下面还有链接可点
						}
					}
				} finally {
					setConsoleBusy(false);
				}
			};
			const privacyPanel = privacyInfo
				? jsxs("div", {
						className: "pa_card",
						children: [
							jsxs("div", {
								className: "pa_cardHead",
								children: [
									jsx("h3", { className: "pa_cardTitle", children: t("privacyHeading") }),
									consoleInfo && consoleInfo.url
										? jsx("button", {
												type: "button",
												className: "pa_btn",
												"data-variant": "primary",
												disabled: consoleBusy || snap.preview,
												onClick: onOpenConsole,
												children: consoleBusy ? t("consoleOpening") : t("consoleOpen"),
											})
										: null,
								],
							}),
							jsx("p", { className: "pa_cardHint", children: t("privacyDesc") }),
							privacyInfo.enforcing === false
								? jsx("div", {
										className: "pa_notice",
										"data-tone": "warn",
										children: jsx("p", { children: t("privacyNotEnforcing") }),
									})
								: null,
							tierRow("qq-group", t("privacyQqGroup")),
							tierRow("qq-private", t("privacyQqPrivate")),
							pendingTier
								? jsxs("div", {
										className: "pa_notice",
										"data-tone": "warn",
										children: [
											jsx("p", { className: "pa_noticeTitle", children: t("privacyFullWarnTitle") }),
											jsx("p", { children: t("privacyFullWarnBody") }),
											jsxs("div", {
												className: "pa_row",
												children: [
													jsx("button", {
														type: "button",
														className: "pa_btn",
														"data-variant": "primary",
														onClick: () => {
															const pending = pendingTier;
															setPendingTier(null);
															actions.savePrivacyTier(pending.kind, pending.tier);
														},
														children: t("privacyFullConfirm"),
													}),
													jsx("button", {
														type: "button",
														className: "pa_btn",
														onClick: () => setPendingTier(null),
														children: t("privacyFullCancel"),
													}),
												],
											}),
										],
									})
								: null,
							consoleLink
								? jsxs("p", {
										className: "pa_meta",
										children: [
											t("consoleFallback") + " ",
											jsx("a", {
												className: "pa_link",
												href: consoleLink,
												target: "_blank",
												rel: "noopener noreferrer",
												children: consoleLink,
											}),
										],
									})
								: null,
							jsx("p", {
								className: "pa_meta",
								children: consoleInfo && consoleInfo.url
									? t("consoleAt", { url: consoleInfo.url }) + " " + t("privacyMore")
									: t("consoleOff"),
							}),
						],
					})
				: null;

			return jsxs("div", {
				className: "pa_root",
				children: [
					jsxs("div", {
						children: [
							jsx("h2", { className: "pa_h2", children: t("title") }),
							jsx("p", { className: "pa_intro", children: t("intro") }),
						],
					}),
					status === "loading" && !snap.state
						? jsx("p", { className: "pa_meta", children: t("statusLoading") })
						: null,
					banners.length > 0 ? jsx("div", { children: banners }) : null,
					modeCard,
					autoPanel,
					customPanel,
					privacyPanel,
					jsx(SignalGrid, { t, signals: serverState.lastSignals }),
					serverState.lastRun && serverState.lastRun.at
						? jsxs("div", {
								className: "pa_notice",
								"data-tone": serverState.lastRun.ok === false ? "error" : undefined,
								children: [
									jsx("p", {
										className: "pa_noticeTitle",
										children: t("lastRunHeading"),
									}),
									jsx("p", {
										// `ok` 是三态：true 成功 / false 失败 / null 未触发（没到阈值）。
										// 早先按 `ok ? 成功 : 失败` 渲染，于是每次“未达阈值”都被写成
										// “失败”，首跑用户会以为插件坏了 —— 这里必须按三态显示。
										children:
											// `ok: null` 是宿主明确的“没生成/跳过”（未达阈值、饱和守卫、
											// 模式 2 等），不是失败；只有 `ok: false` 才是真失败。
											(serverState.lastRun.ok === true
												? t("lastRunOk")
												: serverState.lastRun.ok === false
													? t("lastRunFail")
													: t("lastRunNone")) +
											" · " +
											formatTime(serverState.lastRun.at, "—"),
									}),
									serverState.lastRun.ok == null
										? jsx("p", { className: "pa_meta", children: t("lastRunNoneHint") })
										: null,
									serverState.lastRun.reason
										? jsx("p", {
												className: "pa_meta",
												children: t("lastRunReason", {
													reason: serverState.lastRun.reason,
												}),
											})
										: null,
									serverState.lastRun.error
										? jsx("p", {
												className: "pa_meta",
												children: String(serverState.lastRun.error),
											})
										: null,
								],
							})
						: null,
					snap.contract !== null
						? jsx("p", {
								className: "pa_meta",
								children: t("statusContract", { v: snap.contract }),
							})
						: null,
				],
			});
		}

