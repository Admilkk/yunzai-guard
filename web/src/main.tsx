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
  darkItemColor: "#b1bac9",
  darkItemHoverBg: "#ffffff0a",
  darkItemHoverColor: "#f2f5fb",
  darkItemSelectedBg: "#283750",
  darkItemSelectedColor: "#e5edff",
  darkGroupTitleColor: "#8793a6",
  itemBorderRadius: 8,
  itemHeight: 40,
  itemMarginBlock: 3,
}

const lightTheme: ThemeConfig = {
  token: {
    colorPrimary: "#3563cf",
    colorPrimaryBg: "#eef3ff",
    colorPrimaryBgHover: "#e4ecff",
    colorPrimaryBorder: "#d1defa",
    colorPrimaryBorderHover: "#9bb6ef",
    colorPrimaryHover: "#416fdb",
    colorPrimaryActive: "#264da9",
    colorPrimaryText: "#3563cf",
    colorPrimaryTextHover: "#264da9",
    colorPrimaryTextActive: "#203f88",
    colorLink: "#3563cf",
    colorLinkHover: "#264da9",
    colorLinkActive: "#203f88",
    colorSuccess: "#25805c",
    colorSuccessBg: "#f0f8f4",
    colorSuccessBgHover: "#e4f2eb",
    colorSuccessBorder: "#cce5d7",
    colorSuccessBorderHover: "#98cdb0",
    colorSuccessHover: "#34916c",
    colorSuccessActive: "#1c684a",
    colorSuccessText: "#226846",
    colorSuccessTextHover: "#1c684a",
    colorSuccessTextActive: "#174f38",
    colorWarning: "#94651b",
    colorWarningBg: "#fff9ed",
    colorWarningBgHover: "#fcf0d7",
    colorWarningBorder: "#efdfb9",
    colorWarningBorderHover: "#dcc180",
    colorWarningHover: "#a97727",
    colorWarningActive: "#7b5114",
    colorWarningText: "#825b1c",
    colorWarningTextHover: "#7b5114",
    colorWarningTextActive: "#644310",
    colorError: "#c04451",
    colorErrorBg: "#fff2f3",
    colorErrorBgHover: "#fbe5e8",
    colorErrorBorder: "#f0cdd2",
    colorErrorBorderHover: "#df9da6",
    colorErrorHover: "#d15763",
    colorErrorActive: "#a33440",
    colorErrorText: "#b23b48",
    colorErrorTextHover: "#a33440",
    colorErrorTextActive: "#882834",
    colorInfo: "#3563cf",
    colorInfoBg: "#f1f5fd",
    colorInfoBgHover: "#e6eefb",
    colorInfoBorder: "#d1def4",
    colorInfoBorderHover: "#a5bfe9",
    colorInfoHover: "#4876df",
    colorInfoActive: "#264da9",
    colorInfoText: "#355fba",
    colorInfoTextHover: "#264da9",
    colorInfoTextActive: "#203f88",
    colorText: "#202733",
    colorTextHeading: "#202733",
    colorTextSecondary: "#606b7a",
    colorTextTertiary: "#687486",
    colorTextQuaternary: "#7c8797",
    colorTextDisabled: "#949dab",
    colorTextLightSolid: "#ffffff",
    colorBgLayout: "#f5f6f8",
    colorBgContainer: "#ffffff",
    colorBgElevated: "#ffffff",
    colorBgContainerDisabled: "#f0f2f5",
    colorBgTextHover: "#f0f3f9",
    colorBgTextActive: "#e8edf6",
    colorBgSpotlight: "#273142",
    colorBorder: "#dfe4eb",
    colorBorderSecondary: "#edf0f4",
    colorFillAlter: "#f8f9fb",
    colorFillSecondary: "#eef1f5",
    colorFillTertiary: "#f3f5f8",
    colorSplit: "#edf0f4",
    borderRadius: 8,
    fontSize: 14,
    controlHeight: 36,
    fontFamily,
  },
  components: {
    Menu: sidebarMenu,
    Card: { headerFontSize: 14, headerHeight: 50, bodyPadding: 20 },
    Table: {
      headerBg: "#f8f9fb",
      headerColor: "#606b7a",
      headerSplitColor: "transparent",
      borderColor: "#edf0f4",
      rowHoverBg: "#f4f7fd",
      rowSelectedBg: "#eef3ff",
      rowSelectedHoverBg: "#e4ecff",
      bodySortBg: "transparent",
      headerSortActiveBg: "#eef2fa",
      headerSortHoverBg: "#eef2fa",
      cellPaddingBlock: 12,
    },
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      primaryColor: "#ffffff",
      dangerColor: "#ffffff",
      solidTextColor: "#ffffff",
      defaultColor: "#394454",
      defaultBg: "#ffffff",
      defaultBorderColor: "#dfe4eb",
      defaultHoverColor: "#3563cf",
      defaultHoverBg: "#f8faff",
      defaultHoverBorderColor: "#9bb6ef",
      defaultActiveColor: "#264da9",
      defaultActiveBg: "#eef3ff",
      defaultActiveBorderColor: "#7f9edd",
      fontWeight: 550,
    },
    Tabs: { titleFontSize: 14 },
    Tag: { defaultBg: "#f1f3f6", defaultColor: "#606b7a" },
    Drawer: { footerPaddingBlock: 14, footerPaddingInline: 20 },
  },
}

const darkTheme: ThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  token: {
    ...lightTheme.token,
    colorPrimary: "#416bd5",
    colorPrimaryBg: "#202d49",
    colorPrimaryBgHover: "#2a3b5e",
    colorPrimaryBorder: "#3d5688",
    colorPrimaryBorderHover: "#6688c8",
    colorPrimaryHover: "#416fdb",
    colorPrimaryActive: "#3458b4",
    colorPrimaryText: "#9db9ff",
    colorPrimaryTextHover: "#c0d1ff",
    colorPrimaryTextActive: "#d6e1ff",
    colorLink: "#9db9ff",
    colorLinkHover: "#c0d1ff",
    colorLinkActive: "#d6e1ff",
    colorSuccess: "#79c7a0",
    colorSuccessBg: "#172b23",
    colorSuccessBgHover: "#203b2e",
    colorSuccessBorder: "#2e4d3c",
    colorSuccessBorderHover: "#47765a",
    colorSuccessHover: "#94d7b4",
    colorSuccessActive: "#62b189",
    colorSuccessText: "#9bd9ba",
    colorSuccessTextHover: "#b3e5cc",
    colorSuccessTextActive: "#c7eedc",
    colorWarning: "#e0b56b",
    colorWarningBg: "#302819",
    colorWarningBgHover: "#40331d",
    colorWarningBorder: "#5b4928",
    colorWarningBorderHover: "#806638",
    colorWarningHover: "#edc786",
    colorWarningActive: "#c99d51",
    colorWarningText: "#e0b56b",
    colorWarningTextHover: "#edc786",
    colorWarningTextActive: "#f3d6a4",
    colorError: "#ee929d",
    colorErrorBg: "#321f26",
    colorErrorBgHover: "#452a33",
    colorErrorBorder: "#643642",
    colorErrorBorderHover: "#8c4e5d",
    colorErrorHover: "#f5adb6",
    colorErrorActive: "#d87784",
    colorErrorText: "#ee929d",
    colorErrorTextHover: "#f5adb6",
    colorErrorTextActive: "#fac5cb",
    colorInfo: "#9db9ff",
    colorInfoBg: "#1c2942",
    colorInfoBgHover: "#263854",
    colorInfoBorder: "#344c76",
    colorInfoBorderHover: "#4d6d9e",
    colorInfoHover: "#b3caff",
    colorInfoActive: "#84a3ef",
    colorInfoText: "#9db9ff",
    colorInfoTextHover: "#c0d1ff",
    colorInfoTextActive: "#d6e1ff",
    colorText: "#e8edf5",
    colorTextHeading: "#e8edf5",
    colorTextSecondary: "#b1bbc9",
    colorTextTertiary: "#96a2b3",
    colorTextQuaternary: "#7f8b9b",
    colorTextDisabled: "#717c8c",
    colorBgLayout: "#101318",
    colorBgContainer: "#191e26",
    colorBgElevated: "#232a35",
    colorBgContainerDisabled: "#222a35",
    colorBgTextHover: "#263140",
    colorBgTextActive: "#2c3b50",
    colorBgSpotlight: "#303b4d",
    colorBorder: "#343e4c",
    colorBorderSecondary: "#2b3441",
    colorFillAlter: "#1d242e",
    colorFillSecondary: "#28313e",
    colorFillTertiary: "#222a35",
    colorSplit: "#2b3441",
  },
  components: {
    ...lightTheme.components,
    Table: {
      ...lightTheme.components?.Table,
      headerBg: "#1d242e",
      headerColor: "#b1bbc9",
      borderColor: "#2b3441",
      rowHoverBg: "#222d40",
      rowSelectedBg: "#202d49",
      rowSelectedHoverBg: "#2a3b5e",
      headerSortActiveBg: "#263146",
      headerSortHoverBg: "#263146",
    },
    Button: {
      ...lightTheme.components?.Button,
      dangerColor: "#25151a",
      defaultColor: "#d3dce8",
      defaultBg: "#191e26",
      defaultBorderColor: "#3d495a",
      defaultHoverColor: "#c0d1ff",
      defaultHoverBg: "#232e40",
      defaultHoverBorderColor: "#6688c8",
      defaultActiveColor: "#d6e1ff",
      defaultActiveBg: "#293954",
      defaultActiveBorderColor: "#8aa8e0",
    },
    Tag: { defaultBg: "#252e3b", defaultColor: "#b1bbc9" },
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
