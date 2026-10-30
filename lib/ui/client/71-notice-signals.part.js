		/**
		 * 修订提示条。
		 * @param {object} props
		 * @returns {object}
		 */
		function RevisionNotice(props) {
			const { t, revision } = props;
			if (!revision || revision.status === "unknown") return null;
			const count = revision.count || 0;
			let tone = "ok";
			let heading = t("revHeadingClean");
			let hint = t("revHintClean");
			if (revision.status === "no-baseline" || revision.status === "empty-current") {
				tone = "info";
				heading = t("revHeadingUnknown");
				hint = t("revHintUnknown");
			} else if (revision.status === "stale-baseline") {
				tone = "warn";
				heading = t("revHeadingStale");
				hint = t("revHintStale");
			} else if (count > 0) {
				tone = "warn";
				heading = t("revHeadingDirty", { n: count });
				hint = t("revHintDirty");
			}
			const detail = [];
			for (const entry of revision.added || []) {
				detail.push({ kind: t("revKindAdded"), claim: entry && entry.claim });
			}
			for (const entry of revision.removed || []) {
				detail.push({ kind: t("revKindRemoved"), claim: entry && entry.claim });
			}
			for (const pair of revision.modified || []) {
				detail.push({ kind: t("revKindModified"), claim: pair.after && pair.after.claim });
			}
			const meta = [];
			if (revision.baselineAt) {
				meta.push(t("revBaselineAt", { time: formatTime(revision.baselineAt, "—") }));
			}
			if (typeof revision.baselineProfileVersion === "number") {
				meta.push(t("revBaselineVersion", { v: revision.baselineProfileVersion }));
			}
			if (props.spuriousRate !== null && props.spuriousRate !== undefined) {
				meta.push(
					t("revSpurious", { rate: Math.round(Number(props.spuriousRate) * 1000) / 10 + "%" }),
				);
			}
			return jsxs("div", {
				className: "pa_notice",
				"data-tone": tone,
				children: [
					jsx("p", { className: "pa_noticeTitle", children: heading }),
					jsx("p", { children: hint }),
					meta.length > 0
						? jsx("p", {
								className: "pa_meta",
								children: meta.map((text, index) => jsx("span", { children: text }, "m" + index)),
							})
						: null,
					detail.length > 0
						? jsxs("details", {
								className: "pa_details",
								children: [
									jsx("summary", { children: t("revDetail", { n: detail.length }) }),
									jsx("ul", {
										className: "pa_list",
										children: detail.map((item, index) =>
											jsxs(
												"li",
												{
													className: "pa_entry",
													children: [
														jsxs("div", {
															className: "pa_evidenceRow",
															children: [
																jsx("span", {
																	className: "pa_badge",
																	"data-tone": "business",
																	children: item.kind,
																}),
															],
														}),
														jsx("p", { className: "pa_claim", children: item.claim }),
													],
												},
												"d" + index,
											),
										),
									}),
								],
							})
						: null,
				],
			});
		}

		/**
		 * 四个计数信号。
		 * @param {object} props
		 * @returns {object}
		 */
		function SignalGrid(props) {
			const { t, signals } = props;
			const totals = signals && signals.totals ? signals.totals : null;
			if (!totals) return null;
			const cells = [
				{ key: "sessions", label: t("signalSessions"), value: totals.sessions },
				{ key: "humanMessages", label: t("signalHuman"), value: totals.humanMessages },
				{ key: "delegateRuns", label: t("signalDelegate"), value: totals.delegateRuns },
				{ key: "longTools", label: t("signalLongTool"), value: totals.longTools },
				{ key: "repeatFailures", label: t("signalRepeatFail"), value: totals.repeatFailures },
				{ key: "freeformAnswers", label: t("signalFreeform"), value: totals.freeformAnswers },
			];
			return jsxs("div", {
				className: "pa_card",
				children: [
					jsx("p", { className: "pa_cardHint", children: t("signalHint") }),
					jsx("div", {
						className: "pa_signals",
						children: cells.map(cell =>
							jsxs(
								"div",
								{
									className: "pa_signal",
									children: [
										jsx("span", {
											className: "pa_signalValue",
											children: typeof cell.value === "number" ? String(cell.value) : "—",
										}),
										jsx("span", { className: "pa_signalLabel", children: cell.label }),
									],
								},
								cell.key,
							),
						),
					}),
					totals.unpairedToolResults > 0
						? jsx("p", {
								className: "pa_meta",
								children: t("signalUnpaired", { n: totals.unpairedToolResults }),
							})
						: null,
				],
			});
		}

