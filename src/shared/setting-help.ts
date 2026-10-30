/** 配置字段说明：控制台展示与 settings.yaml / settings.default.yaml 的注释共用。 */
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
  "audit.maxDays": {
    description:
      "审计事件的保留天数，早于此的事件每小时清理一次。与容量上限同时生效，先到先清；0 表示只按容量淘汰。",
    default: "0，不按天数清理。",
    change: "保存后立即生效。",
  },
  "log.maxBytes": {
    description: "宿主日志 host.log 的单文件上限，写满后保留尾部并轮转为 host.log.1。",
    default: "4194304 字节（4 MiB）。",
    change: "重启宿主后生效。",
  },
  "log.maxDays": {
    description:
      "host.log 与 host.log.1 超过此天数没有再写入时删除，每小时检查一次；0 表示不按天数清理。",
    default: "0，不按天数清理。",
    change: "保存后立即生效。",
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
  "update.check": {
    description: "定期读取公开发布信息，发现新版本后提示。只检查，不会自动安装。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "update.notify": {
    description: "发现新版本时给主人发一条消息，同一版本只通知一次。更新结果始终会通知。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "update.workerRestart": {
    description:
      "控制台与宿主的更新会热替换，不影响业务。只有改动了 Yunzai 进程内代码的更新才需要重启业务进程一次，这里决定何时重启：业务空闲时、维护时段内，或马上。等待期间再次发送 #guard更新 或点击“马上生效”即可提前执行。",
    default: "业务空闲时。",
    change: "保存后立即生效。",
  },
  "update.idleSeconds": {
    description: "连续这么多秒没有插件处理消息，视为业务空闲。",
    default: "60 秒。",
    change: "保存后立即生效。",
  },
  "update.maxWaitHours": {
    description: "按“业务空闲时”等待的上限，超过后不再等待空闲，直接重启业务进程使更新生效。",
    default: "6 小时。",
    change: "保存后立即生效。",
  },
  "update.window": {
    description: "“维护时段内”使用的本地时间段，格式 HH:MM-HH:MM，可跨午夜，例如 23:00-02:00。",
    default: "03:00-06:00。",
    change: "保存后立即生效。",
  },
  "update.intervalMs": {
    description:
      "两次检查之间的间隔，最短 1 分钟。使用 ETag 条件请求，未变化时不占用 GitHub 限额。",
    default: "300000 毫秒（5 分钟）。",
    change: "保存后立即生效。",
  },
  "audit.coalesceMs": {
    description:
      "窗口内完全相同的普通记录只写第一条，其余合并成一条“重复 N 次”。拦截与重启始终逐条记录。热循环里的大量重复调用不再挤满队列。",
    default: "1000 毫秒。",
    change: "业务进程重建后生效。",
  },
  "audit.durability": {
    description:
      "自适应：含拦截或重启的批次强制落盘，普通记录交给系统缓存，进程崩溃不丢，只有断电可能丢最后几批。每批强制落盘最稳，但事件量大时写盘压力高。",
    default: "自适应。",
    change: "保存后立即生效。",
  },
  "alerts.enabled": {
    description: "总开关。关闭后不推送任何告警，也不转发 Webhook。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "alerts.masters": {
    description: "通过机器人私聊主人。业务进程不在线时暂存，上线后补发。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "alerts.throttle.windowMs": {
    description: "同一类告警在窗口内只发一次，其余计数；窗口结束时发一条合并摘要。",
    default: "60000 毫秒。",
    change: "保存后立即生效。",
  },
  "alerts.throttle.maxPerWindow": {
    description: "窗口内最多推送的不同告警数，超出的进入合并摘要，避免刷屏。",
    default: "5 条。",
    change: "保存后立即生效。",
  },
  "alerts.webhook.url": {
    description:
      "收到告警时向该地址 POST。JSON 格式包含类别、标题、正文与实例信息；纯文本格式只发正文。",
    default: "空，不启用。",
    change: "保存后立即生效。",
  },
  "alerts.webhook.secret": {
    description:
      "填写后每个请求都带 X-Guard-Signature: sha256=<HMAC>，接收方可据此验证来源。该值不会下发给业务进程，导出配置时默认去掉。",
    default: "空。",
    change: "保存后立即生效。",
  },
  "alerts.forward.actions": {
    description:
      "除告警外，把这些处理结果的审计事件成批转发到 Webhook（每 5 秒一批，每批最多 100 条）。",
    default: "拦截、重启。",
    change: "保存后立即生效。",
  },
  "alerts.forward.kinds": {
    description: "只转发这些类型的事件，留空表示全部类型。",
    default: "全部。",
    change: "保存后立即生效。",
  },
  "baseline.enabled": {
    description:
      "学习每个插件常访问的域名、端口、进程、原生扩展与目录。学习期后出现新行为、频率突增、非常规时段活动或批量新目标时提示。只提示，不拦截。",
    default: "关闭。",
    change: "保存后立即生效。",
  },
  "baseline.learnHours": {
    description:
      "每个插件从第一次出现行为开始计算学习期，期间只记录不提示。也可以在行为画像页手动结束学习。",
    default: "72 小时。",
    change: "保存后立即生效。",
  },
  "baseline.kinds": {
    description: "参与画像的行为类型。文件写入通常较杂，默认不纳入。",
    default: "网络访问、端口监听、启动进程、原生扩展。",
    change: "保存后立即生效。",
  },
  "baseline.minSeverity": {
    description:
      "低于该级别的异常只在画像页显示，不推送。原生扩展、端口监听、shell 与裸 IP 连接计为高。",
    default: "中及以上。",
    change: "保存后立即生效。",
  },
  "baseline.learnAfterAlert": {
    description: "新行为提示一次后自动加入常规画像；关闭则在你点“信任”之前每次都提示。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "baseline.offHours": {
    description:
      "学习期内该插件从未在某个时段前后活动，之后在该时段出现行为时提示，每小时最多一次。至少需要两天的学习数据。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "baseline.maxPerPlugin": {
    description: "每个插件最多记录的常规行为数，超出时淘汰最久未出现的。",
    default: "500。",
    change: "保存后立即生效。",
  },
  "baseline.ignore": {
    description:
      "这些行为不参与画像，格式为 类型:对象，支持 *，例如 network:*.qq.com、process:git。也可直接写完整目标。",
    default: "空。",
    change: "保存后立即生效。",
  },
  "baseline.ignorePlugins": {
    description: "这些插件不建立画像，支持 *。",
    default: "空。",
    change: "保存后立即生效。",
  },
  "baseline.spike.enabled": {
    description: "按每个插件自己的历史计算每个统计窗口的平均次数与波动，明显偏高时提示。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "baseline.spike.windowMs": {
    description: "统计频率的时间窗口。",
    default: "600000 毫秒（10 分钟）。",
    change: "保存后立即生效。",
  },
  "baseline.spike.zScore": {
    description: "超过平均值多少倍标准差才算突增，越小越敏感。",
    default: "4。",
    change: "保存后立即生效。",
  },
  "baseline.spike.minCount": {
    description: "窗口内次数低于该值不判断突增，避免低频插件误报。",
    default: "30 次。",
    change: "保存后立即生效。",
  },
  "baseline.burst.enabled": {
    description: "学习期后短时间内出现大量新目标时提示一次高风险，常见于扫描或数据外送。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "baseline.burst.count": {
    description: "时间范围内新目标达到该数量即提示。",
    default: "8 个。",
    change: "保存后立即生效。",
  },
  "baseline.burst.windowMs": {
    description: "统计新目标的时间范围。",
    default: "600000 毫秒。",
    change: "保存后立即生效。",
  },
  "sources.enabled": {
    description:
      "定期读取 plugins 下 Git 插件的远端、分支、提交与工作区，只读，不执行插件代码。需要系统安装 git。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "sources.intervalMs": {
    description: "两次扫描的间隔。",
    default: "600000 毫秒（10 分钟）。",
    change: "保存后立即生效。",
  },
  "sources.notify.dirty": {
    description: "受跟踪的文件被改动、与仓库不一致时通知，例如被其他插件或脚本篡改。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "sources.notify.remote": {
    description: "插件的远端地址被改动时通知。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "sources.notify.commit": {
    description: "插件的提交变化时通知。正常更新插件也会触发，默认关闭。",
    default: "关闭。",
    change: "保存后立即生效。",
  },
  "sources.ignore": {
    description: "不检查的插件目录名，支持 *。",
    default: "空。",
    change: "保存后立即生效。",
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
  "panel.allowExternal": {
    description:
      "默认只允许本机和局域网（含同网段的 IPv6 地址）打开控制台，外网来源会被拒绝并通知主人。需要从公网访问时再开启，并务必经过 HTTPS 反向代理。",
    default: "关闭。",
    change: "保存后立即生效。",
  },
  "panel.chatLogin": {
    description:
      "主人发送 #guard登录 后，宿主私聊发送一次性登录链接。链接 5 分钟内有效、仅可使用一次，登录后会通知主人。",
    default: "开启。",
    change: "保存后立即生效。",
  },
  "panel.publicUrl": {
    description:
      "登录链接使用的地址，适用于反向代理或端口映射。留空时使用面板的监听地址（本机与局域网）。",
    default: "空。",
    change: "保存后立即生效。",
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
