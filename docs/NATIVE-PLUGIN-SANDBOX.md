# 独立插件沙箱

此功能为 **默认关闭的实验功能**。管理员按目录选择现有插件，Guard 将其放入独立原生 Node 进程，保留插件原入口、基类和源码；核心只注册受信代理。系统隔离或加载失败时拒绝该插件，不回退到本体进程执行。

ESM、CommonJS、动态导入和顶层 await 由 Node 处理，但跨插件依赖、完整适配器服务、Web 服务、非图片媒体及真实业务组合仍有兼容限制。启用隔离不等于所有现有插件都能工作。

## 启用与停用

在 Yunzai 根目录执行：

```sh
node plugins/yunzai-guard/dist/cli.js native list
node plugins/yunzai-guard/dist/cli.js native enable my-plugin
node plugins/yunzai-guard/dist/cli.js native check
node plugins/yunzai-guard/dist/cli.js native disable my-plugin
```

`enable` 默认只授权插件自身目录，额外权限需编辑配置。`disable` 保留权限配置和全部业务文件。命令修改离线配置，变更前保存备份，**完整重启宿主后生效**；`check` 不执行插件，也不证明隔离和业务兼容已经通过。

以下示例应按插件实际需求调整，不要直接授予无关数据：

```yaml
pluginSandbox:
  native:
    plugins:
      - id: my-plugin
        timeoutMs: 10000
        network: none
        hookAction: deny
        adapters: false
        allowCoreRestart: false
        writablePaths:
          - data/my-plugin
        writableFiles:
          - config/my-plugin.yaml
        redis:
          read:
            - my-plugin:*
          write:
            - my-plugin:*
```

`hookAction` 为 `audit` 时允许并记录插件自身 JS 副本的修改，不能取得宿主或其他插件的函数引用。`deny` 拒绝修改，`restart` 按规则请求重启；全局规则不能扩展固定的 IPC 能力。

Guard 自有函数和监控包装器不属于可授权 Hook 目标；文件及函数自保护固定拒绝，`hookAction: "audit"` 也不能放行。业务函数的即时反射观察与轮询覆盖见[监控说明](MONITORING.md)。

## 玖璃接入

支持玖璃的旧版 `extends plugin`、`extends JiuLiPlugin` 及 `definePlugin` DSL。`jiuli`、`jiuli/core` 和直接导入的核心加载器映射到插件进程内 API 副本或受限代理，不向插件开放真实加载器、核心启动入口或宿主全局对象。

正则匹配、空串探测和捕获组在插件进程执行。同一消息的 `accept` 与规则回调复用实例；上下文异步取回，回复能力绑定当前请求，消息结束后释放实例。`init`、`onLoad`、`onUnload` 使用初始化实例，支持初始化时新增或替换函数规则，卸载回调只执行一次。

核心加载器仍仅在内存中插桩，磁盘源码保持原样；启用沙箱后，未知加载器结构拒绝启动。Windows 仍需[实验私有 Node](#windows-私有-node)，此适配不取消额外目录、网络和 Redis 授权要求，也不保证所有玖璃插件组合兼容。

## 文件与数据授权

默认仅插件自身目录可写。业务文件使用原路径、原格式，Redis 使用原键名，不迁移到 Guard 私有工作区。停用沙箱或卸载 Guard 后，原插件继续使用原数据，无需导出。

| 字段            | 授权范围                                     |
| --------------- | -------------------------------------------- |
| `writablePaths` | `data/`、`config/`、`temp/` 下明确的业务目录 |
| `writableFiles` | 上述范围中已存在的精确普通文件               |

两类合计最多 16 项，保留路径大小写。禁止根目录整树授权、通配符、路径穿越、设备名、NTFS ADS 及 Guard 控制目录。`config/default_config`、`config/config` 整目录和核心默认配置文件受保护；业务配置可以使用明确的子目录或单文件授权。

同一插件的授权不能相等或互为祖先。不同启用插件只有完全相同字符串的额外目录可显式共享；父子目录、大小写别名、文件与目录重叠及精确文件共享仍拒绝。

启动时复核 canonical 路径、文件类型和链接。精确文件必须已经存在且为普通单链接文件，允许原地写入或追加，不授权父目录新建文件；使用临时文件加 rename 的更新方式可能不兼容。不能因为缺失、链接或平台限制而扩大权限到父目录。

Windows 可接受选中插件 `node_modules` 中、指向项目内只读目录的已核验 pnpm directory junction。项目外目标、其他 reparse 类型、Guard 状态和与可写授权重叠的目标拒绝。共享依赖不会因此获得写权限，不能把该支持推广到任意链接结构。

玖璃指回项目根包的 `node_modules/jiuli`、pnpm 虚拟库及插件本地同名 backlink 单独核验，由模块映射解析 `jiuli` 入口，不加入路径重写表，也不授予项目根目录写权限。

## Redis 原始键授权

Redis 默认拒绝访问。`read`、`write` 分别指定原始键名，各最多 32 项；支持精确键或单个末尾 `*`，后者仅按字符串前缀匹配。禁止全库 `*`、其他 glob 语法及覆盖 Guard 状态的授权。

读写分别检查。会返回既有数据的写操作，例如 `SET GET`、列表弹出、计数增减和 `zAdd INCR`，同时需要读写权限。多键操作先检查所有键，再执行一次命令。

代理仅提供固定命令，不开放任意命令、Lua、事务或跨键移动。`keys(pattern)` 使用受限 `EXISTS` 或 `SCAN`，不调用宿主 `KEYS`；前缀扫描限制步数、时长、并发和返回量，超限或未完成时明确失败。范围读取需有界，不能以 `lRange 0 -1` 请求无法限定大小的集合。

响应受结构、条目数和 64 KiB 编码预算约束。此检查发生在宿主客户端收到数据之后，不能限制服务器首次返回和客户端解码的内存成本；只应授权大小可控的业务键。

这些权限只约束 Guard Redis 代理，不是服务器账户 ACL。`network: "host"` 允许插件自行连接服务时，还需独立账号权限或网络控制。旧测试版留下的前缀键不会自动迁移、重命名或删除。

## 系统与宿主能力

Linux 使用 bubblewrap、命名空间和 seccomp；Windows 使用独立 AppContainer、ACL 与 Job Object。默认网络为 `none`；`host` 允许宿主网络，不是目的地址白名单。只读项目仍可能暴露可读业务内容，Guard 控制状态另行保护。详见[系统隔离](SANDBOX.md)。

Windows 沙箱辅助程序与 Linux bubblewrap 后备副本已随插件提供；`dist/cli.js doctor` 按当前配置准备依赖，不修改系统权限。下面的实验私有 Node 是另一项独立依赖，不会因辅助程序已随包而自动具备。

插件正则、构造函数和回调在子进程执行，IPC 只传经过大小、深度和类型检查的数据及受限句柄，不传宿主函数。回复绑定当前消息请求；有界图片通过字节通道传递，下载和源文件读取留在插件进程。Handler `reject`、上下文等能力随请求结束或退出撤销。

`adapters: true` 单独授权可信适配器注册自身账号和消息来源。它影响核心对用户身份的判断，不能保证恶意适配器无法伪造协议身份。`allowCoreRestart` 默认关闭，打开后仍受[当前主人请求及规则校验](PERMISSIONS.md)约束。

任务、Handler、类注册和 IPC 速率均有预算。开始关闭时先撤销服务能力和核心注册，再尝试插件清理并回收系统范围；部分加载失败会回滚已注册资源。当前源码热更新需要受控重启。

尚无统一的 CPU、内存、进程数或存储配额。原生扩展与普通外部子进程内部未完整逐 API 审计；这些限制不因启用原生 Node 而消失。

## Windows 私有 Node

部分 AppContainer 管道与 canonical 路径兼容需要专门准备的 Windows x64 Node `24.22.1`、ABI 137 私有候选。该实验运行时不随仓库分发，也不自动构建或下载；必须预先准备与当前 Guard 接受摘要匹配的二进制、构建描述、系统检查记录和许可证。普通启动自动准备的官方 Node 没有这些定制补丁，不能替代它。

在可信宿主环境显式选择：

```powershell
$env:YUNZAI_GUARD_PRIVATE_NODE = "1"
node app.js
```

未设置或值为 `0` 时使用原 Node。版本、ABI、架构或摘要不符会拒绝启动，不静默换用其他候选。宿主先验证运行时，再复制到每个会话并复核；只有受控插件的环境使用会话 Node，宿主 `process.execPath` 和系统 PATH 保持原样。

构建与准备入口见[私有 Windows Node 构建说明](../scripts/private-node/README.md)。该说明供维护者使用，普通使用者应由维护者提供匹配的运行时。不能将私有运行时的兼容结论推广到所有 Node 版本或任意原生扩展。

## 内部脚本实验

仓库另提供 vm2 受限脚本执行器、[脚本示例](../examples/plugin-sandbox/echo.js)及[配置示例](../settings.plugin-sandbox.example.yaml)，可通过 `dist/cli.js sandbox init echo` 准备示例。它使用独立脚本接口，不是现有 Yunzai 插件的透明接入方式，也不能代替上述系统隔离。
