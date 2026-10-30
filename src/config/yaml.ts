// YAML 库的唯一入口。构建时由 scripts/build-vendor.mjs 把 "yaml" 改指向 dist/vendor/yaml，
// 发布包不依赖 Yunzai 或插件目录里安装的同名包。
export {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  YAMLMap,
  type Node,
  type Pair,
} from "yaml"
