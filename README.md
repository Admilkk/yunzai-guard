<div align="center">

# Yunzai Guard

🛡️ **_TRSS-Yunzai / 玖璃的进程接管、行为审计与函数完整性防护插件_**

[![CI](https://github.com/Admilkk/yunzai-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Admilkk/yunzai-guard/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Admilkk/yunzai-guard?style=flat&logo=github)](https://github.com/Admilkk/yunzai-guard/releases)
[![License](https://img.shields.io/github/license/Admilkk/yunzai-guard?style=flat&logo=gnu)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D23.11-3C873A?style=flat&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue?style=flat)

</div>

---

Yunzai Guard 以独立插件形式运行，**不修改 Yunzai 核心与业务插件源码**。它接管 Yunzai 工作进程，在业务代码加载前安装监控，记录插件的网络、文件、子进程、原生扩展与关键函数变化，并按规则审计、拒绝或重建进程。

> [!IMPORTANT]
> 默认的 `managed` 模式与业务插件共享 JS 环境，用于**观察与审计**，不是针对恶意代码的安全边界。需要强隔离时请使用[系统隔离](docs/SANDBOX.md)。完整边界见[安全说明](SECURITY.md)。

## 安装 💡

**环境要求**：Windows x64 或 Linux x64、Node.js `>=23.11.0`，以及能正常启动的 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) 或 [玖璃（JiuLi）](https://github.com/HL-z7/JiuLi)。PM2 可选（`>=6.0.14`，fork 单实例）。

在 Yunzai 根目录**任选一种**方式安装：

<details open><summary>方式一：Git 安装（推荐，便于更新）</summary>

```sh
git clone --depth=1 --branch main https://github.com/Admilkk/yunzai-guard.git ./plugins/yunzai-guard
npm --prefix plugins/yunzai-guard ci --include=dev
```

`npm ci` 会自动编译运行入口与控制台面板，请保留开发依赖并允许安装脚本。

</details>

<details><summary>方式二：下载发布包（免编译）</summary>

从 [Releases](https://github.com/Admilkk/yunzai-guard/releases) 下载对应平台的包，解压为 `plugins/yunzai-guard`：

| 资产                               | 说明                                                       |
| ---------------------------------- | ---------------------------------------------------------- |
| `yunzai-guard-v*-win-x64.zip`      | Windows 包，**内置固定版本 Node 运行时**，首次启动无需下载 |
| `yunzai-guard-v*-linux-x64.tar.gz` | Linux 包                                                   |
| `node-v24.22.1-win-x64.exe`        | 独立 Node 运行时（可选，用法见下方）                       |
| `SHA256SUMS.txt`                   | 全部资产的 SHA-256 校验和                                  |

</details>

<details><summary>独立 Node 运行时（可选）</summary>

> [!NOTE]
> Windows 发布包已内置运行时，通常无需单独下载 EXE。

手动准备时，将 `node-v24.22.1-win-x64.exe` 重命名为 `node.exe`，放入 `plugins/yunzai-guard/runtime/node-v24.22.1-win-x64/`，Guard 启动时会自动识别并校验。

也可在 Yunzai 根目录通过 PowerShell 指定该运行时启动：

```powershell
& ".\plugins\yunzai-guard\runtime\node-v24.22.1-win-x64\node.exe" .\app.js
```

</details>

安装完成后照常启动：

```sh
node app.js
```

> [!NOTE]
> Windows 上 Guard 使用固定的官方 Node `24.22.1` 运行受控宿主，不更换系统 Node。依次使用发布包内置的 `runtime/` 副本、本地缓存，最后才从 nodejs.org 下载，三者都按固定 SHA-256 校验。

首次普通启动会交接给受管进程（PID 会变化），交接前的行为不在监控范围内。需要从核心入口前就建立监控时使用：

```sh
node plugins/yunzai-guard/dist/launcher.js
```

PM2 与 systemd 的用法见[运行环境](docs/ENVIRONMENTS.md)。

## 功能介绍 📖

<details><summary>行为审计与规则</summary>

- 默认 `audit`：空规则，只记录不拦截。
- 规则按顺序**第一条匹配生效**，支持全局与逐插件配置，动作为 `audit` / `deny` / `restart`。
- 审计事件脱敏后存入 `data/yunzai-guard/events.sqlite`（Node 内置 SQLite，无需额外数据库）。

| 类型       | 覆盖入口                                                                            |
| ---------- | ----------------------------------------------------------------------------------- |
| 网络访问   | `http(s)`、`http2`、`fetch`、`net`/`tls`、UDP、`WebSocket`、`EventSource`、DNS 查询 |
| 端口监听   | `net.Server#listen`、UDP 端口绑定                                                   |
| 文件访问   | fs 路径入口（回调、同步、Promise、流），默认记录修改类操作                          |
| 进程与线程 | `child_process` 全部入口、`Worker`，可识别的 Node 子进程继承监控                    |
| 原生扩展   | `process.dlopen` 加载记录与拒绝；内部读写与连接由系统层观察或系统隔离覆盖           |
| 系统层观察 | 宿主从进程外采样进程树的读写字节与外部 TCP 连接                                     |
| 插件调用   | 核心加载器的导入、实例化、方法调用与定时任务                                        |
| 函数变更   | 关键 Bot/加载器函数与业务模块导出函数的替换和 Hook                                  |

详见[监控说明](docs/MONITORING.md)。

</details>

<details><summary>Guard 自保护</summary>

- 工作进程内禁止经受控入口修改 Guard 目录、`data/yunzai-guard` 与运行时清单，业务规则无法关闭。
- 监控包装、反射入口与 Guard 自有函数加固，替换会被拒绝。
- 宿主独立校验控制消息签名与事件策略，不信任工作进程自报的动作。

</details>

<details><summary>Web 控制台</summary>

宿主启动后在终端打印地址（本机通常为 `http://127.0.0.1:21733/`），首次登录用终端中的一次性验证码。

- 插件权限：单独或批量配置。
- 事件审计：按插件、类型、动作、时间筛选，可从事件直接生成规则。
- 实时日志、配置应用状态与冲突提示、可信设备管理。

远程访问请使用 HTTPS 反向代理。

</details>

<details><summary>进程管理与隔离</summary>

- 宿主统一管理重启、崩溃恢复和熔断。
- 可选 Windows AppContainer / Linux bubblewrap 系统隔离，限制整个业务进程的文件与网络。
- 独立插件沙箱（实验功能）。

</details>

## 配置与命令 ⚙️

配置文件位于 Yunzai 根目录 `data/yunzai-guard/settings.json`，推荐通过控制台修改，保存后按字段自动生效（见[配置生效](docs/PERMISSIONS.md#配置生效)）。可从[默认配置示例](settings.example.json)开始。

```sh
node plugins/yunzai-guard/dist/cli.js status   # 查看状态
node plugins/yunzai-guard/dist/cli.js doctor   # 检查并准备依赖
node plugins/yunzai-guard/dist/cli.js restart  # 重建工作进程
node plugins/yunzai-guard/dist/cli.js resume   # 解除熔断
node plugins/yunzai-guard/dist/cli.js stop     # 停止
```

> [!TIP]
> 熔断时 PM2 仍可能显示 `online`，业务状态以 `status` 为准。PM2 开启自动重启时，持久停止请用 `pm2 stop <应用>`。

## 文档 📚

| 指南                                          | 内容                                     |
| --------------------------------------------- | ---------------------------------------- |
| [运行环境](docs/ENVIRONMENTS.md)              | 平台要求、普通启动、PM2 与 systemd       |
| [权限规则](docs/PERMISSIONS.md)               | 默认观察、全局和逐插件配置、配置生效方式 |
| [监控说明](docs/MONITORING.md)                | 覆盖入口、文件与原生扩展、完整性检查     |
| [系统隔离](docs/SANDBOX.md)                   | 整个工作进程的文件、网络与回收边界       |
| [独立插件沙箱](docs/NATIVE-PLUGIN-SANDBOX.md) | 实验功能、原路径数据和 Redis 授权        |
| [维护指南](docs/LIFECYCLE.md)                 | 升级、停用、卸载和回退                   |
| [开发指南](docs/DEVELOPMENT.md)               | 代码结构、构建、测试与发布流程           |
| [更新日志](CHANGELOG.md)                      | 版本变更                                 |

## 开发 🛠️

```sh
npm ci
npm run check         # TypeScript 与分层检查
npm test              # 构建并运行快速回归
npm run format:check
npm run package       # 生成发布资产到 release/
```

平台测试用 `npm run test:platform`，全部测试用 `npm run test:all`，前提见[测试说明](tests/README.md)。面板开发使用 `npm run dev:web`。

## 反馈与贡献 🤝

- 缺陷与建议：[Issues](https://github.com/Admilkk/yunzai-guard/issues)
- 安全问题：请走[私密漏洞报告](https://github.com/Admilkk/yunzai-guard/security/advisories/new)，见 [SECURITY.md](SECURITY.md)
- 提交 PR 前请运行上面的检查命令，并阅读[开发指南](docs/DEVELOPMENT.md)。

## 许可证 📄

本项目以 [GPL-3.0](LICENSE) 许可发布。随附的第三方组件保留各自的许可证。

## 致谢 💖

- [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) / [玖璃](https://github.com/HL-z7/JiuLi)
- [bubblewrap](https://github.com/containers/bubblewrap)
