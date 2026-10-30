		// ====================================================================
		// 插件入口
		// ====================================================================

		/** 需要的客户端服务。与 ui-settings-plugins 的写法一致。 */
		const inject = ["slots", "locale"];

		/**
		 * 浏览器半边入口。
		 * @param {object} ctx 客户端 cordis 上下文
		 */
		function apply(ctx) {
			const tr = ctx.locale.bind(NS);

			ctx.effect(
				() => ctx.locale.register(NS, "zh", zh),
				"shall: zh dictionary",
			);
			ctx.effect(
				() => ctx.locale.register(NS, "en", en),
				"shall: en dictionary",
			);

			const store = createAdaptStore(ctx);
			ctx.effect(() => () => store.dispose(), "shall: client store");

			// slots.inject：等 settings.section 这个槽位被声明后再注册。
			// 用 inject 而不是直接 register，是因为声明归属外壳插件
			// （ui-settings-general），插件加载顺序不保证；
			// 直接 register 到未声明的槽位会 fail-loud 抛错。
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "shall",
						order: 40,
						// label 用 thunk：每次读都跟随当前语言，无需重新注册。
						label: () => tr("nav"),
						// inject 面：t / actions 原样透传；hooks.adapt 变成组件的 useAdapt 选择器 Hook。
						inject: () => ({
							t: tr,
							actions: store.actions,
							hooks: { adapt: store.source },
						}),
					},
					AdaptSection,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		/**
		 * 仅供测试（test/client-marks-render.mjs）做冒烟用。
		 * 不属于 DSH 的插件契约，宿主与其它插件都不应依赖它。
		 */
		exports.__internals = {
			CATEGORY_TITLES,
			serializePortrait,
			buildPreviewState,
			resolveApiBase,
		};
		return module.exports;
	},
});
