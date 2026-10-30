			// —— 断连/预览状态条 ——
			const banners = [];
			if (snap.preview) {
				banners.push(
					jsx(
						"div",
						{
							className: "pa_notice",
							"data-tone": "warn",
							children: jsx("p", { children: t("statusPreview") }),
						},
						"preview",
					),
				);
			}
			if (status === "error" && !snap.preview) {
				banners.push(
					jsxs(
						"div",
						{
							className: "pa_notice",
							"data-tone": "error",
							children: [
								jsx("p", { className: "pa_noticeTitle", children: t("statusDisconnected") }),
								jsx("p", {
									children: t("statusDisconnectedBody", {
										url: snap.endpoint || resolveApiBase() + "/state",
										error: snap.error || "—",
									}),
								}),
								jsxs("div", {
									className: "pa_row",
									children: [
										jsx("button", {
											type: "button",
											className: "pa_btn",
											onClick: () => actions.refresh(),
											children: t("statusRetry"),
										}),
										jsx("button", {
											type: "button",
											className: "pa_btn",
											onClick: () => actions.loadPreview(),
											children: t("statusPreviewOn"),
										}),
									],
								}),
							],
						},
						"error",
					),
				);
			}
			if (snap.flash && snap.flash.kind === "error") {
				banners.push(
					jsxs(
						"div",
						{
							className: "pa_notice",
							"data-tone": "error",
							children: [jsx("p", { children: t("errorPrefix") + snap.flash.text })],
						},
						"flash",
					),
				);
			}
			if (copyError) {
				banners.push(
					jsx(
						"div",
						{
							className: "pa_notice",
							"data-tone": "error",
							children: jsx("p", { children: t("copyFailed") }),
						},
						"copy-error",
					),
				);
			}
			// 生成警告（含换血上限的 capRejected）：宿主写在 lastRun.warnings 里，
			// 之前界面不读，用户看不到"这轮拒绝了几条净新增"。折叠展示，避免长文刷屏。
			const runWarnings =
				serverState.lastRun && Array.isArray(serverState.lastRun.warnings)
					? serverState.lastRun.warnings.filter(
							warning => typeof warning === "string" && warning,
						)
					: [];
			if (runWarnings.length > 0) {
				banners.push(
					jsxs(
						"details",
						{
							className: "pa_notice",
							"data-tone": "warn",
							children: [
								jsx("summary", {
									children: t("genWarnings", { n: runWarnings.length }),
								}),
								jsx("ul", {
									className: "pa_list",
									children: runWarnings.map((warning, index) =>
										jsx("li", { children: warning }, "w" + index),
									),
								}),
							],
						},
						"run-warnings",
					),
				);
			}

			// —— 模式选择器 ——
			const modeCard = jsxs("div", {
				className: "pa_card",
				children: [
					jsxs("div", {
						className: "pa_cardHead",
						children: [
							jsxs("div", {
								className: "pa_seg",
								role: "radiogroup",
								"aria-label": t("modeLegend"),
								children: [
									jsx(
										"button",
										{
											type: "button",
											role: "radio",
											className: "pa_segBtn",
											"data-active": isAuto ? "true" : "false",
											"aria-checked": isAuto,
											onClick: () => onSelectMode("auto"),
											children: t("modeAuto"),
										},
										"auto",
									),
									jsx(
										"button",
										{
											type: "button",
											role: "radio",
											className: "pa_segBtn",
											"data-active": isAuto ? "false" : "true",
											"aria-checked": !isAuto,
											onClick: () => onSelectMode("custom"),
											children: t("modeCustom"),
										},
										"custom",
									),
								],
							}),
							jsx("div", { className: "pa_spacer" }),
							jsxs("div", {
								className: "pa_effective",
								children: [
									jsx("span", { className: "pa_dot" }),
									jsx("span", {
										children: t("effectiveNow", {
											name: isAuto ? t("effectiveAuto") : t("effectiveCustom"),
										}),
									}),
								],
							}),
						],
					}),
					jsx("p", {
						className: "pa_cardHint",
						children: isAuto ? t("modeAutoDesc") : t("modeCustomDesc"),
					}),
					pendingMode === "auto"
						? jsxs("div", {
								className: "pa_notice",
								"data-tone": "warn",
								children: [
									jsx("p", { className: "pa_noticeTitle", children: t("switchWarnTitle") }),
									jsx("p", { children: t("switchWarnBody") }),
									jsxs("div", {
										className: "pa_row",
										children: [
											jsx("button", {
												type: "button",
												className: "pa_btn",
												"data-variant": "primary",
												onClick: confirmSwitch,
												children: t("switchWarnConfirm"),
											}),
											jsx("button", {
												type: "button",
												className: "pa_btn",
												onClick: () => setPendingMode(null),
												children: t("switchWarnCancel"),
											}),
										],
									}),
								],
							})
						: null,
				],
			});

