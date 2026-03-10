# Firefox 扩展 + HTTP 控制（不走 Selenium）

你说的架构：**LLM 决策 + HTTP 原子能力**。

## 目录
- `manifest.json` / `background.js`：扩展（运行在你自己的 Firefox）
- `bridge-server.js`：本地 HTTP 桥（127.0.0.1:9230）
- `control.html`：可选手动调试页面

## 1) 加载扩展
1. 打开 `about:debugging#/runtime/this-firefox`
2. 临时加载 `manifest.json`
3. 点扩展图标可打开 `control.html`（可选）

## 2) 启动 HTTP 桥
```bash
cd firefox-extension-controller
node bridge-server.js
```

## 3) 调用示例
```bash
# 健康
curl -s http://127.0.0.1:9230/health

# 当前激活标签页信息
curl -s http://127.0.0.1:9230/status

# 获取当前页内容
curl -s http://127.0.0.1:9230/content

# 打开页面
curl -s 'http://127.0.0.1:9230/open?url=https://we.51job.com/pc/search?jobArea=030200&keyword=java'

# 点击元素（selector）
curl -s 'http://127.0.0.1:9230/click?selector=.el-pager%20.number'

# 执行 JS（建议走 POST /call，避免URL编码）
curl -s -X POST http://127.0.0.1:9230/call \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"eval","params":{"script":"return document.title"}}'
```

## 说明
- 扩展每 ~700ms 轮询桥服务器拉取命令并执行。
- 扩展只提供原子能力：`status/content/open/click/eval`。
- “下一页判断”由 LLM 在外部完成。
