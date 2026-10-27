export interface SettingHelp {
  description: string
  default?: string
  change?: string
}

export const settingHelp: Record<string, SettingHelp> = {
  "monitor.files": {
    description:
      "记录插件经 fs 路径入口的文件操作；读取量通常较大，可按需开启。原生扩展内部的文件访问不在此范围。",
    default: "仅修改。",
  },
  "protect.enabled": {
    description: "观察指定业务函数的变化；Guard 自保护始终启用。",
    default: "开启，仅记录。",
  },
  "protect.monitorInstrumentation": {
    description: "检查网络、子进程等监控入口是否被替换。",
    default: "开启。",
  },
  "protect.intervalMs": {
    description: "业务函数的定期检查间隔，越短开销越高。",
    default: "1000 毫秒。",
  },
  "protect.action": {
    description: "业务函数变化时的默认动作，变化后检测无法保证撤销 Hook。",
    default: "记录。",
  },
  "protect.targets": {
    description: "需要观察的函数路径，不支持表达式。",
    default: "TRSS 鉴权、权限检查、插件加载、消息发送与任务入口。",
  },
  controlPort: {
    description: "本机管理命令端口，与网页面板端口不同。",
    default: "自动分配。",
    change: "重启宿主后生效。",
  },
  startupTimeout: {
    description: "等待业务进程启动就绪的最长时间。",
    default: "60000 毫秒。",
  },
  shutdownTimeout: {
    description: "等待业务进程退出和子进程回收的最长时间。",
    default: "10000 毫秒。",
  },
  handshakeTimeout: {
    description: "首次接管时，等待原进程交接的最长时间。",
    default: "5000 毫秒。",
  },
  "recovery.maxRestarts": {
    description: "统计窗口内的故障恢复上限，超过后停止自动拉起。",
    default: "3 次。",
  },
  "recovery.windowMs": {
    description: "故障恢复次数的统计时段。",
    default: "60000 毫秒。",
  },
  "recovery.baseDelayMs": {
    description: "首次故障恢复的等待时间，连续故障时逐步延长。",
    default: "250 毫秒。",
  },
  "recovery.maxDelayMs": {
    description: "故障恢复等待时间的上限。",
    default: "30000 毫秒。",
  },
  "audit.maxEventsPerSecond": {
    description: "审计写入速率上限，高峰期事件排队提交。",
    default: "100 条/秒。",
  },
  "audit.maxQueue": {
    description: "待提交事件的数量上限，过小容易在高峰期丢失记录。",
    default: "1000 条。",
  },
  "audit.maxBytes": {
    description: "同时用作审计缓冲字节上限；乘以保留倍数得到事件保留预算。",
  },
  "audit.maxFiles": {
    description: "基础保留容量的倍数，超出后删除最旧事件；索引和 WAL 另占空间。",
  },
  isolationMode: {
    description: "兼容托管保持原插件运行方式；系统沙箱限制整个业务进程。",
    default: "兼容托管。",
  },
  "sandbox.network": {
    description: "整个业务进程的网络权限，仅用于系统沙箱。",
    default: "禁止网络。",
  },
  "sandbox.writablePaths": {
    description: "系统沙箱允许写入的项目相对目录。",
    default: "data、temp、logs、config/config。",
  },
  "sandbox.bwrapPath": {
    description: "Linux bubblewrap 的绝对路径，留空自动检测。",
  },
  "native.enabled": {
    description: "将这个插件放入独立沙箱。",
    default: "关闭。",
  },
  "native.timeoutMs": {
    description: "一次沙箱插件调用的最长等待时间。",
    default: "10000 毫秒。",
  },
  "native.network": {
    description: "这个独立沙箱插件的网络权限。",
    default: "禁止网络。",
  },
  "native.hookAction": {
    description: "沙箱插件修改宿主或其他插件对象时的处理，不能放行 Guard 自保护。",
    default: "拒绝。",
  },
  "native.adapters": {
    description: "允许沙箱中的协议适配器接入机器人账号，普通插件无需开启。",
    default: "关闭。",
  },
  "native.allowCoreRestart": {
    description: "允许这个沙箱插件请求退出或重启机器人。",
    default: "关闭。",
  },
  "native.writablePaths": {
    description: "额外授权的可写目录及其内容，例如 data/example。",
    default: "无额外授权。",
  },
  "native.writableFiles": {
    description: "额外授权的具体文件，不支持通配路径。",
    default: "无额外授权。",
  },
  "native.redis.read": {
    description: "允许读取的 Redis 键名或前缀，例如 example:*。",
    default: "无授权。",
  },
  "native.redis.write": {
    description: "允许写入的 Redis 键名或前缀，例如 example:*。",
    default: "无授权。",
  },
  "script.enabled": {
    description: "启用 Guard scripts 目录中的受限脚本。",
    default: "无已启用脚本。",
  },
  "script.match": {
    description: "触发脚本的消息模式，支持简单通配符，例如 #echo*。",
  },
  "script.capabilities": {
    description: "授予脚本回复、日志或写入自身文本文件的能力。",
    default: "仅回复。",
  },
  "script.timeoutMs": {
    description: "一次脚本调用的最长执行时间。",
    default: "1000 毫秒。",
  },
  "script.memoryMiB": {
    description: "受限脚本执行器的内存上限。",
    default: "16 MiB。",
  },
  "script.violationAction": {
    description: "脚本违反权限或执行限制时的处理。",
    default: "拒绝。",
  },
  "script.hookAction": {
    description: "脚本尝试修改桥接对象时的处理。",
    default: "拒绝。",
  },
  "rule.action": {
    description: "记录允许并留痕；拒绝阻止可拦截的请求；重启恢复业务进程。",
    default: "记录。",
  },
  "rule.kind": {
    description:
      "行为分类，留空或 * 匹配全部分类；文件访问、原生扩展和端口监听须显式选择，通配不会匹配它们。",
  },
  "rule.plugin": { description: "插件目录名，留空或 * 作为全局规则。" },
  "rule.operation": { description: "具体操作，例如 fetch、exec、worker；留空匹配全部。" },
  "rule.target": { description: "地址、命令或函数路径等目标，留空匹配全部。" },
  "rule.id": { description: "用于追踪审计事件的唯一规则名称。" },
  "rule.order": { description: "从上到下匹配，第一条命中的规则决定处理动作。" },
  "permission.network": {
    description: "网络请求的处理，继承时按全局规则执行。",
    default: "继承，全局默认记录。",
  },
  "permission.process": {
    description: "子进程请求的处理，单独的 Worker 规则优先。",
    default: "继承，全局默认记录。",
  },
  "permission.worker": {
    description: "Worker 创建请求的处理。",
    default: "继承，全局默认记录。",
  },
  "permission.plugin": {
    description: "已确认归属的插件调用的处理。",
    default: "继承，全局默认记录。",
  },
  "permission.hook": {
    description: "业务函数变化的处理，变化后检测无法保证撤销 Hook。",
    default: "继承，全局默认记录。",
  },
  "permission.listen": {
    description: "插件监听端口或绑定 UDP 端口，例如自带网页面板。与网络外联分开配置。",
    default: "继承，全局默认记录。",
  },
  "permission.filesystem": {
    description:
      "插件经 fs 写入、创建、删除或移动文件。拒绝时调用直接失败；是否记录读取由运行设置中的文件访问记录决定。",
    default: "继承，全局默认记录。",
  },
  "permission.native": {
    description:
      "插件加载 .node 原生扩展。只能控制是否允许加载，加载后的内部读写和网络不经过 JS 检查。",
    default: "继承，全局默认记录。",
  },
  "monitor.process": {
    description:
      "宿主定期从进程外读取业务进程树的读写字节与 TCP 连接，覆盖原生扩展；新的外部连接写入审计。只观察，不拦截。",
    default: "开启。Linux 每 10 秒，Windows 每 30 秒。",
  },
  "panel.host": {
    description: "127.0.0.1 仅本机访问；0.0.0.0 监听所有网卡。",
    default: "0.0.0.0。",
    change: "重启面板后生效。",
  },
  "panel.port": {
    description: "网页面板端口，与控制端口不同。",
    default: "21733。",
    change: "重启面板后生效。",
  },
  "panel.tokenTtlHours": {
    description: "临时登录会话的有效期。",
    default: "24 小时。",
  },
  "panel.trustedDeviceTtlDays": {
    description: "信任设备后的登录有效期，可随时在设备列表撤销。",
    default: "30 天。",
  },
}

/** 返回配置路径对应的说明。 */
export function helpForPath(path: string[]): SettingHelp | undefined {
  const key = path.join(".")
  if (path[0] === "pluginSandbox" && path[1] !== "native")
    return settingHelp[`script.${path[path.length - 1]}`]
  return settingHelp[key]
}
