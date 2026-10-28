# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0](https://github.com/Admilkk/yunzai-guard/compare/v1.0.0...v1.1.0) (2026-10-28)


### ✨ 新功能

* **alerts:** 告警出口：拦截、重启、熔断、函数被改动、画像异常、插件来源变化与更新结果推给主人或 Webhook，按窗口限流合并，可选 HMAC 签名 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **audit:** 审计按当前筛选导出 CSV 或 JSON ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **entry:** 兼容 TRSS 官方 Docker 脚本（node . start）与 node . daemon，原地切换为 Guard 宿主 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **logs:** 审计事件与宿主日志支持按容量和保留天数两种方式清理 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **panel:** 控制台新增告警中心、行为画像页，总览合并状态与更新卡片 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **platform:** macOS 实验支持兼容托管模式 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **pm2:** PM2 最低版本由 6.0.14 放宽到 5.0.0 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **profile:** 行为画像：学习每个插件的常规行为，识别新行为、频率突增、非常规时段与批量新目标，并给出风险分 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **settings:** 配置历史备份与一键恢复，配置与规则的导出、导入 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **sources:** 插件来源校验：定期检查 Git 插件的提交、远端与工作区，文件被改动时通知 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **update:** 更新还原：#guard回滚、控制台与 CLI 还原到保留的上一版本 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **update:** 版本更新：定时检查新版本并通知主人，支持 #guard更新、#guard强制更新、控制台与 CLI 一键更新 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))


### 🐛 问题修复

* **update:** GitHub API 额度用尽时改读 releases/latest 跳转地址检查新版本 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))
* **update:** 拒绝降级到低于当前版本的发布 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))


### ⚡️ 性能优化

* **audit:** 相同事件按窗口合并，队列溢出补充说明，自适应写盘，默认速率与队列上限提高；控制台复用短时间内的相同查询 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))


### 📝 文档

* **install:** 补充独立 Node 运行时用法 ([4947c94](https://github.com/Admilkk/yunzai-guard/commit/4947c94dd8283aaa56e850a35c1d91366608c643))
* 安装方式以发布包为准，提示文案改为平实表述，补充告警、画像、大量事件与运行环境说明 ([b010aa6](https://github.com/Admilkk/yunzai-guard/commit/b010aa6749e86df4fc133580cf9a3c7d666b4b51))

## [1.0.0] - 2026-10-27

首个公开稳定版，许可证改为 GPL-3.0-only。

### 新增

- 网络入口覆盖：`http2.connect`、全局 `WebSocket`/`EventSource` 与 `dns.resolve*`/`dns.reverse`（含 `Resolver` 与 `dns.promises`）。
- 端口监听：`net.Server#listen` 与 `dgram.Socket#bind` 产生 `kind: "listen"` 事件，与网络外联分开配置。
- 原生扩展：`process.dlopen` 产生 `kind: "native"`、`operation: "native.load"` 事件，可按规则拒绝加载；原生代码内部 I/O 的覆盖边界写入[监控说明](docs/MONITORING.md#原生扩展)。
- 业务文件审计：新配置 `monitor.files`（`off` / `write` / `all`，默认 `write`），复用自保护的 fs 收口，产生 `kind: "filesystem"` 事件；同一插件对同一文件的同类记录 60 秒内只写一次，拒绝规则每次执行。
- 系统层观察：新配置 `monitor.process`（默认开启），宿主从进程外采样业务进程树的读写字节与 TCP 连接（Linux `/proc`、Windows PowerShell），新的外部连接记为 `connection.observed`，覆盖原生扩展发起的连接；只观察不拦截。
- 显式类型：`listen`、`filesystem`、`native` 只匹配在 `kind` 中原样写出的规则，宽泛的旧规则不会作用于它们。
- 控制台：总览新增状态条、指标卡、24 段趋势、原生扩展与系统层观察卡片；行为审计改为单行即时筛选，支持时间快捷范围、隐藏系统记录、实时刷新与点击筛选；插件权限列表直接显示各插件的受限类别，新增文件写入、原生扩展与端口监听三类权限，抽屉内改为分段选择。
- Windows 发布包内置固定版本 Node `24.22.1`（`runtime/`），启动优先使用，缓存与下载作为兜底；Release 同时提供独立 `node.exe`。
- `npm run package` 生成发布资产与 `SHA256SUMS.txt`；新增 CI 与 Release 工作流。

### 变更

- 事件总线：同类通知在途时保留最新一帧并在写入完成后补发，不再丢弃期间的状态更新。
- 连续的拒绝记录不再丢失：工作进程与宿主的关键事件槽位被占用时，拒绝事件改走普通队列；重启请求仍合并。此前同一时刻的多次拦截只会留下第一条。
- 每个 TCP 连接只记录一次 `socket.connect`；文件与原生扩展路径去掉 Windows 命名空间前缀 `\\?\`。
- 合并重复实现：描述符比较统一为 `protect/intrinsics` 的加固版 `sameDescriptor`，引用判断统一为 `isReference`，路径包含判断统一为 `protect/paths` 的 `within`，传输覆盖上报统一为 `runtime/reporter` 的 `trackCoverage`，规则类型匹配统一为 `config/policy` 的 `kindMatches`。
- 全部函数补充 JSDoc。
- `installInstrumentation` 内部 `wrap` 改为选项对象；构造器代理统一为 `guardClass`。
- README、安全说明与开发指南按公开发布更新。

### 注意

- 已有 `kind: "network"` 的拒绝规则会同时作用于新增的 DNS 查询、WebSocket 与 HTTP/2 连接；端口监听已拆为独立的 `listen` 类型，不受影响。
- 默认开始记录业务插件的文件修改操作；如不需要，可将 `monitor.files` 设为 `off`。
