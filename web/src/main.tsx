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

const lightTheme: ThemeConfig = {
  token: {
    colorPrimary: "#337265",
    colorSuccess: "#32755a",
    colorWarning: "#a66b20",
    colorError: "#bd4f55",
    colorText: "#252a27",
    colorTextSecondary: "#707873",
    colorBgLayout: "#f5f6f4",
    colorBgContainer: "#ffffff",
    colorBorder: "#e1e5e1",
    borderRadius: 8,
    fontSize: 13,
    controlHeight: 34,
    fontFamily,
  },
  components: {
    Menu: {
      itemBg: "#f8f9f7",
      itemColor: "#59615c",
      itemHoverBg: "#edf0ec",
      itemHoverColor: "#252a27",
      itemSelectedBg: "#e5eeea",
      itemSelectedColor: "#285f52",
      itemBorderRadius: 7,
      itemHeight: 40,
      itemMarginBlock: 4,
    },
    Card: { headerFontSize: 13, headerHeight: 48, bodyPadding: 20 },
    Table: {
      headerBg: "#f7f8f6",
      headerColor: "#69716c",
      borderColor: "#e9ece8",
      cellPaddingBlock: 12,
    },
    Button: { primaryShadow: "none", defaultShadow: "none" },
    Tabs: { titleFontSize: 13 },
    Drawer: { footerPaddingBlock: 14, footerPaddingInline: 20 },
  },
}

const darkTheme: ThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  token: {
    ...lightTheme.token,
    colorPrimary: "#5fb3a0",
    colorSuccess: "#5fb08a",
    colorWarning: "#d4a24c",
    colorError: "#e0777c",
    colorText: "#e4e8e5",
    colorTextSecondary: "#9aa39d",
    colorBgLayout: "#121513",
    colorBgContainer: "#1b1f1c",
    colorBgElevated: "#222723",
    colorBorder: "#2c322e",
  },
  components: {
    ...lightTheme.components,
    Menu: {
      ...lightTheme.components?.Menu,
      itemBg: "#171a18",
      itemColor: "#a5aca7",
      itemHoverBg: "#212622",
      itemHoverColor: "#e4e8e5",
      itemSelectedBg: "#1f342d",
      itemSelectedColor: "#8fd1c1",
    },
    Table: {
      ...lightTheme.components?.Table,
      headerBg: "#1f2421",
      headerColor: "#9aa39d",
      borderColor: "#252b27",
    },
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
