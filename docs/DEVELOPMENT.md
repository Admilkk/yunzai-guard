# 开发与维护

Guard 是独立插件，改动限定在本仓库，不通过改写 Yunzai、PM2 或业务插件磁盘源码完成适配。默认观察、已有配置语义、身份核验和退出清理约束是维护时必须保留的行为。

## 目录职责

`src` 根目录不放实现文件或兼容转发文件，代码按领域组织：

| 位置                                   | 职责                                              |
| -------------------------------------- | ------------------------------------------------- |
| `index.js`、`src/entry/`               | Yunzai 插件入口、显式 launcher 与预加载入口       |
| `src/host/`                            | 宿主生命周期、控制接口、项目锁和平台协调          |
| `src/host/bootstrap/`                  | 首次交接、就绪、退出计划与资源屏障                |
| `src/runtime/`                         | 工作进程安装、事件总线、Worker 与 Node 子进程通道 |
| `src/audit/`                           | 事件校验、队列、脱敏、接收与落盘                  |
| `src/config/`                          | 配置读取、默认值与字段校验                        |
| `src/monitor/`                         | 加载器桥接、插件入口、模块函数与完整性观察        |
| `src/protect/`                         | Guard 自有函数、监控入口和文件的强制自保护        |
| `src/dependencies/`                    | 分发组件校验、按需准备与启动运行时选择            |
| `src/instrumentation/`                 | Node 行为入口包装和参数描述                       |
| `src/pm2/`                             | PM2 身份、自动接管、版本化登记与退出协调          |
| `src/sandbox/`、`src/sandbox/windows/` | 系统隔离后端、Windows 路径和会话权限              |
| `src/native-process/`                  | 原生进程身份、辅助程序协议、会话与分发校验        |
| `src/native-sandbox/`                  | 独立原生插件、桥接 DTO、数据与宿主能力            |
| `src/plugin-sandbox/`                  | 内部受限脚本执行器                                |
| `src/cli/`                             | 状态与离线配置管理命令                            |
| `src/shared/`                          | 跨领域类型、文案与无副作用的小型工具              |
| `native/`、`scripts/`                  | 平台辅助程序、构建与分发准备                      |
| `web/src/`                             | React 面板、共享配置状态与页面组件                |
| `dist/`                                | 本地生成的运行代码、面板与第三方依赖，不纳入 Git  |

内部调用直接导入所属领域模块，不通过根入口绕行。构建只在 `dist` 根目录生成部署、预加载与 PM2 兼容需要的稳定薄入口，例如 `dist/launcher.js`、`dist/cli.js`；保持已有启动命令可用。不要手工编辑 `dist`，也不要为未来可能出现的接口增加转发层。

## 分层

源码按职责分为五层，只能依赖同层或更低层，类型导入不计。`npm run check` 通过 `scripts/check-layers.mjs` 检查，归层规则也写在该脚本中：

| 层级   | 内容                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| 基础层 | `src/shared/`：类型、文案、身份常量和无副作用工具                                        |
| 原语层 | `protect/`、`config/`、`audit/`、`host/bootstrap/`，以及各领域的策略、配置解析和类型文件 |
| 能力层 | 监控、Hook、原生进程、系统隔离、两类插件沙箱、工作进程运行时、PM2 和依赖校验             |
| 编排层 | `host/` 宿主生命周期、`web/` 面板，以及依赖准备与启动选择                                |
| 入口层 | `entry/`、`cli/`                                                                         |

归层按文件职责而非目录：例如 `host/policy.ts` 是供工作进程复用的纯策略，归原语层。PM2 daemon 会缓存模块路径，调整分层时优先修改规则，不为分层移动已被缓存的版本化模块。有副作用的宿主启动状态放在 `host/context.ts`，不要放进 `shared/`。

## 日志与错误文案

全部日志与 `throw` 文案集中在 `src/shared/messages.ts`，按领域分组，统一前缀为 `tag`。代码只通过 `M.<领域>.<键>` 引用；带参数的条目是函数。该模块不导入任何文件，加载时深度冻结并去掉原型，构建登记会跳过它以避免与 `protect/objects` 形成导入循环。

以下内容不是文案，保持原样：协议错误码与原因码（如 `UNSUPPORTED_NODE_PROFILE`、`policy-violation:*`）、事件名、函数内部只用于跳转的哨兵错误，以及 Windows 观察脚本输出并被比较的协议字符串。会经 `Function#toString` 注入其他进程执行的函数不能引用 `M`，须由调用方把文案作为参数传入，例如 `src/pm2/agent-protocol.ts`。

PM2 daemon 会缓存 `messages.js`。daemon 侧模块使用的条目只能是字符串，且不得删除或改名；新增版本化模块引用新条目时，需考虑旧 daemon 仍持有旧文案的情况。

## 模块与协议

`src/runtime/bus.ts` 的实例事件总线使用 `audit`、`command`、`notify` 三类带类型方法；公开 `GuardContext.send` 仅允许 `audit`、`violation` 遥测。`src/runtime/control.ts` 为 `restart-request`、`stop-request`、`preload-ready`、`worker-online` 签名，宿主按每代密钥、PID 和递增序号校验。密钥不得进入环境、日志、状态或公开上下文，附加说明不得参与授权。发送消息不表示动作已完成；授权、状态检查和执行结果仍由所属处理方负责。

控制签名在业务加载前检查并固定所需的 Node HMAC 接口，避免签名经过可替换的 JS 构造链；接口不满足要求时拒绝启动，不降级为未认证消息。普通业务 HMAC 调用保持可用。

Worker、运行时 broker、Windows helper 和 PM2 分别拥有协议与传输实现。只抽取确实重复的逻辑，不用通用传输类掩盖不同的身份、预算和关闭语义。

业务 Hook 观察复用 `src/monitor/watch.ts` 的反射入口登记，普通赋值仍保留轮询。Guard 自保护独立于业务规则：不要暴露运行时卸载句柄，不通过插件归因给自身文件写入豁免；合法状态写入由宿主完成。新增自有导出函数、类和原型须纳入构建登记及加固，新增受控入口需保留原同步、回调、Promise 或流语义。

共享 JS 环境中的关键检查复用 `src/protect/intrinsics.ts` 捕获的操作，避免依赖可替换的原型方法、迭代器和继承字段；审计输入通过 `copyAuditData` 转成有界纯数据再序列化。不要为保护内部调用冻结整个业务全局原型。凭据读取与 JS 调试入口由 `src/protect/` 统一限制。

进程边界先将输入视为 `unknown`，完成字段、长度、版本和身份校验后，再转换为 DTO。TypeScript 类型、数字 PID、插件名称或自报来源不能替代运行时身份核验。

事件策略重算统一经过 `src/host/policy.ts`，仅使用宿主配置和可见字段，忽略客体提供的动作、规则标签及脱敏声明。`src/native-sandbox/` 中的能力代理实际位于 Yunzai 工作进程，不能因类名含 `Host` 就视为独立 supervisor；新增授权判断应明确所属进程与信任边界。

PM2 daemon 会缓存已加载模块。修改已缓存协议实现时，应维护实际版本化入口和依赖，明确兼容条件；仅改稳定转发文件不会刷新旧 daemon。维护步骤见[升级与回退](LIFECYCLE.md)。

## 命名与格式

文件名沿用小写连字符；变量、函数使用 `camelCase`，类型、类使用 `PascalCase`。函数名描述动作，类型名描述职责，避免没有明确边界的通用管理器。

每个函数（含类方法、访问器和顶层箭头函数）都写 JSDoc，用一句话说明职责，必要时补充调用约束。行内 `//` 注释只写代码本身看不出的原因，例如安全边界、平台差异和兼容性约束；不复述代码，不与 JSDoc 重复。

文本统一 UTF-8 无 BOM、LF；JavaScript/TypeScript 两空格缩进、双引号、无分号。Windows 原生 C# 遵循自身 `.editorconfig`。修改前阅读相邻实现，避免无关重排和批量格式化。

只格式化自己的改动文件，例如：

```sh
npm exec prettier -- --write src/cli/index.ts docs/DEVELOPMENT.md
```

生成产物、原生包、固定输入及第三方文件可能有字节或摘要约束，按 `.prettierignore` 和 `.gitattributes` 保持原样。锁文件由包管理器维护。

## 构建与测试

标准开发入口：

```sh
npm ci
npm run check
npm test
npm run format:check
```

`npm test` 构建后执行快速组件回归；`npm run test:platform` 显式运行平台与环境测试，`npm run test:all` 运行全部根目录测试。范围和运行前提见[测试说明](../tests/README.md)。

`npm ci` 通过 `prepare` 自动执行构建。仅需构建时运行 `npm run build`；`build:runtime` 校验分发组件及摘要、生成自保护登记、编译 TypeScript，并复制运行依赖与许可证；`build:web` 使用 Vite 打包 React、Ant Design 与 Motion，按页面分包并输出许可证。生成目录为 `dist/panel`，服务只开放生成的页面与静态资源，不提供源代码路径。构建不自动下载工具链或重新编译原生程序。

`npm run dev:web` 提供前端热更新，API 代理到本机 21733 端口；需要先启动宿主或本地面板夹具。`npm run check` 同时检查后端与前端 TypeScript。运行时 `doctor` 的按需依赖准备与开发构建分开；官方 Node 下载固定地址及摘要，实验私有 Node 不自动下载。

需要 Yunzai 核心副本的测试，可用 `npm run test:prepare -- <Yunzai路径>` 准备。平台、PM2、沙箱和真实环境测试按改动范围选用现有入口；跳过表示条件未满足，不计为通过。文档改动只需检查格式和链接，无需重跑业务矩阵。

原生身份探针的显式维护入口为 `node scripts/build-process-identity.mjs --build`。Linux 分发探针必须保留 Git 可执行位，Windows 私有 Node 参阅[构建说明](../scripts/private-node/README.md)。

## 提交要求

提交源码、所需原生文件和锁文件，说明行为变化、执行过的检查和未验证范围。`dist` 由安装自动生成，不加入暂存区。围绕一个主题组织改动，不把临时缓存、运行输出、令牌、账号数据、原始环境或 `AGENTS.md` 纳入提交。

项目以 GPL-3.0-only 许可发布。公开仓库以 `main` 为主分支；开发历史保留在私有仓库，不复制到公开仓库。

## 持续集成与发布

| 工作流                          | 触发                     | 内容                                                       |
| ------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `.github/workflows/ci.yml`      | 推送、PR                 | Windows 与 Linux 上执行 `check`、`format:check` 与快速回归 |
| `.github/workflows/release.yml` | 推送 `v*` 标签或手动触发 | 构建、打包、校验并创建 GitHub Release                      |

发布资产由 `npm run package` 生成到 `release/`：Linux 包、随附固定 Node 的 Windows 包、独立的 `node-v<版本>-win-x64.exe` 与 `SHA256SUMS.txt`。固定 Node 的版本、地址和摘要只在 `src/dependencies/node.ts` 维护，升级时同步修改三者并更新 `CHANGELOG.md`。

发布步骤：更新 `package.json` 版本与 `CHANGELOG.md`，合并到 `main` 后推送 `v<版本>` 标签；工作流校验标签与 `package.json` 版本一致后发布。
