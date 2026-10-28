import React from "react"
import { createRoot } from "react-dom/client"
import { App, ConfigProvider, theme as antTheme } from "antd"
import type { ThemeConfig } from "antd"
import zhCN from "antd/locale/zh_CN"
import { MotionConfig } from "motion/react"
import { ConsoleProvider } from "./state"
import ConsoleApp from "./App"
import { useTheme } from "./theme"
import "antd/dist/reset.css"
import "./styles.css"
import "./styles/tokens.css"
import "./styles/refinements.css"

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

const sidebarMenu = {
  darkItemBg: "transparent",
  darkSubMenuItemBg: "transparent",
  darkItemColor: "#a7b3ad",
  darkItemHoverBg: "#ffffff0a",
  darkItemHoverColor: "#f1f6f3",
  darkItemSelectedBg: "transparent",
  darkItemSelectedColor: "#ecfbf5",
  darkGroupTitleColor: "#718079",
  itemBorderRadius: 8,
  itemHeight: 40,
  itemMarginBlock: 3,
}

const lightTheme: ThemeConfig = {
  token: {
    colorPrimary: "#237761",
    colorSuccess: "#237761",
    colorWarning: "#9a671f",
    colorError: "#bd4851",
    colorText: "#202724",
    colorTextSecondary: "#606c66",
    colorBgLayout: "#f4f6f5",
    colorBgContainer: "#ffffff",
    colorBorder: "#dde4e0",
    colorBorderSecondary: "#ebefec",
    borderRadius: 8,
    fontSize: 14,
    controlHeight: 36,
    fontFamily,
  },
  components: {
    Menu: sidebarMenu,
    Card: { headerFontSize: 14, headerHeight: 50, bodyPadding: 20 },
    Table: {
      headerBg: "#f7f9f8",
      headerColor: "#606c66",
      headerSplitColor: "transparent",
      borderColor: "#ebefec",
      rowHoverBg: "#f5f8f6",
      bodySortBg: "transparent",
      headerSortActiveBg: "#eef3f0",
      headerSortHoverBg: "#eef3f0",
      cellPaddingBlock: 12,
    },
    Button: { primaryShadow: "none", defaultShadow: "none", fontWeight: 550 },
    Tabs: { titleFontSize: 14 },
    Tag: { defaultBg: "#f2f5f3" },
    Drawer: { footerPaddingBlock: 14, footerPaddingInline: 20 },
  },
}

const darkTheme: ThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  token: {
    ...lightTheme.token,
    colorPrimary: "#63c5a6",
    colorSuccess: "#63c5a6",
    colorWarning: "#d6a557",
    colorError: "#eb858c",
    colorText: "#e2e9e5",
    colorTextSecondary: "#a0aca5",
    colorBgLayout: "#0e1412",
    colorBgContainer: "#151d1a",
    colorBgElevated: "#1b2521",
    colorBorder: "#2a3530",
    colorBorderSecondary: "#222d28",
  },
  components: {
    ...lightTheme.components,
    Table: {
      ...lightTheme.components?.Table,
      headerBg: "#19221e",
      headerColor: "#a0aca5",
      borderColor: "#222d28",
      rowHoverBg: "#1b2521",
      headerSortActiveBg: "#202c27",
      headerSortHoverBg: "#202c27",
    },
    Tag: { defaultBg: "#202c27" },
  },
}

/** 按当前明暗选择组件主题。 */
function Themed({ children }: { children: React.ReactNode }) {
  const { dark } = useTheme()
  return (
    <ConfigProvider locale={zhCN} theme={dark ? darkTheme : lightTheme}>
      {children}
    </ConfigProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Themed>
      <App>
        <MotionConfig reducedMotion="user">
          <ConsoleProvider>
            <ConsoleApp />
          </ConsoleProvider>
        </MotionConfig>
      </App>
    </Themed>
  </React.StrictMode>,
)
