# S9：Python / pytest 与 tree-sitter-python 真实隔离实测

日期：2026-11-27。关联：ADR-014、M23 / PY-02（T-181）。

## 判定门

- **M23a pytest 证据：可行**。真实采集 13 个场景，覆盖退出码 0～5；不是手写 XML 冒充运行结果。
- **M23b Python L0/L1：可行**。现有 `web-tree-sitter` 0.25.10 可加载 `tree-sitter-wasms` 0.1.13 自带的 Python WASM（ABI 14），样本 AST 无错误。
- 这是 spike，不是 M23 验收。Python 结构开关仍不得打开；不对外宣称已支持 Python。
- 实测发现的特殊表示已先补入 ADR-014 §4.3，再开始适配器实现。没有降低 Gate 条件。

## 环境与方法

在 `os.tmpdir()` 下新建名称含中文和空格的目录，执行真实 `git init`，用已安装的 Python 3.14.3 创建 Windows venv：

```text
<BASE_PYTHON>/python.exe -m venv --system-site-packages <S9_ROOT>/.venv
<S9_ROOT>/.venv/Scripts/python.exe -m pytest --version
pytest 9.1.1
```

venv 的 `Scripts/python.exe` 真实存在。`--system-site-packages` 仅复用本机已装的 pytest；未下载或增加 ANO 项目依赖。各场景在独立目录中以 `spawn` 等价的 Python `subprocess.run` argv 调用；关闭第三方插件自动加载：`PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`。各场景的测试源码、原始 XML 的 SHA-256、脱敏 XML、退出码及输出尾部记录于 [机器证据](../evidence/s9-python-pytest.json)。

标准执行形状：

```text
<VENV_PYTHON> -m pytest -q -o junit_family=xunit2 --junitxml=<CASE>/junit.xml .
```

该目录只包含本次生成的测试，不执行真实用户项目，不读取其虚拟环境或 site-packages 做结构分析。Python 执行测试时读取自身 pytest 安装属于测试运行器的边界。结构探针只使用 WASM，未通过解释器分析源码。

## pytest 实测矩阵

| 场景 | exit | tests | failures | errors | skipped | 观察 |
|---|---:|---:|---:|---:|---:|---|
| pass | 0 | 1 | 0 | 0 | 0 | 普通 testcase，无状态子元素 |
| fail | 1 | 1 | 1 | 0 | 0 | `<failure>` |
| fixture error | 1 | 1 | 0 | 1 | 0 | `<error>` |
| skip | 0 | 1 | 0 | 0 | 1 | `<skipped>`；退出码 0 也不能完成 |
| xfail | 0 | 1 | 0 | 0 | 1 | 同样为 `<skipped>`，不能完成 |
| 非 strict xpass | 0 | 1 | 0 | 0 | 0 | XML 与普通 pass 不可区分，不宣称能区分 |
| strict xpass | 1 | 1 | 1 | 0 | 0 | pytest 已记为 failure |
| 收集错误（语法错） | 2 | 1 | 0 | 1 | 0 | 测试未执行，collection failure 被记为 error testcase |
| no tests | 5 | 0 | 0 | 0 | 0 | `no_tests`，不能完成 |
| KeyboardInterrupt | 2 | 0 | 0 | 0 | 0 | XML 却含一个空 testcase，重算计数会不一致；必须失败关闭 |
| internal error（sessionstart 抛错） | 3 | — | — | — | — | 没有 XML；不能完成 |
| usage error（非法选项） | 4 | — | — | — | — | 没有 XML；不能完成 |
| conftest 重写结果文件 | 0 | 1 | 0 | 0 | 0 | 下节说明其信任边界 |

套件属性只是声明；后续解析器必须按 testcase 重算并交叉校验，不把套件的全绿计数直接当证据。非零退出码始终失败；缺失、畸形或不一致 XML 不能获得成功证据。

## 结果可篡改性的真实探测

隔离项目中的 `conftest.py` 使用 `pytest_sessionfinish` hookwrapper，在 pytest 写完 JUnit 后覆盖文件。实际读取到的 testcase 为 `classname="forged" name="all_green"`，而不是实际运行的测试名。完整探针源码记录在 JSON 的 `conftest_rewrite.sourceFiles` 中。

因此，ANO 独占结果路径只能防止调用者通过 argv 指定任意现成结果文件，**不能把同进程测试代码产生的输出变为密码学可信证明**。这与 Node 测试代码能输出伪造统计的信任边界相同。适配器应限制 argv、交叉校验退出码与 XML、绑定源码指纹，但不能宣称防住恶意测试代码。limitations 收口时必须重申。

## Python WASM 探针

使用项目现有依赖加载 `tree-sitter-python.wasm`，解析包含绝对/相对/星号导入、装饰器、class、async def、方法、模块赋值、`__all__`、TYPE_CHECKING、try/except、延迟导入、动态加载、getattr 和 sys.path 修改的样本。原样本与关键节点字段摘要见 JSON 的 `treeSitter.selected`。

观测到 31 种命名节点：`aliased_import`、`argument_list`、`assignment`、`attribute`、`block`、`call`、`class_definition`、`decorated_definition`、`decorator`、`dotted_name`、`except_clause`、`expression_statement`、`function_definition`、`identifier`、`if_statement`、`import_from_statement`、`import_prefix`、`import_statement`、`integer`、`list`、`module`、`parameters`、`pass_statement`、`relative_import`、`return_statement`、`string`、`string_content`、`string_end`、`string_start`、`try_statement`、`wildcard_import`。

`async def` 与普通 def 同为 `function_definition`，通过语法 token 区分。装饰器位于 `decorated_definition`；相对导入含 `relative_import`。后续实现必须按 AST 结构处理作用域，不根据行文本推断执行语义。

## 证据与限制

JSON 中 XML 哈希对应**脱敏前原始字节**；绝对临时路径、基础 Python 路径、ANO 路径和机器名已替换，不能拿脱敏字符串直接复算原始哈希。原始结果及探针保留在本次临时目录；运行 harness 哈希一并记录。每个 pytest 场景的源码已内嵌，足以在同类环境独立复测。

本轮仅验证 Windows / Python 3.14.3 / pytest 9.1.1；不把它推广为全部 Python/pytest 版本或跨平台保证。WASM 探针首次在读取未导出的包 package.json 时失败，修正为读取实际安装元数据后完整重跑成功；该脚本问题不是 grammar 加载失败。
