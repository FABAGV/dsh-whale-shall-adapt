		// ====================================================================
		// 预览数据（仅在读取宿主失败后由用户显式点击才载入）
		//
		// 刻意设计成能演示修订提示：复制之后改写了 2 条、新增了 1 条，共 3 处。
		// ====================================================================

		function buildPreviewState() {
			const baselineEntries = [
				{
					id: "a1",
					category: "A",
					claim: "用户偏好简短、直达结论的回答，不喜欢铺垫。",
					evidence: ["[12] 直接说结论就行", "[48] 别写那么多"],
					confidence: "high",
					evidenceQuoteCount: 2,
					lastEvidenceMessages: 96,
				},
				{
					id: "b1",
					category: "B",
					claim: "不要在没有确认的情况下动别人的文件。",
					evidence: ["[77] 谁让你改这个的"],
					confidence: "high",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 96,
				},
				{
					id: "c1",
					category: "C",
					claim: "先给出最小可验证的一步，再展开。",
					evidence: ["[101] 这样挺好"],
					confidence: "medium",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 96,
				},
			];
			const currentEntries = [
				// 逐字未变 → 0 处
				{
					id: "a1",
					category: "A",
					claim: "用户偏好简短、直达结论的回答，不喜欢铺垫。",
					evidence: ["[12] 直接说结论就行", "[48] 别写那么多"],
					confidence: "high",
					evidenceQuoteCount: 2,
					lastEvidenceMessages: 96,
				},
				// 同 id、同证据、只换了措辞 → 0 处（这就是要压掉的那 26.3%）
				{
					id: "b1",
					category: "B",
					claim: "改动他人文件之前必须先征求同意。",
					evidence: ["[77] 谁让你改这个的"],
					confidence: "high",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 96,
				},
				// 同 id、证据集合变了 → 1 处（改写）
				{
					id: "c1",
					category: "C",
					claim: "先给出最小可验证的一步，再展开；改完要自己验一遍。",
					evidence: ["[101] 这样挺好", "[133] 你自己跑过了吗"],
					confidence: "high",
					evidenceQuoteCount: 2,
					lastEvidenceMessages: 148,
				},
				// 新 id → 1 处（新增）
				{
					id: "n1",
					category: "A",
					claim: "用户使用中文交流，技术术语保留英文原文。",
					evidence: ["[140] 这个 tool call 是啥"],
					confidence: "medium",
					evidenceQuoteCount: 1,
					lastEvidenceMessages: 148,
				},
			];
			return {
				ok: true,
				contract: 1,
				preview: true,
				mode: "auto",
				customText: "",
				autoExtraText: "",
				profile: {
					version: 7,
					generatedAt: Date.now() - 3600 * 1000,
					provider: "preview",
					model: "preview",
					evidenceMessages: 148,
					notes: "预览数据：复制之后改了 3 处（改写 2 条、新增 1 条）。",
					raw: "",
					entries: currentEntries,
				},
				profileCapacity: {
					entries: currentEntries.length,
					softCap: 44,
					saturated: false,
					zeroChangeStreak: 0,
				},
				copiedSnapshot: {
					text: null,
					at: Date.now() - 7200 * 1000,
					profileVersion: 6,
					entries: baselineEntries,
					algorithmVersion: "memory-ids-v1",
				},
				revision: {
					status: "dirty",
					count: 3,
					added: currentEntries.filter(entry => entry.id === "n1"),
					removed: [],
					modified: ["b1", "c1"].map(id => ({
						before: baselineEntries.find(entry => entry.id === id),
						after: currentEntries.find(entry => entry.id === id),
					})),
					baselineAt: Date.now() - 7200 * 1000,
					baselineProfileVersion: 6,
				},
				lastGeneration: { at: Date.now() - 3600 * 1000, humanMessages: 148, sessions: 9 },
				lastSignals: {
					totals: {
						sessions: 9,
						humanMessages: 148,
						delegateRuns: 3,
						longTools: 5,
						repeatFailures: 2,
						freeformAnswers: 4,
						unpairedToolResults: 1,
					},
				},
				lastRun: {
					at: Date.now() - 3600 * 1000,
					ok: true,
					reason: "新增真人发言 20 >= 12",
					error: null,
					spuriousRate: 0.05,
					diff: null,
				},
				running: false,
				effectiveText: "",
			};
		}

