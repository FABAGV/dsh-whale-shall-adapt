		// ====================================================================
		// 常量
		// ====================================================================

		/** 文案命名空间。 */
		const NS = "shall";

		/** 宿主 HTTP 契约的基路径（prefix 路由）。 */
		const API_PATH = "/shall/api";

		/**
		 * 单次宿主请求的硬超时。
		 *
		 * 桌面壳跨源路径断掉时，浏览器可能既不 resolve 也不 reject（fetch 挂在
		 * 预检/协议层），页面就永远停在"正在读取宿主状态…"——用户看不到错误，
		 * 也点不了重试。8 秒足够覆盖本机 /state 与 202 立即返回的写操作。
		 */
		const REQUEST_TIMEOUT_MS = 8000;


		/** 宿主 `renderProfileText` 用的四个分类标题，用于把纯文本快照解析回条目。 */
		const CATEGORY_TITLES = {
			A: "稳定特质",
			B: "行不通的做法",
			C: "有效的做法",
			D: "证据不足（不下结论）",
		};

		/** 分类展示顺序。D 单独折叠——它对模型没有约束力（见宿主 renderProfileText）。 */
		const CATEGORY_ORDER = ["A", "B", "C"];
		const CATEGORY_EXTRA = "D";



		/** 分类 → 界面上用哪个 token 做重音（全部是 token 名，不是颜色值）。 */
		const CATEGORY_TONE = {
			A: "toneA",
			B: "toneB",
			C: "toneC",
			D: "toneD",
		};

