# 私有 Windows Node 构建

常规安装使用已支持的官方 Node，仓库不附带私有 Node 运行时。实验性的 Windows 原生插件隔离所需私有运行时，须由维护者另行构建并通过检查后提供给使用者。

这些命令只供维护者构建固定的 Node 24.22.1 x64。构建应由持有原进程句柄和独立 Job 的调用器管理，固定预算、保存原始输出并确认 Job 结清；不要按名称或事后 PID 清理 MSBuild。

正常构建应使用 `-ShortBuildPath`，它只在本仓库 `.cache/n29` 建立指向本次固定私有缓存的 junction。已有其他路径或目标不匹配时拒绝；不调整系统 long-path 设置、ACL、驱动器映射或其他应用。短路径用于避免生成工具把 `..\..` 与深工作目录拼接后超过传统路径长度，而生成器本身仍返回成功的情况。

已有干净、已准备源码的完整构建命令为：

```powershell
pwsh -NoProfile -File scripts/private-node/build.ps1 -ReuseSources -ShortBuildPath
```

首次没有准备源码时可省略 `-ReuseSources`。默认入口仍按官方归档和封闭文件集完整校验源码；不要对已有构建输出的目录再次使用该入口。

仅当先前 Job 已确认结清，源码保持冻结、原始失败日志已另存，且继续使用同一份精确验收源码和已成功 configure 的 solution 时，才使用：

```powershell
pwsh -NoProfile -File scripts/private-node/build.ps1 -ResumePreparedBuild -ShortBuildPath
```

这个增量入口限定当前已验收的 source manifest，核对实际三个补丁文件、原生头与权威补丁/头的哈希，复用现有项目和中间产物，不再 configure 或执行全树源码准备。使用已有真实字节码生成器输出并检查生成头非空后才进入 MSBuild；它不改写官方生成器源码，也没有字符串内容兜底。构建 manifest 会记录增量来源、定点校验和短路径，不能把它描述成再次完成全树校验。

全部项目禁用构建期 `TrackFileAccess`，避免 FileTracker 自身的深对象路径限制。保持 `/m:2 /nr:false`；这是维护者构建设定，不是运行时权限。构建完成仍须记录实际 executable SHA 和 manifest，完成真实 AppContainer/SDK 验收后才可登记对应运行时能力。
