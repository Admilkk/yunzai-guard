# 运行环境与启动

## 平台要求

| 项目                     | 要求                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 操作系统                 | Windows x64、Linux x64；macOS 为实验支持，仅兼容托管                                                                          |
| Node.js                  | 包最低要求 `>=23.11.0`；Windows 普通入口按需准备官方 x64 `24.22.1` 私有副本                                                   |
| Yunzai                   | 已安装依赖且能正常运行的 TRSS-Yunzai 或 JiuLi（玖璃）4.x，见下方核心适配                                                      |
| PM2（可选）              | `>=5.0.0`（含更高版本的预发布版），fork 单实例；还需通过实际接口和身份检查。5.x 仅在 Linux 上实测，Windows 请先在测试环境确认 |
| Windows 系统隔离（可选） | 系统 PowerShell、.NET Framework 运行环境与可用的 AppContainer；辅助程序随包提供                                               |
| Linux 系统隔离（可选）   | 优先系统 bubblewrap，缺失时使用随包静态副本；仍需所需命名空间与系统调用能力                                                   |

版本要求只设下限，不锁定上限；更高版本仍须通过实际接口和身份检查。Windows 身份核验与 PM2 Inspector 激活依赖原生辅助程序内置的 Node `24.22.1` 镜像摘要，属于二进制核验而非版本门槛，放宽需重新编译并验收辅助程序。最低版本与接口检查不代表所有版本、架构、发行版或业务插件均兼容。不要把 fork `reload` 理解为零停机切换；cluster 与多实例不在支持范围。实验插件沙箱的运行时要求见[独立插件沙箱](NATIVE-PLUGIN-SANDBOX.md)。

在 Yunzai 根目录运行 `node plugins/yunzai-guard/dist/cli.js doctor`，可检查并准备当前配置使用的组件。Windows 官方 Node 依次查找发布包内置的 `runtime/node-v24.22.1-win-x64/node.exe`、Guard 的 `.cache/dependencies`，都没有时才从固定官方地址下载到缓存，均须通过固定 SHA-256 后才使用；普通 `app.js` 冷接管和显式 launcher 均可自动准备。离线且没有合格副本时会报告失败，不替换系统 Node、PATH 或其他应用。

Windows 沙箱辅助程序随包提供，无需用户安装 C# 编译器。Linux 随包 bubblewrap 不使用 setuid，也不会调整系统命名空间策略。系统组件缺失或内核策略禁止隔离时仍需管理员处理；Guard 不会提权或静默关闭隔离。

## macOS（实验）

macOS 支持兼容托管模式下的 `node app.js` 普通启动与显式 launcher，使用系统自带的 Node.js（`>=23.11.0`）。与 Linux 的差异：

- 原进程退出观察与进程树清理使用系统自带的 `ps` 与进程组，不读取 `/proc`。
- 系统层观察用 `ps` 与 `lsof` 采样进程树与 TCP 连接，每 30 秒一次；macOS 不向普通用户提供逐进程读写字节，这两项显示为 0。
- 不支持系统隔离（`isolationMode: "os-sandbox"`）与独立插件沙箱，也不支持 PM2 自动接管。
- 没有真机验证，由仓库的兼容性工作流在 GitHub 的 macOS 环境中实际安装并启动 TRSS-Yunzai 冒烟。遇到问题请附 `data/yunzai-guard/host.log` 提交 Issue。

## 核心适配

Guard 启动时按 Yunzai 根目录 `package.json` 的名称及加载器文件识别核心，未识别时按 TRSS-Yunzai 处理。插件归属监控通过在内存中改写核心加载器的固定位置实现，不修改磁盘文件：

| 核心          | 改写的加载器            | 独立插件沙箱 |
| ------------- | ----------------------- | ------------ |
| TRSS-Yunzai   | `lib/plugins/loader.js` | 支持         |
| JiuLi（玖璃） | `lib/core/loader.js`    | 支持         |

加载器结构与已适配位置不符时，默认观察降级为不归属插件并记录覆盖事件；已启用拒绝规则、系统隔离或插件沙箱时拒绝启动，不静默失效。`node . start` 外部托管入口见下文“TRSS 官方脚本与守护模式”。JiuLi 没有 `Bot.exitEvent`，默认保护目标中的该项会显示为不可用，退出钩子改用 `exit` 事件监听。

玖璃独立插件沙箱支持旧插件基类、`JiuLiPlugin` 和 `definePlugin` DSL，通过进程内 API 副本及受限加载器代理接入，详见[玖璃接入](NATIVE-PLUGIN-SANDBOX.md#玖璃接入)。Windows 仍需下述文档中的实验私有 Node，普通入口使用的官方 Node 副本不能替代；该适配不代表任意业务插件均兼容。

## 普通启动

面板默认忽略 `X-Forwarded-For`。使用同机反向代理时，可在 `data/yunzai-guard/panel.json` 设置 `"trustProxy": true` 后重启宿主；代理必须覆盖该请求头，或将实际客户端地址追加到最右侧。Guard 仅信任 loopback 连接携带的合法 IP。

在 Yunzai 根目录使用原入口：

```sh
node app.js
```

首次加载 Guard 后，原进程完成交接并退出，由独立宿主管理工作进程。交接前的业务行为不在受控监控范围内。需要在第一条核心指令前安装监控，或让终端、screen/tmux 持续监督宿主时，改用：

```sh
node plugins/yunzai-guard/dist/launcher.js
```

运行期间可使用 `dist/cli.js status` 查看业务状态。工作进程故障按恢复预算重建；预算耗尽后保留宿主和故障状态，修正原因后执行 `dist/cli.js resume`。面板保存配置后按[字段范围](PERMISSIONS.md#配置生效)自动应用；手工编辑配置仍需完整重启宿主，CLI `restart` 只重建工作进程。

宿主和工作进程输出统一写入 `data/yunzai-guard/host.log`，运行中按每份 4 MiB 保留当前与上一份。Linux 冷接管后宿主继承原终端输出，原进程退出后会回到命令提示符而输出照常追加，宿主不随 Ctrl+C 停止，请用面板或 `dist/cli.js stop`。Windows 冷接管后宿主是独立后台进程，原窗口由一个轻量转印进程接管：原进程退出前暂停启动它的 cmd、PowerShell（或 npm、JiuLi 守护进程等直接父进程），之后该窗口与机器人直接在前台运行时一样，照常显示输出、键盘输入送到业务进程的标准输入（TRSS 与 JiuLi 的 stdin 适配器），按 Ctrl+C 或关闭窗口会停止机器人并显示停止过程，机器人停止后才回到命令提示符；宿主级更新重启时跟随新宿主。再按一次 Ctrl+C 只关闭输出并立即交还命令提示符。暂停 shell 依赖系统 PowerShell；无法暂停时（例如父进程不在同一控制台）只转印输出，提示符会提前回来、键盘输入不转发。Git Bash（mintty）会在原进程退出后结束该窗口的控制台会话，无法继续显示，此时机器人转入后台运行，请用 `dist/cli.js log` 查看日志、`dist/cli.js stop` 停止；需要在 Git Bash 中前台运行时改用 `node plugins/yunzai-guard/dist/launcher.js`，可正常输入指令并按 Ctrl+C 停止。转印进程若被任务管理器强制结束，被暂停的 shell 不会恢复，关闭该窗口即可。随时可用面板或 `dist/cli.js log` 查看日志。显式 launcher 与 PM2 保留各自原有输出。清理未确认完成时宿主保留锁和熔断状态，不强行退出后另起实例。

默认 `startupTimeout` 为 60000 毫秒。启动器和外层进程管理器应为初始化及系统资源回收保留足够期限，避免过早强杀。

## TRSS 官方脚本与守护模式

- **Windows 安装程序**（Yunzai-Windows-Installer）用 `node .` 启动，与 `node app.js` 相同，按上文普通启动接管。
- **官方 Docker 脚本**（TRSS 仓库 `lib/tools/docker.sh`）在容器里以 `exec node . start` 作为 1 号进程，**`node . daemon`** 守护模式也以 `node . start` 拉起子进程。这两种方式由外部管理器跟踪进程本身，Guard 在核心就绪、释放原进程资源后，用 `execve` 把同一个进程原地替换成 Guard 宿主，进程号不变，与 TRSS 自身的重启方式相同。
  - 主动停止（`Bot.exit`、CLI `stop`、面板）以 255 退出：守护模式据此停止，不会再拉起；`docker stop` 照常可用。
  - 版本更新与还原后宿主以 0 退出，由 Docker 的 `--restart always` 或守护模式重新执行 `node . start`，届时由新文件接管。
  - 依赖 Node.js 的 `process.execve`，仅 Linux 与 macOS 支持；Windows 上请用 `node .`。

## PM2 自动接管

可以保留原来的 ecosystem 配置和 `app.js` 入口：

```sh
pm2 start config/pm2.yaml
pm2 restart TRSS-Yunzai
pm2 reload config/pm2.yaml --only TRSS-Yunzai
```

按实际部署替换应用名与配置路径。Guard 核验直接父 daemon、实际 ChildProcess、项目路径和应用身份，仅登记当前应用的 launcher 路由、就绪与退出协调。接管会更换目标进程 PID，原 ecosystem 文件保持原样。

Windows PM2 仍须使用通过身份核验的官方 x64 Node `24.22.1`。Guard 不会自动重启或更换共享 daemon 的解释器；`doctor` 准备好私有副本也不代表现有 daemon 已满足条件，避免影响其他 PM2 应用。

后续启动先确认旧工作进程及其系统范围退出，再允许新一代启动。身份或退出条件不能确认时拒绝继续，`resume` 不能解除 daemon 层的身份失败。

PM2 开启 `autorestart` 时，Guard CLI `stop` 可能被外层拉起，持久停止应使用 `pm2 stop <目标 ID>`。熔断宿主仍可能显示 PM2 `online`，应同时检查 Guard `status`。

### Inspector 条件

首次接管按需使用本机 Inspector，不暂停 daemon。仅支持默认或 loopback 调试配置；已存在的适用端点保留，本次创建的临时端点应在交接前关闭并核验。

此处仅指 PM2 daemon；受控 Guard 宿主和工作进程要求 Inspector 关闭。不要为目标应用设置 `--inspect` 等调试启动参数，工作进程也不能通过 JS 调试接口重新开启调试。

端口冲突、权限不足、接口变化或身份不明会拒绝接管。隐藏的通配调试配置可能在激活后才被发现；客户端在激活与核验之间被强制结束，也可能留下未经确认的端点。遇到这些错误，应先核对本机调试状态，再重试目标应用。

Windows 的 `PM2_HOME` 不保证隔离默认命名管道。日常维护应使用实际管理目标应用的同一账户和 PM2 实例，不要通过临时切换 `PM2_HOME` 管理现有应用。

## systemd 与开机恢复

直接由 systemd 管理时，让服务跟踪实际 Guard 宿主，入口可使用显式 launcher。工作目录设为 Yunzai 根目录，确保服务账户能读取 Node、插件和配置，并提供足够停机时间完成系统隔离回收。

通过 PM2 管理开机恢复时，先确认目标应用已接管、Guard 状态正常，再按 PM2 的 `save`、`startup` 流程保存清单和注册服务。服务账户、工作目录和 Node 解释器必须与日常运行一致。保存清单可能记录 Guard launcher，移除插件前必须先按[维护指南](LIFECYCLE.md)恢复原入口。

服务重启会影响其管理的全部应用；主机重启还涉及 Redis、网络、挂载及权限就绪顺序。部署时应确认自己的服务恢复链，不能以单次应用重启代替开机恢复检查。

## 单实例与控制状态

Guard 使用规范化项目路径建立单实例锁。管理接口默认向系统申请临时端口，实际地址和认证令牌保存在 `data/yunzai-guard/control.json`，CLI 自动读取该文件。显式配置的端口不可用时拒绝启动。

控制状态损坏、身份不符或旧进程是否退出无法确认时，不应手动覆盖凭据或绕过锁。先停止所属启动器，确认旧实例及资源已退出，再处理对应故障。升级和降级时尤其要避免同项目的新旧入口同时运行。

进一步配置见[权限规则](PERMISSIONS.md)、[系统隔离](SANDBOX.md)与[维护指南](LIFECYCLE.md)。
