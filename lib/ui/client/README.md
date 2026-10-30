# 设置页 bundle 的源码

`lib/ui/client.js` 是宿主直接加载的桌面端设置页（手写的 `__ModuleLoader__` bundle，没有构建步骤）。
3000 多行放一个文件不好改，所以源码拆在这个目录，按文件名顺序拼成 `client.js`，拼出来的文件提交进仓库：

    node tools/build-client.mjs          # 拼接并写入 lib/ui/client.js
    node tools/build-client.mjs --check  # 只检查提交的 client.js 是不是最新

每个 `*.part.js` 是同一个函数体里的一截，单独不是合法的 JS，所以编辑器会报语法错，这是正常的。
`test/client-build.mjs` 会检查提交的 `client.js` 和分段拼出来的结果逐字节相同。

| 分段 | 内容 |
|---|---|
| 00-head | 文件头说明、加载器开头、`require` |
| 10-constants | 常量（命名空间、API 路径、分类标题、色调） |
| 20-copy-zh / 21-copy-en | 中英文案（两边 key 必须一一对应，测试检查） |
| 30-style | 样式（只用 `--dsw-*` token，不写颜色字面量） |
| 40-preview | 读不到宿主时用户点击才载入的预览数据 |
| 50-store | 客户端 store：轮询、请求、动作 |
| 60-utils | 小工具 |
| 70-entry-components | 条目、置顶 / 封印 / 删除按钮、折叠区 |
| 71-notice-signals | 修订提示（“复制之后改了几处”，数据来自宿主）和四个计数信号 |
| 80–85-section-* | 画像页本体（`AdaptSection`）：状态、首跑进度与注入、处置区、状态条与模式选择、模式 1 面板、模式 2 与权限 |
| 90-entry | 插件入口与导出 |

新增分段的文件名要像 `75-xxx.part.js`（两位序号、小写字母数字和连字符），序号决定拼接顺序。
