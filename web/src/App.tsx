import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react"
import {
  App as AntApp,
  Avatar,
  Badge,
  Button,
  Drawer,
  Dropdown,
  Layout,
  Menu,
  Skeleton,
  Space,
  Spin,
  Tag,
  Tooltip,
} from "antd"
import {
  ApiOutlined,
  AuditOutlined,
  BellOutlined,
  RadarChartOutlined,
  CodeOutlined,
  ControlOutlined,
  DashboardOutlined,
  LockOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons"
import { motion, useReducedMotion } from "motion/react"
import { useConsole } from "./state"
import { useTheme } from "./theme"
import { ThemeToggle } from "./components/ThemeToggle"
import { ChangeBar } from "./components/ChangeBar"
import { ConfigurationState } from "./components/Status"
import Overview from "./pages/Overview"
import Login from "./pages/Login"
import type { SettingsSection } from "./pages/Settings"

const pages: Array<{
  id: string
  title: string
  description: string
  icon: React.ReactNode
  component: ComponentType<any>
}> = [
  {
    id: "overview",
    title: "监控总览",
    description: "运行状态、安全风险与最近事件",
    icon: <DashboardOutlined />,
    component: Overview,
  },
  {
    id: "plugins",
    title: "插件权限",
    description: "查看插件风险并配置独立权限与沙箱",
    icon: <ApiOutlined />,
    component: lazy(() => import("./pages/Plugins")),
  },
  {
    id: "policies",
    title: "全局规则",
    description: "按匹配顺序管理行为处置规则",
    icon: <ControlOutlined />,
    component: lazy(() => import("./pages/Policies")),
  },
  {
    id: "profiles",
    title: "行为画像",
    description: "识别偏离插件常规行为的异常活动",
    icon: <RadarChartOutlined />,
    component: lazy(() => import("./pages/Profiles")),
  },
  {
    id: "alerts",
    title: "告警中心",
    description: "处理安全告警、已读状态与静默规则",
    icon: <BellOutlined />,
    component: lazy(() => import("./pages/Alerts")),
  },
  {
    id: "audit",
    title: "行为审计",
    description: "检索、对比并导出插件行为记录",
    icon: <AuditOutlined />,
    component: lazy(() => import("./pages/Audit")),
  },
  {
    id: "logs",
    title: "运行日志",
    description: "实时查看 Guard 宿主进程日志",
    icon: <CodeOutlined />,
    component: lazy(() => import("./pages/Logs")),
  },
  {
    id: "settings",
    title: "系统设置",
    description: "运行监控、安全防护与面板偏好",
    icon: <SettingOutlined />,
    component: lazy(() => import("./pages/Settings")),
  },
]

type Route = { name: string; page: string; section: SettingsSection }

/** 按名称返回路由，未知时回到概览。 */
function routeFor(name: string): Route {
  if (name === "security") return { name, page: "settings", section: "security" }
  if (name === "advanced") return { name, page: "settings", section: "advanced" }
  if (name === "runtime" || name === "settings")
    return { name, page: "settings", section: "runtime" }
  if (pages.some(item => item.id === name && name !== "settings"))
    return { name, page: name, section: "runtime" }
  return { name: "overview", page: "overview", section: "runtime" }
}

/** 从地址栏读取当前路由；`?` 之后为页面自己的筛选参数。 */
function currentRoute(): Route {
  return routeFor(location.hash.replace(/^#\/?/, "").split(/[/?]/)[0])
}

/** 控制台根组件：登录状态、导航与页面切换。 */
export default function ConsoleApp() {
  const ctx = useConsole()
  const { message } = AntApp.useApp()
  const [route, setRoute] = useState(currentRoute)
  const [mobile, setMobile] = useState(() => innerWidth <= 800)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const reduced = useReducedMotion()
  const current = pages.find(item => item.id === route.page) ?? pages[0]
  const View = current.component
  const lastHash = useRef(location.hash || "#overview")
  const commitRef = useRef(ctx.commitRaw)
  commitRef.current = ctx.commitRaw

  function navigate(name: string, search = "", replace = false) {
    if (!ctx.commitRaw() && name !== "advanced") {
      history.replaceState(null, "", lastHash.current)
      return
    }
    const next = `#${name}${search}`
    lastHash.current = next
    setRoute(routeFor(name))
    setMenuOpen(false)
    if (location.hash === next) return
    if (replace) history.replaceState(null, "", next)
    else history.pushState(null, "", next)
  }

  useEffect(() => {
    const resize = () => setMobile(innerWidth <= 800)
    const change = () => {
      const next = currentRoute()
      if (!commitRef.current() && next.name !== "advanced") {
        history.replaceState(null, "", lastHash.current)
        return
      }
      lastHash.current = location.hash
      setRoute(next)
      setMenuOpen(false)
    }
    addEventListener("resize", resize)
    addEventListener("hashchange", change)
    return () => {
      removeEventListener("resize", resize)
      removeEventListener("hashchange", change)
    }
  }, [])

  useEffect(() => {
    document.title = `${current.title} · Yunzai Guard`
  }, [current.title])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (ctx.session && ctx.dirty && !ctx.saving) void ctx.save()
      }
    }
    addEventListener("keydown", key)
    return () => removeEventListener("keydown", key)
  }, [ctx.session, ctx.dirty, ctx.saving, ctx.save])

  /** 执行操作并统一提示错误。 */
  function run(action: () => Promise<void>) {
    void action().catch(reason =>
      message.error(reason instanceof Error ? reason.message : "操作失败"),
    )
  }

  const groups = [
    { label: "防护", ids: ["overview", "plugins", "policies", "profiles"] },
    { label: "记录", ids: ["audit", "alerts", "logs"] },
    { label: "系统", ids: ["settings"] },
  ]
  const items = groups.map(group => ({
    type: "group" as const,
    label: group.label,
    children: pages
      .filter(item => group.ids.includes(item.id))
      .map(item => ({
        key: item.id,
        icon: item.icon,
        label: (
          <>
            {item.id === current.id && (
              <motion.span
                layoutId="nav-indicator"
                className="nav-indicator"
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
            <span className="nav-text">{item.title}</span>
          </>
        ),
      })),
  }))
  const brand = (
    <div className={`brand ${collapsed && !mobile ? "brand-collapsed" : ""}`}>
      <span className="brand-mark">
        <SafetyCertificateOutlined />
      </span>
      <span className="brand-name">Yunzai Guard</span>
    </div>
  )
  const menu = (
    <motion.div
      layout={!reduced}
      transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
    >
      <Menu
        mode="inline"
        theme="dark"
        selectedKeys={[current.id]}
        items={items}
        onClick={({ key }) => navigate(key)}
      />
    </motion.div>
  )
  const theme = useTheme()
  const group = groups.find(item => item.ids.includes(current.id))?.label
  const version = String(ctx.meta?.version ?? "")
  // 控制台热更新后，已打开的页面仍是旧代码：提示刷新。
  const servedVersion = String(ctx.overview?.version ?? "")
  const outdated = Boolean(version && servedVersion && servedVersion !== version)

  if (ctx.booting)
    return (
      <div className="boot-screen">
        <Spin size="large" />
      </div>
    )
  if (!ctx.session) return <Login />

  return (
    <Layout className="console-layout">
      {!mobile && (
        <Layout.Sider
          width={216}
          collapsedWidth={68}
          collapsed={collapsed}
          className="console-sider"
          trigger={null}
        >
          {brand}
          {menu}
          <div className="sider-bottom">
            <Badge status={ctx.connected ? "success" : "error"} />
            {!collapsed && <span>{version ? `v${version}` : "—"}</span>}
          </div>
        </Layout.Sider>
      )}
      <Drawer
        placement="left"
        width={252}
        title={brand}
        open={mobile && menuOpen}
        onClose={() => setMenuOpen(false)}
        rootClassName="navigation-drawer"
        styles={{ body: { padding: 0 } }}
      >
        {menu}
      </Drawer>
      <Layout
        className={`workspace-layout ${ctx.dirty ? "has-draft" : ""}`}
        style={{
          marginLeft: mobile ? 0 : collapsed ? 68 : 216,
          ["--sidebar-offset" as string]: mobile ? "0px" : collapsed ? "68px" : "216px",
        }}
      >
        <Layout.Header className="console-header">
          <Space size={12} className="header-leading">
            <Button
              type="text"
              icon={mobile || collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              aria-label={mobile ? "打开导航" : collapsed ? "展开导航" : "收起导航"}
              onClick={() => (mobile ? setMenuOpen(!menuOpen) : setCollapsed(!collapsed))}
            />
            <span className="workspace-name">{group}</span>
            {/demo/i.test(version) && <Tag className="demo-tag">DEMO</Tag>}
          </Space>
          <Space size={12} className="header-actions">
            <span className={`header-status ${ctx.connected ? "" : "offline"}`}>
              <Badge status={ctx.connected ? "success" : "error"} />
              {ctx.connected ? "在线" : "已断开"}
            </span>
            <Tooltip title="刷新">
              <Button
                type="text"
                icon={<ReloadOutlined spin={ctx.loading} />}
                aria-label="刷新"
                disabled={ctx.saving}
                onClick={() => run(() => ctx.reload(true))}
              />
            </Tooltip>
            <ThemeToggle dark={theme.dark} />
            <Dropdown
              menu={{
                items: [
                  { key: "security", icon: <LockOutlined />, label: "登录与会话" },
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录" },
                ],
                onClick: ({ key }) => (key === "logout" ? run(ctx.logout) : navigate("security")),
              }}
              trigger={["click"]}
            >
              <Button type="text" className="account-button" aria-label="管理员">
                <Avatar size={28} icon={<UserOutlined />} />
              </Button>
            </Dropdown>
          </Space>
        </Layout.Header>
        <Layout.Content className="console-content">
          {outdated && (
            <div className="reload-banner" role="status">
              <span>控制台已更新至 {servedVersion}，刷新页面以加载新版本</span>
              <Button size="small" type="primary" onClick={() => location.reload()}>
                刷新
              </Button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <h1>{current.title}</h1>
              <p>{current.description}</p>
            </div>
            <ConfigurationState />
          </div>
          <motion.div
            key={current.id}
            className={ctx.saving ? "page-frame saving" : "page-frame"}
            initial={reduced ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <Suspense
              fallback={
                <div className="page-loading">
                  <Skeleton active paragraph={{ rows: 7 }} />
                </div>
              }
            >
              {current.id === "settings" ? (
                <View section={route.section} onChange={(section: string) => navigate(section)} />
              ) : (
                <View />
              )}
            </Suspense>
          </motion.div>
        </Layout.Content>
        <div className="change-dock">
          <ChangeBar />
        </div>
      </Layout>
    </Layout>
  )
}
