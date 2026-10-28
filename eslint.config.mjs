import { fileURLToPath } from "node:url"
import tseslint from "typescript-eslint"

/**
 * 只启用不改变行为的风格规则，格式交给 Prettier。
 * 运行时代码（src/runtime 等）刻意使用原始引用和显式判空，所以不启用
 * prefer-optional-chain、no-unnecessary-template-expression 和
 * no-unnecessary-type-assertion：它们会去掉防御性的字符串转换与类型断言。
 */
export default [
  { ignores: ["dist/**", "native/**", "node_modules/**", "**/*.js", "**/*.mjs", "tests/**"] },
  {
    files: ["src/**/*.{ts,cts}", "web/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["./tsconfig.json", "./web/tsconfig.json"],
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "object-shorthand": ["error", "always"],
      "prefer-template": "error",
      "prefer-object-spread": "error",
      "prefer-spread": "error",
      "prefer-arrow-callback": "error",
      "prefer-exponentiation-operator": "error",
      "logical-assignment-operators": ["error", "always"],
      "operator-assignment": ["error", "always"],
      "arrow-body-style": ["error", "as-needed"],
      "no-useless-return": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-lonely-if": "error",
      "no-unneeded-ternary": "error",
      "no-extra-boolean-cast": "error",
      "no-useless-concat": "error",
      "no-useless-rename": "error",
      "no-useless-computed-key": "error",
      "@typescript-eslint/dot-notation": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/consistent-generic-constructors": "error",
      "@typescript-eslint/prefer-function-type": "error",
      "@typescript-eslint/no-unnecessary-type-arguments": "error",
      "@typescript-eslint/consistent-indexed-object-style": "error",
      "@typescript-eslint/no-unused-vars": ["error", { args: "none", ignoreRestSiblings: true }],
    },
  },
]
