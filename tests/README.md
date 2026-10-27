# 测试说明

测试使用 Node.js 内置运行器，保留逐文件进程隔离。

| 命令                       | 范围                                     |
| -------------------------- | ---------------------------------------- |
| `npm test`                 | 构建一次，再执行默认快速组件回归。       |
| `npm run test:unit`        | 使用已有构建，只运行快速组件回归。       |
| `npm run test:platform`    | 构建后运行明确列出的平台与环境测试。     |
| `npm run test:all`         | 构建后运行全部根目录测试，不遗漏平台组。 |
| `npm run test:integration` | 运行显式启用的冻结核心生命周期验证。     |

平台文件完整清单见 [platform-files.json](./platform-files.json)。系统沙箱、原生进程身份、真实 Inspector、核心副本与平台进程清理等用例归入此组。混合组件与实机用例的文件整体保留在平台组，避免拆分或丢失现有覆盖；纯 Node 子进程、IPC、策略与协议组件回归仍可在默认组运行。

平台组中的部分文件仅按操作系统判断，执行平台命令即会运行实际 AppContainer、ACL、原生 helper 或进程用例；另一些文件仍要求各自的显式环境变量、编译器或准备好的输入。平台组默认逐文件串行，其他组保留最多三个文件并发。可追加 Node 测试选项，例如 `npm run test:unit -- --test-name-pattern=protocol`。

`test:integration` 需要设置 `GUARD_R29_REAL=1`、`GUARD_R29_INPUT_MANIFEST` 和 `GUARD_R29_INPUT_SHA256`，并满足对应平台、Node 与核心输入条件。目录迁移后的输入清单必须使用当前产物路径及实际哈希。

**跳过只表示未执行，不能记为集成验证通过或平台支持证明。** 默认快速回归通过也不代表平台组或冻结核心集成已执行。

- `helpers/` 存放共享工具，`fixtures/` 存放必要输入。
- `fixtures/pm2-compat-v0.3.2.*` 与 `fixtures/pm2-r26/` 是冻结的历史兼容输入，保留原始路径、源码和哈希。
- `native/` 保留原生测试夹具和维护者工具，不属于插件运行时依赖。
- `runs/`、核心副本、依赖包和日志属于本机测试产物，不提交到公共分支。

需要真实核心副本的用例先执行 `npm run test:prepare -- <Yunzai源码目录>`。私有 Node 补丁语法回归可单独运行 `python tests/private-node-source.test.py`。
