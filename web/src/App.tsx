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
  FileTextOutlined,
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
import { ChangeBar } from "./components/ChangeBar"
import { ConfigurationState } from "./components/Status"
import Overview from "./pages/Overview"
import Login from "./pages/Login"
import type { SettingsSection } from "./pages/Settings"

const pages: Array<{
  id: string
  title: string
  icon: React.ReactNode
  component: ComponentType<any>
}> = [
  { id: "overview", title: "监控总览", icon: <DashboardOutlined />, component: Overview },
  {
    id: "plugins",
    title: "插件权限",
    icon: <ApiOutlined />,
    component: lazy(() => import("./pages/Plugins")),
  },
  {
    id: "policies",
    title: "全局规则",
    icon: <ControlOutlined />,
    component: lazy(() => import("./pages/Policies")),
  },
  {
    id: "profiles",
    title: "行为画像",
    icon: <RadarChartOutlined />,
    component: lazy(() => import("./pages/Profiles")),
  },
  {
    id: "alerts",
    title: "告警中心",
    icon: <BellOutlined />,
    component: lazy(() => import("./pages/Alerts")),
  },
  {
    id: "audit",
    title: "行为审计",
    icon: <AuditOutlined />,
    component: lazy(() => import("./pages/Audit")),
  },
  {
    id: "logs",
    title: "运行日志",
    icon: <CodeOutlined />,
    component: lazy(() => import("./pages/Logs")),
  },
  {
    id: "settings",
    title: "系统设置",
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

/** 返回地址栏中 `?` 及之后的部分。 */
function currentSearch(): string {
  const hash = location.hash
  const at = hash.indexOf("?")
  return at < 0 ? "" : hash.slice(at)
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
  const navigateRef = useRef<(name: string, search?: string) => void>(() => {})

  /** 切换页面并写入地址栏，保留页面筛选参数。 */
  function navigate(name: string, search = "") {
    if (!ctx.commitRaw() && name !== "advanced") {
      history.replaceState(null, "", `#${route.name}`)
      return
    }
    setRoute(routeFor(name))
    setMenuOpen(false)
    history.replaceState(null, "", `#${name}${search}`)
  }
  navigateRef.current = navigate

  useEffect(() => {
    const resize = () => setMobile(innerWidth <= 800)
    const change = () => navigateRef.current(currentRoute().name, currentSearch())
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
    { label: "管理", ids: ["overview", "plugins", "policies", "profiles"] },
    { label: "记录与系统", ids: ["audit", "alerts", "logs", "settings"] },
  ]
  const items = groups.map(group => ({
    type: "group" as const,
    label: group.label,
    children: pages
      .filter(item => group.ids.includes(item.id))
      .map(item => ({ key: item.id, icon: item.icon, label: item.title })),
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
        theme="light"
        selectedKeys={[current.id]}
        items={items}
        onClick={({ key }) => navigate(key)}
      />
    </motion.div>
  )
  const version = String(ctx.meta?.version ?? "")

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
            <FileTextOutlined />
            <span>{collapsed ? "" : version}</span>
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
            <span className="workspace-name">行为监控台</span>
            {/demo/i.test(version) && <Tag className="demo-tag">DEMO</Tag>}
          </Space>
          <Space size={12} className="header-actions">
            <span className="header-status">
              <Badge status={ctx.connected ? "success" : "error"} />
              {ctx.connected ? "宿主已连接" : "宿主连接中断"}
            </span>
            <Tooltip title="刷新当前数据">
              <Button
                type="text"
                icon={<ReloadOutlined spin={ctx.loading} />}
                aria-label="刷新当前数据"
                disabled={ctx.saving}
                onClick={() => run(() => ctx.reload(true))}
              />
            </Tooltip>
            <Dropdown
              menu={{
                items: [
                  { key: "security", icon: <LockOutlined />, label: "会话与面板" },
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
          <div className="page-heading">
            <h1>{current.title}</h1>
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
                  <Spin />
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
