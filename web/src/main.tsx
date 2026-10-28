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

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'

// 侧栏在明暗两套主题下都是深色。
const sidebarMenu = {
  darkItemBg: "transparent",
  darkSubMenuItemBg: "transparent",
  darkItemColor: "#9fb0a9",
  darkItemHoverBg: "#ffffff0d",
  darkItemHoverColor: "#f1f6f3",
  darkItemSelectedBg: "transparent",
  darkItemSelectedColor: "#ecfbf5",
  darkGroupTitleColor: "#5f726b",
  itemBorderRadius: 8,
  itemHeight: 40,
  itemMarginBlock: 3,
}

const lightTheme: ThemeConfig = {
  token: {
    colorPrimary: "#1f7a66",
    colorSuccess: "#24936f",
    colorWarning: "#b7771f",
    colorError: "#c2454d",
    colorText: "#1d2420",
    colorTextSecondary: "#66706a",
    colorBgLayout: "#f3f5f4",
    colorBgContainer: "#ffffff",
    colorBorder: "#dfe5e2",
    colorBorderSecondary: "#eef1ef",
    borderRadius: 8,
    fontSize: 13,
    controlHeight: 34,
    fontFamily,
  },
  components: {
    Menu: sidebarMenu,
    Card: { headerFontSize: 14, headerHeight: 52, bodyPadding: 20 },
    Table: {
      headerBg: "#f7f9f8",
      headerColor: "#66706a",
      headerSplitColor: "transparent",
      borderColor: "#eef1ef",
      rowHoverBg: "#f5faf8",
      bodySortBg: "transparent",
      headerSortActiveBg: "#f0f4f2",
      headerSortHoverBg: "#f0f4f2",
      cellPaddingBlock: 12,
    },
    Button: { primaryShadow: "none", defaultShadow: "none", fontWeight: 520 },
    Tabs: { titleFontSize: 13 },
    Tag: { defaultBg: "#f2f5f3" },
    Drawer: { footerPaddingBlock: 14, footerPaddingInline: 20 },
  },
}

const darkTheme: ThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  token: {
    ...lightTheme.token,
    colorPrimary: "#4cc29f",
    colorSuccess: "#4cc29f",
    colorWarning: "#d9a54f",
    colorError: "#e5757c",
    colorText: "#e6ebe8",
    colorTextSecondary: "#9aa59f",
    colorBgLayout: "#0d1311",
    colorBgContainer: "#151d1a",
    colorBgElevated: "#1b2420",
    colorBorder: "#26302c",
    colorBorderSecondary: "#1f2825",
  },
  components: {
    ...lightTheme.components,
    Table: {
      ...lightTheme.components?.Table,
      headerBg: "#18211e",
      headerColor: "#9aa59f",
      borderColor: "#1f2825",
      rowHoverBg: "#1a2420",
      headerSortActiveBg: "#1c2622",
      headerSortHoverBg: "#1c2622",
    },
    Tag: { defaultBg: "#1c2622" },
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
