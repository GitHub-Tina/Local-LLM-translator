# Local LLM Translator（Chrome 扩展）

用**本地大模型**翻译网页的 Chrome MV3 扩展。所有请求只发往你本机的推理后端
（Ollama / llama.cpp / LM Studio / 任何 OpenAI 兼容服务），数据不出本机。

> 设计参考并致谢 [offline-browser-translate](https://github.com/Eldoprano/offline-browser-translate)
> （本项目为独立重写实现：批量翻译协议、容错解析、优先级调度、两层缓存等架构思想源自该项目，
> 代码全部重写，另新增了段落对照显示模式与按字符数组批等改进）。

## 功能

- **多后端**：Ollama（`/api/generate` + JSON Schema 约束）、OpenAI 兼容（llama.cpp / LM Studio / vLLM，
  `response_format: json_schema`，老服务器自动降级）；自动探测、自动选模型
- **整页翻译**：右键菜单 / 弹窗按钮；视口内、正文区、标题优先翻译，滚动时动态重排优先级
- **两种显示方式**：原位替换 / 段落对照（原文下方插入带竖线的译文段）
- **选中文本翻译**：右键「翻译选中文字」
- **批量 + 并发**：按"条数 + 字符数"双约束组批，并发数可调（默认 3）
- **抗畸形输出**：JSON 解析 → 内嵌 JSON 提取 → `[id]:` 标记解析 → 行对齐（行数不符即拒收）；
  截断响应丢弃半句；可疑译文拒收保原文；批量失败逐条纯文本兜底
- **动态内容**：翻译后自动翻译无限滚动等新增内容（可关）
- **译文缓存**：内存 + IndexedDB 两层；不缓存 / 会话级 / 持久三种模式，相同文本只翻一次
- **自动翻译**（默认关）：页面声明语言 ≠ 目标语言时自动翻译，支持按语言/站点排除
- **特殊模型**：自动识别 TranslateGemma / Hunyuan-MT 并切换为其官方提示词格式

## 安装（开发者模式加载）

1. 打开 Chrome → `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」→ 选择本目录（`G:\Projects\Local LLM Translator`）
4. （可选）固定到工具栏

## 使用

### 1. 启动本地后端（任选其一）

```bat
:: llama.cpp（OpenAI 兼容，默认 http://127.0.0.1:8080/v1）
cd C:\SoftWare\tools\llama.cpp
llama-server.exe -m F:\AI\Models\GGUF\local\qwen2.5-7b\qwen2.5-7b.gguf -ngl 99 -c 8192 -fa --jinja --host 127.0.0.1 --port 8080

:: Ollama（默认 http://127.0.0.1:11434）
ollama serve
ollama pull qwen2.5:7b

:: LM Studio（默认 http://127.0.0.1:1234）：启动 Server 并加载模型
```

> Ollama 若报 403/CORS：设置环境变量 `OLLAMA_ORIGINS=chrome-extension://*` 后重启 Ollama。

### 2. 翻译

- 点扩展图标 → 确认模型已自动选中 → 点「**翻译网页**」
- 或在页面/选中文本上右键 → 「翻译整页（本地 LLM）」/「翻译选中文字（本地 LLM）」
- 右下角胶囊显示进度，可最小化、可停止；翻译后可一键「还原」
- 弹窗里可切换目标语言与显示方式（替换 / 段落对照）

### 3. 推荐

- 模型：`qwen2.5:7b` 起步（快）；`qwen3-14b` / `qwen38-27b` 更准更慢
- 并发：llama.cpp 未开多槽（`-np`）时并发>1 只会在服务端排队，无实际收益
- 每批字符上限 1200 适合 8K 上下文；`num_ctx` 不足时译文会截断丢条（自动重试兜底）

## 目录结构

```
manifest.json        MV3 清单
textutils.js         纯函数：分句/提示词拼装/响应容错解析（background 与 content 共用，可单测）
languages.js         语言表、模型->请求格式规则、宿主权限工具
cache.js             译文缓存：内存 Map + IndexedDB，容量软上限按时间淘汰
background.js        服务工作者：后端探测/模型列表/批量翻译管线/消息路由/右键菜单
content.js           页面端：DOM 采集、优先级调度、替换/双语对照、进度组件、动态内容
popup/               弹窗（模型/语言选择、翻译控制、快捷设置）
options/             完整设置页
icons/               图标（tools/make_icons.py 生成）
test/                Node 测试（无浏览器依赖）
```

## 测试

```bash
node test/test-textutils.js     # 33 项纯函数单测（分句 / 解析 / 清洗）
node test/test-background.js    # 24 项沙箱 E2E：chrome.* 桩 + mock OpenAI 服务器（自动拉起）
node test/test-real-model.js    # 13 项真实模型 E2E（需先启动 llama-server 于 18090，见下）
node test/test-browser-e2e.js   # 9 项真实浏览器 E2E：Edge + CDP 全链路（注入->翻译->还原->双语对照）
```

后两项需要先启动本地模型：

```bat
cd C:\SoftWare\tools\llama.cpp
llama-server.exe -m F:\AI\Models\GGUF\local\qwen2.5-7b\qwen2.5-7b.gguf -ngl 99 -c 8192 -fa on --jinja --host 127.0.0.1 --port 18090
```

`test-background.js` 覆盖：正常翻译、散文包裹 JSON、首次垃圾输出重试、丢条兜底、
schema 拒绝降级、缓存去重、安装时自动选模型等路径。
`test-browser-e2e.js` 用 `--load-extension` 启动真实 Chromium 并通过 CDP 驱动
service worker（注意：**Chrome 稳定版 137+ 已移除 `--load-extension`**，脚本默认用
Edge；手动在 `chrome://extensions` 加载扩展不受影响）。

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 保存设置与缓存 |
| `activeTab` + `scripting` | 点击翻译时向当前页注入 content script |
| `contextMenus` | 右键菜单 |
| `http://localhost/*`、`http://127.0.0.1/*`（宿主） | 访问本地推理后端；远程地址保存时按源申请 |
| `<all_urls>`（可选，默认不授） | 仅在开启「打开外语页面自动翻译」时申请 |

## 已知限制 / 路线图

- 段落对照模式下「还原后切回译文」不可廉价重建（会提示重新翻译）
- 无术语表（glossary）、无划词浮动按钮 —— 计划参考上游项目补齐
- iframe 内文本不翻译（避免成倍请求）
