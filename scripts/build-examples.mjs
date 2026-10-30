// 由当前默认配置与字段说明生成仓库根目录的 YAML 配置示例，保证示例与代码一致。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { settingsDefaults } from "../dist/config/index.js"
import { renderSettings } from "../dist/config/settings-file.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const examples = {
  // 完整示例：列出全部配置项与默认值，复制需要的部分到 settings.yaml 即可。
  "settings.example.yaml": settingsDefaults(),
  "settings.plugin-sandbox.example.yaml": {
    pluginSandbox: {
      defaults: { timeoutMs: 1000, memoryMiB: 16, hookAction: "deny", violationAction: "deny" },
      plugins: [
        {
          id: "echo",
          enabled: true,
          match: "#echo*",
          capabilities: ["reply", "writeText"],
          hookAction: "audit",
          rules: [],
        },
      ],
    },
  },
}
for (const [name, value] of Object.entries(examples))
  fs.writeFileSync(path.join(root, name), renderSettings(value))
console.log(`examples: ${Object.keys(examples).join(", ")}`)
