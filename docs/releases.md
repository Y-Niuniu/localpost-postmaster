# LocalPost 发布记录

这里只放发布相关的决定和纠正，都是净化后的摘要。每次生产部署的完整 manifest 是私密运维证据（见 `docs/mcp-registration-plan-v3.md` §五），
不进代码仓库。

## 2026-10-02 里程碑标签纠正（只是方案和记录；实际打标签由 DSH 在用户批准范围内执行）

**发现**：codex 复审 v3.1 时发现（`.mailbox/attachments/codex-v3-1-review-fb3ec71-7d-20261002.md` §三）。
claude 于同日用 `git for-each-ref` / `git cat-file` 只读复核，结论一致。两个标签**只在规范库** `tools/dsh-localpost-postmaster` 里，集成库没有。

| 旧标签 | 标签对象 | 实际指向（错误） | 名字表达的提交 | 建议的正确目标 |
|---|---|---|---|---|
| `milestone/eac20c9-migration` | `101e22ce4fd6ebd7f476586e4596c721fe951966` | `fb3ec71fe5ea25451420c77267a98ad67f5f81af`（方案 v3.1 的文档提交） | `eac20c9` | `eac20c9bc637d8c900284da8eb58dfe4f05bb015`（迁移手册：2026-10-02 生产执行记录） |
| `milestone/721e6ef-controlled-write` | `059d1a8e439aebd7a7b523aa6f2568082e70d60e` | `fb3ec71fe5ea25451420c77267a98ad67f5f81af`（同上） | `721e6ef` | `721e6ef4b5d21a338c4631d53c942fb90c117b8b`（启用方案 v3） |

controlled-write 的目标选 `721e6ef`，依据是 codex 的建议：
- 它是受控写服务主线上已审的状态，位于 `d466f05` 的代码修复之后；
- 旧标签名里写的也是它。

最终以 DSH 确认为准。

**处理策略**：

1. **不静默移动，也不删除旧标签**，保留作为审计痕迹。
2. 由 DSH **新建准确的 annotated 标签**，名字里**不嵌短 SHA**，以免再犯同类错误，例如 `milestone/migration`、`milestone/controlled-write`。
   标签说明里写完整的目标 SHA、本记录的位置和下面的核对命令。
3. 发布 manifest 只用**完整的 source SHA**，不引用这两个旧标签。
4. 删除旧标签要另经用户明确批准。影响是这两个名字会消失；仓库没有 remote，不涉及传播。
   2026-10-02 核对时，仓库文件里没有引用这两个旧标签名的地方（`git grep` 为空）。

**核对命令**（只读）：

```
git -C C:/AI_ASSIST/tools/dsh-localpost-postmaster for-each-ref refs/tags/milestone --format='%(refname:short) %(objectname) -> %(*objectname)'
```

期望：新标签建好后，它们的 `%(*objectname)` 分别等于上表「建议的正确目标」的完整 SHA；两个旧标签的对象和指向保持不变。

## 执行记录：标签纠正已落地（2026-10-02 18:08 · dsh）

按六步任务第 4 步执行，**只新建、不动旧**：

| 标签 | tag 对象 | 指向（%(*objectname)） |
|---|---|---|
| `milestone/migration` | `9409fcadaed9258734435e7c4b115d8537e6cb46` | `eac20c9bc637d8c900284da8eb58dfe4f05bb015` ✅ |
| `milestone/controlled-write` | `ec501bf31cb359f3e2d006e1ba33384add2abb28` | `721e6ef4b5d21a338c4631d53c942fb90c117b8b` ✅ |

两个旧误标标签**原样保留**（对象哈希与指向均未变，可作审计证据）：

- `milestone/eac20c9-migration` → obj `101e22ce4fd6ebd7f476586e4596c721fe951966`，peel `fb3ec71...`
- `milestone/721e6ef-controlled-write` → obj `059d1a8e439aebd7a7b523aa6f2568082e70d60e`，peel `fb3ec71...`

核对命令与证据：`work/localpost-six-gates-evidence/step4-tags.txt`。
仓库内**没有**任何文件引用这两个旧标签名（`git grep` 为空），发布 manifest 只用完整 source SHA。
