# ADR-014：Python 语言包——先证据（pytest），后结构（L0/L1）

日期：2026-11-27
状态：**已接受**。具名审阅人：project owner；审阅日期：2026-11-27。依据本次会话的实施指令与具名确认，授权 M23 开工。
任务：PY-01（登记）～ PY-12（收口），里程碑 M23
上游决策：`docs/adr/ADR-013-personal-project-brain.md`（已接受，只授权 M19–M22）
输入契约：`AGENTS.md`、`docs/limitations.md`、`ano-architecture-v1.0.md` §5.3/§7、`docs/adr/ADR-010-structure-intelligence.md`、`src/gate/verify.ts`、`src/gate/evidence.ts`、`src/structure/extractor.ts`、`src/structure/extractors/ts.ts`、`src/hooks/pre-tool.ts`、`src/core/config.ts`
实施规格：`docs/m23-implementation-spec.md`

> 定位说明：ADR-013 已接受，且只授权 M19–M22；它把"新语言结构分析"列为范围外。本 ADR **不改写** ADR-013 的已接受文本，而是作为独立决策：① 开放 M23 一个里程碑；② 修订 ADR-013 §11 的停止扩展契约复位条件，改为"M22 与 M23 都关闭后复位"。M22 的 T-176 收口时必须引用本条，不得单独复位契约。

---

## 1. 背景与问题定义

vibe coding 第二常见的项目形态是 Python（AI 应用、爬虫、脚本、后端）。用户的电商项目里已经有 Python 虚拟环境（`server/.venv-scrapling`）。

源码实读的现状（2026-11-27）：

| 位置 | 现状 | 对 Python 项目的后果 |
|---|---|---|
| `src/gate/verify.ts` | 运行器只接受 `node`/`node.exe`（`NODE_EXECUTABLES`），裸 `node` 会钉到当前运行时；自定义 reporter 被拒绝 | **pytest 无法作为证据运行** |
| `src/gate/evidence.ts` `parseTestCounts` | 只认 `# pass N` / `ℹ pass N` 这类 Node TAP 风格的统计行 | 即使能跑也数不清 |
| `src/structure/extractors/ts.ts` | `SUPPORTED_EXTENSIONS` 只有 6 个 TS/JS 扩展名 | `.py` 全是盲区 |
| `src/hooks/pre-tool.ts` | 自己**硬编码**了一份 `SUPPORTED_PRE_TOOL_EXTENSIONS`（注释写着与 ts.ts 同步），没有从提取器派生 | Python 支持上线后，改 `.py` 仍会被当作"不受支持语言"直接放行，**静默漏防** |
| `src/core/config.ts` | 只解析 `profile` 与 `hooks.*`，未知键产生 warning | 没有地方配置 Python 解释器和源码根 |
| 依赖 `tree-sitter-wasms` | 已自带 `tree-sitter-python.wasm` | 加 Python **不需要新增第三方依赖** |

**一句话问题定义**：在不新增依赖、不放宽 Gate、不执行被分析代码的前提下，让 Python 项目的"没证据不算完成"先生效，再让 `.py` 从盲区变成可探查、可算影响范围、可计 T1 覆盖的受支持语言，并在端到端验收通过前不对外宣称支持。

**"修好了"的判据**：
1. 在隔离 Python 项目上，pytest 的全通过、有失败、有 skip、无测试、收集错误五种场景，都得到与 Node 同类场景一致的 Verdict；
2. 伪造全绿的已知手段全部被拒；
3. Python 夹具的每条边与人工金标准逐条一致；
4. 结构开关关闭时，现有 TS/JS 证据数值字节级不变；
5. 支持状态如实落在 `supported`（有真实项目证据）或 `supported-fixture-only`（只有夹具证据）。

---

## 2. 硬边界（全节为硬边界，实现与测试不得违反）

1. **零新依赖**：只用已有的 `web-tree-sitter` + `tree-sitter-wasms`。JUnit XML 解析手写，不引入 XML 库。
2. **静态且隔离**：结构解析只用 WASM 语法树，**不执行**被分析的 Python 代码，不调用解释器做解析，不读取 `site-packages` 或虚拟环境内容。只有 `verify` 按声明的 argv 运行测试，与 Node 测试执行项目代码的边界相同。
3. **不为 Python 放宽 Gate**：done 公式、skipped/todo/cancelled 阻止完成、源码指纹绑定、evidence_id 要求，对 Python 与 TS/JS 完全一致。
4. **Node 证据路径零行为变化**：抽出适配器接口前后，同一输入的 Evidence 与 Verdict 必须字节级一致（保护测试），现有 verify 红队测试零改动全绿。
5. **结果通道由 ANO 独占**：pytest 的结果文件由 ANO 指定和读取；用户不能提供或改写结果通道。
6. **解释器不走 PATH**：拒绝裸 `python`/`python3`/`py`/`pytest`，理由与钉住 `node` 相同（防 PATH 劫持）。
7. **不对外宣称未验证的支持**：未通过 §6 两级门槛前，README、客户端矩阵、doctor 都不得写"支持 Python"。
8. **受支持语言单一来源**：钩子、Gate、结构层对"受支持扩展名"的判断必须从同一个导出派生，禁止再维护手写副本。
9. **七工具不变**：不新增 MCP 工具；Python 能力经现有 `verify`/`explore`/`brief` 暴露。
10. **范围冻结**：只做 pytest 与 Python L0/L1。L2 调用图、类型推断、其他语言、unittest/nose 等其他 Python 测试框架都不在本 ADR 范围（§8）。

---

## 3. 决定一：顺序是先证据，后结构

M23 分两段：**M23a pytest 证据**（PY-02～PY-06）在前，**M23b Python 结构**（PY-07～PY-11）在后，两段只在 PY-10 汇合。

理由：没有结构图，Python 文件只是盲区，Gate 还能退到 T0；但没有测试证据，"没证据不算完成"在 Python 上**直接失效**。证据层的工作量小、收益大，先做。

M23 与 M22 没有文件冲突（M22 剩下的只是真实项目上的人工步骤），可以并行。

---

## 4. 决定二：证据适配器（M23a）

### 4.1 适配器接口

`src/gate/adapters/` 下新增 `EvidenceAdapter` 接口（`detect` / `prepare` / `parse`）。现有 Node 逻辑**原样迁入** `node` 适配器，正则和错误文本不改；`verify.ts` 改为"按 argv 选适配器，无匹配则报原有错误"。

### 4.2 pytest 运行器规则

- **解释器**只接受以下两种，并把路径与文件 sha256 写入环境摘要：
  1. `.ano/config.toml` 中 `python.interpreter` 的绝对路径；
  2. 项目根内的 `.venv/Scripts/python.exe`（Windows）或 `.venv/bin/python`。
- **argv 形状**固定为 `<解释器> -m pytest [允许的参数] <声明的测试文件…>`，并沿用"声明的测试文件必须被 argv 选中"的既有规则。
- **由 ANO 追加** `--junitxml=<root>/.ano/tmp/verify-<runId>.xml` 与 `-o junit_family=xunit2`；产物读完即删，只留哈希。
- **一律拒绝**：用户自带的 `--junitxml`；`-p <插件>`（`-p no:<名>` 除外）；`--collect-only`/`--co`；`--setup-only`/`--setup-plan`；`--fixtures`；`-c`；指向项目根外的 `--rootdir`；`-m` 后跟 `pytest` 以外的模块；`-X` 参数（`-X utf8` 除外）。

### 4.3 计数来源与交叉校验

计数**只**来自 JUnit XML，并与退出码交叉校验：

| 退出码 | 要求 | Evidence |
|---|---|---|
| 0 | XML 中 tests > 0 且 failures + errors = 0 | 可以 `ok=true` |
| 1 | XML 中 failures + errors > 0 | `ok=false` |
| 5 | 未收集到测试 | `ok=false`，标 `no_tests`，不算有产出 |
| 2 / 3 / 4 | 中断 / 内部错误 / 用法错误 | `ok=false`，标对应原因 |
| 其他，或 XML 与退出码矛盾，或 XML 缺失 | — | `ok=false`，fail-closed |

映射：failures + errors → fail；skipped（含 xfail）→ skipped，按既有规则**阻止 done**；strict xpass 已由 pytest 计为 failure。上表中各状态在 XML 里的具体表示以 S9 实测为准（PY-02），实测与本表不符时，先修订本 ADR 再实现。

S9 实测补充（2026-11-27，Python 3.14.3 / pytest 9.1.1；`docs/evidence/s9-python-pytest.json`）：非 strict xpass 在 JUnit 中与普通通过无区别，按 pass 处理，不宣称可区分；收集错误为 exit 2 + error testcase；中断为 exit 2，可能生成 `tests=0` 却含一个空 testcase 的不一致 XML，仍 fail-closed；内部错误与用法错误为 exit 3/4，可能不生成 XML。非零退出码与缺失/异常 XML 都不能获得成功证据；exit 5 保留 `no_tests` 原因，不因没有有效 testcase 而改为成功。

### 4.4 受限 XML 解析器

只识别 `testsuites`、`testsuite`、`testcase`、`failure`、`error`、`skipped` 元素及其计数属性。遇到 `<!DOCTYPE`、`<!ENTITY` 或处理指令（`<?xml` 声明除外）直接拒绝；输入上限 16 MiB，嵌套深度上限 64；按 `testcase` 子元素重算计数，与 `testsuite` 属性不一致时记 anomaly 并判 `ok=false`。

### 4.5 如实边界

`conftest.py` 等测试代码本身能篡改结果，这与 Node 测试相同；证据身份不是密码学签名（limitations 已有）。这两条在 limitations 的 Python 一节重申。

---

## 5. 决定三：Python L0/L1 结构（M23b）

### 5.1 范围

- 扩展名：`.py`（值语义）与 `.pyi`（存根，其全部出边为 `type-only`）。`.pyc` 与 `__pycache__/**` 并入默认排除集。
- L1 符号：模块、`class`、`def`/`async def`（含方法，限定名 `pkg.mod:Class.method`）、模块级赋值目标、`__all__` 字面量列表。`symbol_id` 不含行号（沿用）。装饰器只记名称，不推断语义。

### 5.2 导入解析（确定性，不执行代码）

- **源码根**按优先级：`python.roots` 配置 > `pyproject.toml` 中 `[tool.setuptools.packages.find] where` 与 `[tool.setuptools] package-dir` 两个键 > `src/` 布局 > 项目根。pyproject 只做最小 TOML 子集读取，读不懂就降到下一级并记 caveat。
- **绝对导入** `a.b.c`：在各源码根下依次查找 `a/b/c.py`、`a/b/c/__init__.py`、`a/b/c.pyi`；允许 PEP 420 命名空间包。多个根同时命中 → `unknown(ambiguous)`，不猜。
- **相对导入**按包层级解析，越出顶层包 → `unknown`。
- 解析不到项目文件的（标准库、第三方）→ 外部，`unknown`，不计覆盖，计入 caveats，与 TS 外部包相同。

### 5.3 三态映射

遵循架构基线 §5.3 的不对称约束：影响范围取超集，覆盖取子集。

| Python 形态 | 边态 / provenance | 计入影响范围 | 计入覆盖 |
|---|---|---|---|
| 模块顶层 `import x` / `from x import a`，解析到项目文件 | `value-confirmed` / resolved | ✅ | ✅ |
| `if TYPE_CHECKING:` 块内 | `type-only` | ✅ | ❌ |
| 来源文件是 `.pyi` | `type-only` | ✅ | ❌ |
| `__init__.py` 中 `from .m import f` 具名重导出 | 二档，穿透到**定义文件** | ✅ | 按定义文件计 |
| `from x import *` | `heuristic(barrel_wildcard)` 文件级 | ✅ | ❌ |
| `try: import x` / `except ImportError:` 内 | `heuristic(conditional_import)` | ✅ | ❌ |
| 函数体内延迟导入 | `heuristic(lazy_import)` | ✅ | ❌ |
| `importlib.import_module(...)`、`__import__`、`exec`/`eval` | 盲区 `dynamic-load` / `eval`，只计数 | — | ❌ |
| `getattr(<模块>, name)` | 盲区 `reflection` | — | ❌ |
| 字符串注册（Django `INSTALLED_APPS`、`entry_points` 等） | 盲区 `registry-scan` | — | ❌ |
| `sys.path.insert` / `sys.path.append` | caveat：解析结果可能不准 | — | — |

### 5.4 T1 覆盖的 pytest 特例

测试文件只有经 `value-confirmed` 边可达才算覆盖。pytest fixture 按参数名在运行时注入，所以 `conftest.py` 提供的依赖记为 `unknown`，**不计覆盖**。这会让 Python 的 T1 判定偏严，这是有意的方向。

### 5.5 结构开关

新增 `ENABLE_PYTHON_STRUCTURE`，默认关闭。关闭时现有全部结构测试与电商项目证据数值完全不变；§6 的门槛通过后才打开。`EXTRACTOR_VERSION`（当前 `p4-caveats-v1`）升版，使旧图缓存失效并重建一次，写入 CHANGELOG。

---

## 6. 决定四：宣布支持的两级门槛

沿用"部分覆盖比不覆盖更糟"。

1. **夹具金标准**：仓库内的 Python 夹具覆盖 src 布局、平铺布局、命名空间包、相对导入、`TYPE_CHECKING`、星号导入、条件导入、延迟导入、动态导入、`.pyi`，每条边的判定与人工金标准逐条一致。
2. **真实项目只读验收**：至少 1 个用户具名指定的真实 Python 项目，在同配置临时副本上扫描（沿用 M13 的只读做法），如实报告 unknown 占比与盲区计数。

| 通过情况 | 状态 | 对外表述 |
|---|---|---|
| 只过第 1 条 | `supported-fixture-only` | **不得**写"已支持 Python"，limitations 如实说明 |
| 两条都过 | `supported` | 可写"支持 Python（L0/L1 + pytest 证据）" |

---

## 7. 决定五：与 M19 钩子的联动

`src/hooks/pre-tool.ts` 的 `SUPPORTED_PRE_TOOL_EXTENSIONS` 改为从结构层的受支持扩展名导出派生（§2 第 8 条），删除手写副本，并加一条测试断言两者恒等。

效果：结构开关打开后，改 `.py` 同样要求先 `explore`；开关关闭时，`.py` 保持 `UNSUPPORTED_LANGUAGE` 放行并标降级，与现在一致。

---

## 8. 明确不做

| 不做 | 理由 | 何时重议 |
|---|---|---|
| Python L2 调用图 | 动态特性多，heuristic 比例会很高；L0/L1 已足够支撑影响范围与 T1 | M23 真实项目 unknown 占比可控时 |
| unittest / nose 等其他测试框架 | pytest 能运行 unittest 风格用例，先覆盖 pytest 入口即可 | 用户真实项目不用 pytest 时 |
| 类型推断、运行时 `sys.path` 追踪 | 违反"静态且隔离" | 不重议 |
| 跨语言边（前端经 HTTP 调后端等） | 超出静态导入图语义 | 另立 ADR |
| 其他语言（Go/Rust/Java 等） | 每门语言都要独立的导入解析、证据适配与端到端验收 | 某语言改动占比 > 20% 时，按本 ADR 同样流程另立 ADR |

---

## 9. 未验证与风险（如实列出）

1. 本机是否装有 Python 与 pytest、Windows 下 venv 的实际布局、pytest JUnit 输出对 xfail/xpass/error/skip 的具体表示，都**未实测**。这是 PY-02（S9 spike）的内容；不通过则 M23a 降级为"仅设计"，如实上报。
2. `tree-sitter-python.wasm` 在当前 `web-tree-sitter` 版本下能否加载未实测（PY-02）；不通过则 M23b 降级为"仅设计"。两段互不阻断。
3. pyproject 的源码根写法很多，自动发现只覆盖两个键，其余需要用户配置 `python.roots`，否则可能出现大量 `unknown`。
4. 用户目前未确认有可用的真实 Python 项目；没有的话，M23 最高只到 `supported-fixture-only`。
5. 若 CI 机器没有 Python，pytest 集成测试只能按"既有环境条件 skip"处理并单列；本地验收必须真实运行，不得 skip。

---

## 10. 验收与关闭

- 每个任务按 ANO 自身流程：登记（带 steps 与验收标准）→ 实现 → `verify`（含红队）→ `complete`（evidence_id）。
- M23 关闭条件：PY-01～PY-12 全部完成；支持状态如实落在 `supported` 或 `supported-fixture-only`。
- 停止扩展契约：M22 与 M23 **都**关闭后才复位，文字更新为"M23 为最后一个产品里程碑"。

**流程修订（2026-11-27，project owner 在会话中明确选择）**：当前 M23 任务登记在 PM-mcp 台账，无法为每项任务取得原生 ANO `evidence_id`。已验证实现任务允许以当前源码的 PM 质量报告、定向/全量测试、构建与真实握手证据关闭，**不得伪造 `evidence_id`**；原生 ANO Gate 的完成要求不在此放宽。该修订只解决 M23 的 PM 验收路径，不构成真实项目 cutover、生产发布或宿主人工门禁授权。

## 11. Pre-mortem（假设 6 个月后失败，最可能的路径）

1. **半成品上线，大量 unknown 让 Gate 形同虚设**。对策：§6 两级门槛；unknown 占比进入每次 Verdict 的 caveats。
2. **为了让 Python 项目好过而悄悄放宽 Gate**（例如允许 skipped）。对策：§2 第 3 条，并由红队断言 Python 与 Node 的 done 公式一致。
3. **钩子没跟上，改 `.py` 静默放行**。对策：§7 单一来源派生 + 恒等测试。
4. **抽适配器时把 Node 证据改坏**。对策：§2 第 4 条字节级保护测试，不一致即回退。
5. **借 Python 之名继续扩语言**。对策：§2 第 10 条范围冻结。
