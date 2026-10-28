import { flushSync } from "react-dom"
import { Button, Tooltip } from "antd"
import { MoonOutlined, SunOutlined } from "@ant-design/icons"
import { AnimatePresence, motion } from "motion/react"
import { toggleTheme } from "../theme"

/** 明暗切换按钮：新主题从按钮处圆形扩散。 */
export function ThemeToggle({ dark }: { dark: boolean }) {
  return (
    <Tooltip title={dark ? "浅色" : "深色"}>
      <Button
        type="text"
        className="theme-toggle"
        aria-label="切换明暗"
        onClick={event => {
          const box = event.currentTarget.getBoundingClientRect()
          toggleTheme(box.left + box.width / 2, box.top + box.height / 2, flushSync)
        }}
        icon={
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={dark ? "moon" : "sun"}
              className="theme-toggle-icon"
              initial={{ rotate: -90, scale: 0.4, opacity: 0 }}
              animate={{ rotate: 0, scale: 1, opacity: 1 }}
              exit={{ rotate: 90, scale: 0.4, opacity: 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 26 }}
            >
              {dark ? <MoonOutlined /> : <SunOutlined />}
            </motion.span>
          </AnimatePresence>
        }
      />
    </Tooltip>
  )
}
