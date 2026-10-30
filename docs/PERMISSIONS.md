# 默认观察与权限规则

配置文件位于 Yunzai 根目录的 `data/yunzai-guard/settings.yaml`，全部配置项与说明见同目录自动生成的 `settings.default.yaml`，也可参考仓库中的[完整示例](../settings.example.yaml)。

## 默认行为

安装后使用 `managed` 模式，`rules` 为空，`protect.action` 为 `audit`，原生插件沙箱列表为空。业务插件继续由原加载流程运行，原有 Hook 可以生效；默认检查发现修改时只记录，不自动请求安全重启。

**Guard 自保护是固定例外**：工作进程不得通过受控入口写入 Guard 目录、读取或写入宿主状态目录及运行时清单，也不得替换 Guard 自有函数及必要的文件、反射、Node 监控入口。Guard 源码仍可读取。对应 `self-protection` 事件固定为 `deny`，全局 `audit`、单插件例外或关闭业务完整性检查均不能放行。正常 Bot 和业务函数 Hook 仍按业务规则处理；会替换上述监控包装器的插件需要调整这类行为。

受控进程启动前必须关闭 Inspector；工作进程中的调试连接、堆快照和调试信号等已包装入口固定拒绝，不能通过单插件授权放行。范围与绕过边界见[安全说明](../SECURITY.md)。

已有配置中显式设置的规则、动作和沙箱选择继续有效。正常主人重启命令、崩溃恢复及宿主停机仍按生命周期处理，不受默认审计动作影响。

`startupTimeout` 默认 60000 毫秒；已有显式设置保持原值。该期限只控制启动等待，不改变权限规则。

## 配置生效

面板保存后自动应用，页面显示应用中、已保存、需重启或失败。字段旁的问号支持鼠标悬停和手机点击查看说明。

| 配置                                                                                                                                     | 生效方式                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `recovery`、`update`、`alerts`、`baseline`、`sources`、`log.maxDays`、`audit.maxEventsPerSecond/maxBytes/maxFiles/maxDays/durability`    | 直接生效                                                         |
| `rules`、`monitor`、`protect`、`sandbox`、`pluginSandbox`、`isolationMode`、三个启动/关闭/握手超时、`audit.maxQueue`、`audit.coalesceMs` | 协调重建业务进程及其受控后代，宿主与面板保持运行，业务会短暂重连 |
| `controlPort`、`log.maxBytes`                                                                                                            | 完整重启宿主                                                     |

准备或重载失败会保留错误状态；保存相同配置可重试，已生效的直接更新项仍然有效。手工编辑文件或通过离线 CLI 修改配置后，仍需完整重启宿主读取；CLI `restart` 只重建业务进程。

## 全局与单插件规则

`rules` 按配置顺序匹配，**第一条匹配规则生效**，未命中则正常执行并审计。省略 `plugin` 表示全局规则，填写插件名或 glob 表示指定来源。省略 `kind` 或写 `*` 匹配全部类型，但不包括显式类型 `listen`、`filesystem`、`native`，它们必须在 `kind` 中原样写出，见[显式类型](MONITORING.md#显式类型)。

| action    | 行为                                 |
| --------- | ------------------------------------ |
| `audit`   | 调用原操作并记录                     |
| `deny`    | 在可拦截入口拒绝操作                 |
| `restart` | 拒绝操作，并请求受控宿主重建工作进程 |

以下示例主动禁止外部命令和某个插件的网络访问，不属于默认配置：

```yaml
rules:
  - id: global-shell-policy
    kind: process
    operation: exec*
    action: deny
  - id: one-plugin-network-policy
    plugin: sample-plugin
    kind: network
    action: deny
```

插件例外应放在相应宽规则之前。全局和单插件规则没有额外的隐式优先级。来源不能确认时记为 `unknown`；调用栈和插件名称只是归因提示，不能证明恶意代码身份。

业务反射 Hook 入口可即时记录；普通赋值等仍依赖事后完整性检查，`deny` 不能撤销已经发生的修改。需要发现变化后重建进程时，应显式选择 `restart`。固定自保护在受控入口调用前拒绝；两类检查的覆盖边界见[监控说明](MONITORING.md)。

## 系统权限与插件授权

JS 规则不构成系统权限边界。整个工作进程的系统限制由 `isolationMode: "os-sandbox"` 和 `sandbox` 配置决定，见[系统隔离](SANDBOX.md)。

独立插件沙箱只处理明确选择的插件，默认仅自身目录可写、网络为 `none`。额外业务目录、精确配置文件、Redis 原键和适配器能力分别授权，见[独立插件沙箱](NATIVE-PLUGIN-SANDBOX.md)。审计规则中的 `audit` 不会扩大系统文件或网络权限。

原生沙箱的 `allowCoreRestart` 默认 `false`。设为 `true` 后，`Bot.restart()` 还须关联宿主保存的当前主人消息请求并通过规则；加载阶段、后台任务、伪造、过期或重复请求不能取得这项宿主控制权。对应规则为 `kind: "plugin-sandbox"`、`operation: "native.core.restart"`、`target: "controlled-core"`。
