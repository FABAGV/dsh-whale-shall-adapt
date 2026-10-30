		// ====================================================================
		// 小工具
		// ====================================================================

		/**
		 * 时间戳 → 本地可读串。
		 * @param {number|string|null} value
		 * @param {string} emptyText
		 * @returns {string}
		 */
		function formatTime(value, emptyText) {
			if (value === null || value === undefined || value === "") return emptyText;
			const date = new Date(typeof value === "number" ? value : Date.parse(value));
			if (Number.isNaN(date.getTime())) return emptyText;
			const pad = number => String(number).padStart(2, "0");
			return (
				date.getFullYear() +
				"-" +
				pad(date.getMonth() + 1) +
				"-" +
				pad(date.getDate()) +
				" " +
				pad(date.getHours()) +
				":" +
				pad(date.getMinutes())
			);
		}

		/**
		 * 复制文本到剪贴板。优先 Clipboard API，失败退回临时 textarea。
		 * @param {string} text
		 * @returns {Promise<boolean>}
		 */
		async function copyToClipboard(text) {
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch (error) {
				/* 退回落旧方案 */
			}
			try {
				const area = document.createElement("textarea");
				area.value = text;
				area.setAttribute("readonly", "readonly");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand && document.execCommand("copy");
				document.body.removeChild(area);
				return !!ok;
			} catch (error) {
				return false;
			}
		}

