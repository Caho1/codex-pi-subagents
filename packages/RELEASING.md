# npm 发布准备

仓库根目录是私有开发工程，`packages/pi` 定义唯一发布包。发布前确认面板素材及 OpenAI Sans 字体允许重新分发。

使用 Node.js 22.19 或更高版本安装依赖并检查：

```sh
npm install
npm run check
npm test
node scripts/build-package.mjs /tmp/pi-subagents-release
npm pack /tmp/pi-subagents-release --dry-run
```

在两个空目录中安装打包结果，分别验证 Pi 的 peer 依赖和 Codex 插件。以下文件名对应 `0.1.0`，升级版本后请替换：

```sh
npm pack /tmp/pi-subagents-release --pack-destination /tmp/pi-subagents-release
npm install --legacy-peer-deps --prefix /tmp/pi-agents-pi-check /tmp/pi-subagents-release/caho1-pi-agents-0.1.0.tgz
npm install --prefix /tmp/pi-agents-codex-check /tmp/pi-subagents-release/caho1-pi-agents-0.1.0.tgz
node scripts/verify-package.mjs /tmp/pi-agents-pi-check
node scripts/verify-package-proxy.mjs /tmp/pi-agents-pi-check
python3 scripts/verify-codex-install.py /tmp/pi-agents-codex-check/node_modules/@caho1/pi-agents
```

验证脚本使用隔离数据目录和本地模拟模型。Codex 验证需要安装 `codex` CLI；代理验证需要 `lsof` 和 `ps`。

检查打包清单和 npm 账号后发布：

```sh
npm login
npm whoami
npm publish /tmp/pi-subagents-release --access public
```

Pi 和 Codex 的安装说明见 [包说明](pi/README.md)。`pi-package` 关键字使包具备进入 Pi 包目录的条件，但不保证目录何时收录。
