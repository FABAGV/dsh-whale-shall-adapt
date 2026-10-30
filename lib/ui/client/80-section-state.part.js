		/**
		 * 设置页主体。
		 *
		 * props 由框架组合而成：`close` 来自 settings.section 的 owner props，
		 * `t` / `actions` / `useAdapt` 来自本插件的 inject 面。
		 *
		 * @param {object} props
		 * @returns {object}
		 */
		function AdaptSection(props) {
			const t = props.t;
			const actions = props.actions;
			const snap = props.useAdapt(value => value);
			const serverState = snap.state || {};
			const status = snap.phase;

			const [draft, setDraft] = react.useState("");
			const [draftTouched, setDraftTouched] = react.useState(false);
			const [pendingMode, setPendingMode] = react.useState(null);
			const [fillConfirm, setFillConfirm] = react.useState(false);
			const [copiedFlash, setCopiedFlash] = react.useState(false);
			const [copyError, setCopyError] = react.useState(false);
			const dirtyRef = react.useRef(false);
			const textareaId = react.useId();
			/** 把 QQ 会话改成「完全」之前的确认：`{kind, tier}` 或 null。 */
			const [pendingTier, setPendingTier] = react.useState(null);
			const [consoleLink, setConsoleLink] = react.useState(null);
			const [consoleBusy, setConsoleBusy] = react.useState(false);

			const serverCustomText =
				typeof serverState.customText === "string" ? serverState.customText : "";

			// 宿主值变化时同步草稿——除非用户正在编辑（有未保存修改）。
			react.useEffect(() => {
				if (dirtyRef.current) return;
				setDraft(serverCustomText);
			}, [serverCustomText]);

			react.useEffect(() => {
				// 挂载时拉一次。store 的初始相位就是 loading，以前这里只在 ready/error 时才拉，
				// 于是第一次打开设置页会一直停在「正在读取宿主状态…」。轮询由 store 自己管。
				if (snap.preview) return;
				actions.refresh();
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			react.useEffect(() => {
				if (!copiedFlash) return undefined;
				const timer = setTimeout(() => setCopiedFlash(false), 1800);
				return () => clearTimeout(timer);
			}, [copiedFlash]);

			// flash（错误横幅）必须会自己消失。见 FLASH_AUTO_DISMISS_MS 的注释：
			// store 没有任何清它的路径，所以清的责任在界面这边。
			react.useEffect(() => {
				if (!snap.flash) return undefined;
				const timer = setTimeout(() => actions.clearFlash(), FLASH_AUTO_DISMISS_MS);
				return () => clearTimeout(timer);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [snap.flash]);

			const profile = serverState.profile || null;
			// 过滤掉非对象条目：宿主的 profile.entries 是外部数据，
			// 里面混进一个 null 就会在下面 `entry.category` 那里抛 TypeError，
			// 把整个设置页打挂（实测：Cannot read properties of null）。
			const entries =
				profile && Array.isArray(profile.entries)
					? profile.entries.filter(entry => entry && typeof entry === "object")
					: [];
			// 宿主给的容量摘要（老宿主 / 预览数据没有这个字段 → null，不显示提示）。
			const capacity =
				serverState.profileCapacity && typeof serverState.profileCapacity === "object"
					? serverState.profileCapacity
					: null;
			const mode = serverState.mode === "custom" ? "custom" : "auto";
			const isAuto = mode === "auto";
			const customHasText = serverCustomText.trim().length > 0;

