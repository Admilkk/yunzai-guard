import React from "react"
import { createRoot } from "react-dom/client"
import { App, ConfigProvider } from "antd"
import zhCN from "antd/locale/zh_CN"
import { MotionConfig } from "motion/react"
import { ConsoleProvider } from "./state"
import ConsoleApp from "./App"
import "antd/dist/reset.css"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
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
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
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
      }}
    >
      <App>
        <MotionConfig reducedMotion="user">
          <ConsoleProvider>
            <ConsoleApp />
          </ConsoleProvider>
        </MotionConfig>
      </App>
    </ConfigProvider>
  </React.StrictMode>,
)
