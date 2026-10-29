# Pi Agent Swarm

[English](https://github.com/Caho1/codex-pi-subagents/blob/main/README.md) | [简体中文](https://github.com/Caho1/codex-pi-subagents/blob/main/README.zh-CN.md)

Pi Agent Swarm 为 [Codex](https://github.com/openai/codex) 和 [Pi](https://pi.dev) 提供多模型 AI 子智能体。本地 MCP 服务使用 Pi 已配置的模型并行运行 agent，保存会话，并提供 Web 面板。一个 npm 包包含 Pi 扩展、Codex 插件、服务和面板。

![Pi Agent Swarm 面板展示两个演示子智能体](https://raw.githubusercontent.com/Caho1/codex-pi-subagents/main/docs/panel-preview.jpg)

截图使用离线演示模型和示例数据。

## 功能

- **为每个 agent 选择模型。** 使用 Pi 配置中可用的模型，包括已配置的自定义 provider。每个 agent 都可以设置工作目录、thinking 等级和工具预设。
- **在 Codex 和 Pi 中委派任务。** 两个客户端使用同一套七个工具和本地服务。包内提供 Codex 插件、Pi 扩展和委派 skill。
- **并行执行独立任务。** 分别启动多个 agent，然后等待全部完成，或等待第一个完成。
- **在面板中查看工作。** 在 [http://127.0.0.1:7788](http://127.0.0.1:7788) 查看 agent 状态、回答和工具活动。也可以停止运行中的 agent，或为新 agent 选择默认模型。使用 `pi_get_agent` 可查看 token 用量和费用。
- **继续已有 agent。** 会话和结果保存在本地。agent 完成后，追问会重新打开原会话并重连所需资源，保留已有上下文。
- **使用 Pi 工具。** `coding` 预设使用 Pi 配置的扩展和 MCP 服务，项目资源受 Pi 信任设置约束。`read-only` 预设只提供 `read`、`grep`、`find`、`ls`，不加载扩展或 MCP 工具。

## 环境要求

- Node.js 22.19 或更高版本。
- 已安装 Pi，并配置至少一个模型及其凭据。参见 [Pi 文档](https://pi.dev/docs/latest)。
- 如需使用 Codex 插件，还需要安装 Codex。

目前已在 macOS 上使用 Pi SDK 1.4 测试。Windows 和独立 Pi 二进制宿主尚未验证。通过 npm 全局安装时，npm 可能解析到更新的 Pi SDK peer 依赖。

## 安装

### Pi

```sh
pi install npm:@caho1/pi-agent-swarm
```

启动或重新加载 Pi，然后让它委派任务。首次调用工具时，如果没有兼容的服务在运行，扩展会启动本地服务。Pi 会话结束后服务继续运行。安装 Pi 扩展不会自动安装 Codex 插件。

### Codex

安装包并启动服务：

```sh
npm install -g @caho1/pi-agent-swarm
pi-subagents-server
```

在另一个终端从同一个包安装 Codex 插件：

```sh
codex plugin marketplace add "$(npm root -g)/@caho1/pi-agent-swarm/codex-plugin"
codex plugin add pi-subagents@pi-subagents-local
```

使用插件时保持服务运行。修改插件配置后重启 Codex。插件连接到 `http://127.0.0.1:7788/mcp`，并包含指导委派的 skill。

Codex 使用插件的 MCP 工具时可能要求审批。如需默认批准这些调用，可在 `~/.codex/config.toml` 添加：

```toml
[plugins."pi-subagents@pi-subagents-local".mcp_servers.pi-subagents]
default_tools_approval_mode = "approve"
```

这会改变该插件的 MCP 工具审批方式。如果希望逐次审批，不要添加这项配置。

## 从 `@caho1/pi-agents` 升级

Codex 插件名、MCP 地址和 agent 数据目录（`~/.codex-pi-subagents`）保持不变。升级前停止旧服务，完成后重新启动 `pi-subagents-server`。

如果之前在 Pi 中安装了旧包，请替换 Pi 的包配置：

```sh
pi remove npm:@caho1/pi-agents
pi install npm:@caho1/pi-agent-swarm
```

如果 Codex 插件来自全局安装的旧 npm 包，请替换插件市场来源和 npm 包：

```sh
codex plugin marketplace remove pi-subagents-local
npm uninstall -g @caho1/pi-agents
npm install -g @caho1/pi-agent-swarm
codex plugin marketplace add "$(npm root -g)/@caho1/pi-agent-swarm/codex-plugin"
codex plugin add pi-subagents@pi-subagents-local
```

修改插件配置后重启 Codex。新旧 npm 包提供相同的可执行命令，安装新包前请先卸载全局安装的旧包。

## 配置模型

Pi Agent Swarm 使用 Pi 的 provider 和凭据配置。例如，Pi 的 DeepSeek provider 会从服务的环境变量中读取 `DEEPSEEK_API_KEY`：

```sh
export DEEPSEEK_API_KEY="your-api-key"
pi-subagents-server
```

请在启动服务或 Pi 之前设置环境变量。其他 provider 和自定义端点参见 Pi 的 [provider 文档](https://pi.dev/docs/latest/providers)和[模型配置文档](https://pi.dev/docs/latest/models-configuration)。调用 `pi_list_models` 可查看服务中可用的模型 ID。

## 试用

在 Codex 或 Pi 中，可以让两个 agent 分别检查代码：

```text
请用两个 Pi 子智能体并行审查这个仓库。一个检查正确性问题，另一个检查
测试覆盖。给每个 agent 提供完整任务，使用只读工具，等待两者完成后汇总结果。
```

也可以在请求中指定可用的 `provider/model`。例如，如果 Pi 中已经配置并启用了该模型，可以使用 `magpie/auto/GLM-5.3-Flash`。不确定模型 ID 时，可以让父 agent 调用 `pi_list_models` 查询。

打开工具结果返回的面板地址查看进度。面板展示所有本地 agent；Codex 和 Pi 的工具调用按各自的对话或会话 ID 过滤。

## 工具

| 工具 | 用途 |
| --- | --- |
| `pi_list_models` | 列出 Pi 中可用的模型。 |
| `pi_spawn_agent` | 启动 agent，可指定任务、模型、工作目录、thinking 等级、名称和工具预设。 |
| `pi_wait` | 等待指定 agent 全部完成，或等待第一个完成。默认超时 120 秒，最长 240 秒。 |
| `pi_get_agent` | 查看 agent 状态、最近回答和日志。 |
| `pi_send_followup` | 在现有会话上下文中继续追问。运行期间收到的消息会排队。 |
| `pi_abort` | 停止运行中的 agent。 |
| `pi_list_agents` | 列出当前 Codex 对话或 Pi 会话所属的 agent。 |

`pi_wait` 返回最近一条回答。多次追问后，可用 `pi_get_agent` 查看之前的日志。中止或失败的 agent 需要进一步检查，不能直接视为已完成。

## 配置和数据

服务默认监听 `127.0.0.1:7788`。agent 索引、会话 JSONL 文件和面板默认模型保存在 `~/.codex-pi-subagents`。

独立启动服务时，可按需使用 `--port`、`--host`、`--data`、`--allow-host`、`--stdio` 和 `--faux` 参数。也可以通过 `PI_SUBAGENTS_PORT` 和 `PI_SUBAGENTS_DATA` 设置端口和数据目录。例如：

```sh
pi-subagents-server --port 7789 --data "$HOME/.codex-pi-subagents-demo"
```

对于由 Pi 自动启动的服务，请在启动 Pi 前设置环境变量。`PI_SUBAGENTS_DATA` 只影响新启动的服务，不会改变已有服务的数据目录。不同端口上的服务应使用不同数据目录。内置 Codex 插件使用 7788 端口；使用其他端口时，请手动配置 MCP。

如需使用其他端口，可在 `~/.codex/config.toml` 中添加 MCP 服务配置：

```toml
[mcp_servers.pi-subagents]
url = "http://127.0.0.1:7789/mcp"
tool_timeout_sec = 300
```

手动配置 MCP 不会安装委派 skill。请在提示词或 `AGENTS.md` 中告诉 Codex 使用 Pi 工具。

使用自定义主机名时，可添加 `--allow-host example.local`。Host 和 Origin 检查用于限制浏览器请求，不能代替客户端认证。

## 安全和当前限制

- 服务和面板没有身份认证。请保持本地监听，不要暴露给不可信客户端或公网。面板可以显示本机所有对话的 agent。
- 对话和会话 ID 用于限定 MCP 操作范围，但不是身份认证机制。
- Pi 子智能体不继承 Codex 沙箱。默认的 `coding` 预设可以修改文件和运行工具。对于不应修改文件的评审，请使用 `read-only`。
- agent 不会自动获得父会话内容。请在每个任务中提供目标、上下文、约束和预期结果。
- 省略 `cwd` 时，Pi 会填入当前项目目录。直接调用 MCP 时则默认使用服务的工作目录，因此 Codex 任务应指定绝对 `cwd`。
- 并行 agent 会共享各自指定的工作目录。本项目目前不会为它们自动创建独立 Git worktree。
- Codex 通过 `pi_wait` 等待；agent 完成时服务不会主动唤醒 Codex。
- 没有对话 ID 的旧 agent 仍可在面板中查看，但不会通过按对话隔离的 MCP 工具暴露。

## 常见问题

- **没有可用模型。** 检查 Pi 的模型和凭据配置，然后重新调用 `pi_list_models`。离线演示模型仅在服务启用 `--faux` 且调用时传入 `include_faux: true` 后显示。
- **Codex 插件无法连接。** 确认 `pi-subagents-server` 正在 7788 端口运行，并在安装插件后重启 Codex。
- **Pi 工具无法启动服务。** 检查配置的端口是否被占用。Pi 扩展会复用兼容的服务，并拒绝连接占用该端口的其他服务。
- **agent 找不到项目扩展。** 检查 Pi 的项目可信设置。`read-only` 预设不会加载扩展或 MCP 工具。

## 使用问答

### Codex 可以用 Pi 中的模型运行子智能体吗？

可以。启动本地 MCP 服务并安装包内的 Codex 插件。每个 agent 都可以使用 Pi 配置中可用的模型。

### 多个 agent 可以同时使用不同的模型吗？

可以。启动每个 agent 时分别指定 `model`，这些模型需要在 Pi 配置中可用。

### 不使用 Codex 时可以单独在 Pi 中使用吗？

可以。使用 `pi install` 安装后，即可在 Pi 中使用该扩展。需要时首次调用工具会启动本地服务。

### agent 会在 Codex 沙箱中运行吗？

不会。Pi agent 使用 Pi 的工具权限。不应修改文件的任务可使用 `read-only`。项目不会自动创建独立的 Git worktree。

## 从源码开发

```sh
git clone https://github.com/Caho1/codex-pi-subagents.git
cd codex-pi-subagents
npm install
npm start
```

如需离线测试，先用 `npm start -- --faux` 启动服务，再对该服务运行冒烟测试：

```sh
SMOKE_FAUX=1 npm run smoke -- /path/to/project
npm run check
npm test
```

冒烟测试会读取所选工作目录中的 `README.md`。构建和检查 npm 包的步骤见[发布说明](https://github.com/Caho1/codex-pi-subagents/blob/main/packages/RELEASING.md)。

### 仓库结构

| 路径 | 作用 |
| --- | --- |
| `src/main.ts` | HTTP 服务、MCP 端点、面板和事件。 |
| `src/manager.ts` | Pi 会话、agent 状态、追问和持久化。 |
| `src/pi-runtime.ts` | Pi SDK 会话和扩展初始化。 |
| `src/mcp.ts` | MCP 工具定义。 |
| `src/panel.html` | 本地 Web 面板。 |
| `src/codex-avatars.js`、`src/codex-icons.js` | 从本机 Codex bundle 提取的头像和图标资产。 |
| `src/faux.ts` | 离线演示 provider。 |
| `packages/pi/` | npm 包配置、Pi 扩展和 skill。 |
| `codex-plugin/` | Codex 插件和本地 marketplace。 |
| `scripts/` | 打包和验证脚本。 |

## 许可证

[MIT](https://github.com/Caho1/codex-pi-subagents/blob/main/LICENSE)。

仓库包含从本机 Codex bundle 提取的素材及 OpenAI Sans 字体，其再分发条款尚未核实。
