# ADR 0002：codegraph 仅作可选参考后端

## 背景

S4 证实 `@colbymchenry/codegraph@1.6.3` 的公开 API 可在 Windows/Node24 调用，但实际安装约 263 MB，平台包严格同版本绑定；公开 ESM 示例与运行时导出形状不一致。

## 决定

P1 自写最小 L0/L1，不引入 codegraph 核心依赖。任何未来可选后端必须锁精确版本、独立 adapter、走同一三态/caveats 契约，并重新运行所有 barrel/覆盖红队。

## 后果

承担最小 extractor 的开发成本，换取小依赖面、可控降级与许可证隔离。不能宣称 ANO 继承 codegraph 的语言/性能能力。
