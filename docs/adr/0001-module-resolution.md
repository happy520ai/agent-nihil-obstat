# ADR 0001：P1 使用内置轻量模块解析

## 背景

S7 在合成 workspace 上比较了自写 resolver、项目自带 TypeScript resolver 和宿主 TS。用户禁止执行宿主项目 node_modules 的 TypeScript。自写路线和自带 TS 路线在 7 个用例均得 5 resolved + 2 unknown。

## 决定

P1 使用零额外运行时 resolver 依赖的内置路线：相对路径、扩展名替换、index、常见 paths、明确支持的 exports/workspace。其余返回 unknown；禁止通过 `import('typescript')` 解析宿主安装。codegraph 保留为可选参考，不设为核心依赖。

## 后果

- 小型机制实测自写路线启动/解析成本较低，但不可外推。
- 复杂条件 exports、tsconfig 继承、project references 或自定义 bundler 规则可能 unknown。
- unknown 永远计入 impact，但不计入 T1 覆盖；默认 strict 偏严。
- 模块解析失败不得被误记为纯类型，也不得无提示消失。

证据：`docs/spikes/S7.md` 与 `docs/evidence/s7-module-resolution.json`。
