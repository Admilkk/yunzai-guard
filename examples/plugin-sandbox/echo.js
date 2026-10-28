// 放入 data/yunzai-guard/scripts/echo.js，由受限脚本执行器运行。
globalThis.onMessage = async event => {
  await Promise.resolve()
  guard.writeText("last-message.json", JSON.stringify({ message: event.message }))
  guard.reply(`沙箱脚本收到：${event.message}`)
}
