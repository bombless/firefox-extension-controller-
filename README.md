# Chromium 扩展 + HTTP 控制（不走 Selenium）

你说的架构：**LLM 决策 + HTTP 原子能力**。

## 目录
- `manifest.json` / `background.js`：Chromium Manifest V3 扩展
- `offscreen.html` / `offscreen.js`：后台轮询本地 HTTP 桥，避免 MV3 service worker 休眠后无法持续拉命令
- `bridge-server.js`：本地 HTTP 桥（127.0.0.1:9230）
- `control.html`：可选手动调试页面

## 1) 加载扩展
1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 打开右上角“开发者模式”
3. 点“加载已解压的扩展程序”
4. 选择本目录 `51job-extension`
5. 点扩展图标可打开 `control.html`（可选）

## 2) 启动 HTTP 桥
```bash
cd 51job-extension
node bridge-server.js
```

## 3) 调用示例
```bash
# 健康
curl -s http://127.0.0.1:9230/health

# 当前激活标签页信息
curl -s http://127.0.0.1:9230/status

# 获取当前页内容（返回 JSON）
curl -s http://127.0.0.1:9230/content

# 获取当前页渲染完成后的 DOM 序列化 HTML（直接返回 text/html，可传 waitMs/stableMs/timeoutMs）
curl -s http://127.0.0.1:9230/html > rendered.html

# 获取当前页渲染完成后的 DOM 树 JSON（可传 maxNodes/maxDepth/maxTextLen）
curl -s 'http://127.0.0.1:9230/dom?maxNodes=4000'

# 打开页面
curl -s 'http://127.0.0.1:9230/open?url=https://we.51job.com/pc/search?jobArea=030200&keyword=java'

# 点击元素（selector）
curl -s 'http://127.0.0.1:9230/click?selector=.el-pager%20.number'

# 执行 JS（建议走 POST /call，避免URL编码）
curl -s -X POST http://127.0.0.1:9230/call \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"eval","params":{"script":"return document.title"}}'

# 查询抓取记录（内存，进程退出即清空）
curl -s http://127.0.0.1:9230/record
```

## 说明
- 扩展的 offscreen 后台页每 ~700ms 轮询桥服务器拉取命令并执行。
- 扩展只提供原子能力：`status/content/html/dom/open/click/eval`。
- “下一页判断”由 LLM 在外部完成。
- 在 `we.51job.com/pc/search` 页面，`/content` 会优先返回结构化职位列表（`records`，每条含 `url/companyName/area/salaryRange`）。
- 在 `https://we.51job.com/pc/search?` 页面会显示左上角“抓取”“抓取下一页”“抓取前50页”按钮。
- “抓取下一页”会优先点当前页码+1（没有当前页时尝试页码2），再自动执行抓取。
- “抓取前50页”会持续执行“抓取下一页”，直到没有下一页或已经抓取50页。
- 点击“抓取”后，扩展会解析当前页面职位信息并 `POST /record` 存入桥服务内存。
- 记录字段：`url`、`companyName`、`area`、`salaryRange`（`url` 去掉 query/hash）。
- 去重键为 `url`（不含查询串）；服务进程重启后记录会清空。
