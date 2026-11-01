# Domain Docs

本仓库采用 single-context 领域文档布局。公共产品术语以 `docs/product-domain.md` 为准，根目录 `GLOSSARY.md` 由 `domain-modeling` 在术语真正形成时按需创建；本机 Agent 上下文可做不冲突的补充。

## 探索前读取

- `GLOSSARY.md`：根目录词汇表，存在时读取。
- `docs/product-domain.md`：稳定产品术语、事实源和边界，是代码、规格与 Issue 的公共词汇来源。
- `CONTEXT.md`：可选的本机 Agent 补充。该文件保持 Git 忽略，不得作为公共链接目标，也不得覆盖公共词汇表或 ADR。
- `docs/adr/`：阅读与当前工作相关的架构决定。
- `docs/README.md`：可发布文档的权威层级、生命周期和导航。

上述可选文件不存在时直接继续，不预先创建。`domain-modeling` 只在领域术语或架构决定真正形成时创建相应文档。

## 文件结构

single-context 仓库使用根目录 `GLOSSARY.md` 和 `docs/adr/`；本仓库另有公共产品词汇表 `docs/product-domain.md`。不使用 `GLOSSARY-MAP.md` 或 `src/<context>/docs/adr/` 的 multi-context 布局。

## 使用规则

- Issue、规格、测试和代码中的领域概念应优先使用 `docs/product-domain.md` 与 `GLOSSARY.md` 定义的名称，不漂移到已明确避免的同义词。
- 公共词汇表和本机 `CONTEXT.md` 只保存术语及其边界，不保存实现步骤、临时计划或测试清单。
- 需要公开保留的稳定边界写入 ADR；面向用户的行为同步到中英文 README，不能只引用本机 `CONTEXT.md`。
- 如果实现方案与现有 ADR 冲突，必须明确指出并先更新或取代该 ADR。
- 新 ADR 使用 `docs/adr/NNNN-slug.md` 的连续编号。
