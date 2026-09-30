# relay-node-template

VLESS-over-WebSocket 中继节点部署模板（零依赖 Node.js），给新平台用。
由 `relay-node-patr` 等项目的 `server.js` 整理而来，入口改为 `index.js`，
并把 UUID / WebSocket 路径改为环境变量配置，不再硬编码。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VLESS_UUID` | 客户端 UUID（可带横线）。未设置则启动时随机生成并打印到日志 | （随机生成） |
| `WS_PATH` | WebSocket 路径 | `/api/v1/<UUID 前 8 位 hex>` |
| `PORT` | 监听端口（多数平台会自动注入） | `8080` |
| `IP` | 监听地址 | `0.0.0.0` |

每个平台部署时使用**独立的 UUID**（设 `VLESS_UUID` 环境变量即可）。

## 部署

Docker 方式：

```dockerfile
# 已包含 Dockerfile，直接用即可
docker build -t relay-node .
docker run -e VLESS_UUID=<uuid> -p 8080:8080 relay-node
```

或平台原生 Node 部署：设置启动命令 `node index.js`（`npm start` 亦可），
并配置上述环境变量。

根路径 `/` 返回伪装的状态页，只有 `WS_PATH` 的 WebSocket 升级请求会被处理。

## 验证

部署后用 `verify_vless.py` 做真实 VLESS TCP 测试，只有输出
`RESULT: PASS` 才算成功。注意沙盒直连 443 可能被中间网络干扰，
验证时应经 egress HTTP 代理做 CONNECT 隧道。
