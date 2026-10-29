# Pi Agents

## Pi

```sh
pi install npm:@caho1/pi-agents
```

已验证 Pi SDK 1.4。首次调用工具时，扩展启动共享本地服务；会话结束后服务继续运行。启动 Pi 前可设置 `PI_SUBAGENTS_PORT` 选择端口。`PI_SUBAGENTS_DATA` 仅在启动新服务时决定数据目录；已运行的服务继续使用原目录。不同端口应使用不同数据目录。模型凭据保留在 Pi 配置中。

## Codex

```sh
npm install -g @caho1/pi-agents
pi-subagents-server
```

在另一个终端通过同一 npm 包安装插件：

```sh
codex plugin marketplace add "$(npm root -g)/@caho1/pi-agents/codex-plugin"
codex plugin add pi-subagents@pi-subagents-local
```

插件连接 `http://127.0.0.1:7788/mcp`。使用 Codex 时保持服务运行。Pi 和 Codex 按各自的会话或线程 ID 隔离。npm 可能自动安装较新版本的 Pi peer，当前仅验证 SDK 1.4。尚未验证 Windows 和 Pi 二进制宿主。
