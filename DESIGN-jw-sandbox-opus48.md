# DESIGN: jw 借壳透传 + 沙箱（与 opus-4-8 的五轮设计对话）

日期: 2026-10-07
对话方式: **直连上游** api.justwoker.icu/v1/messages，未触碰运行中的网关（7878）
参与方: 主会话 + `claude-opus-4-8`（jw）
原始回复存档: `.tmp/opus48-r{1..5}-*.json`

---

## 0. 背景（已实测，见 DEVLOG 2026-10-07 (3)(4)(5)）

- 上游**替换**调用方工具表：只有 `bash`/`grep`/`glob`/`apply_patch` 能过，其余全丢。
- `bash` 是**客户端执行**：调用回到我们手里，模型接受我们回的任何结果串。
- 我们写进 `bash` description 的协议，模型**照办**（实测 `@tool:exec_command {...}` 路径保真）。
- 流式不产正文 → 只能用 `stream:false`。

目标：让该模型能在**沙箱内**完成杀戮尖塔 2（Godot/C#）模组开发，且**不动现有网关进程**。

---

## 1. 载波协议（第 1 轮）

**问**：三种载波哪个最抗 JSON 畸形？
A) 单行 `@tool:<name> <json>` B) 栅栏块 C) 裸 shell

**opus-4-8 答**：**选 B（栅栏块）**。

> A 的弱点：JSON 内含换行、长路径、嵌套引号时易被截断；解析靠行边界，模型一旦折行即失配。
> B 的**定界符**而非行边界划定 payload，抗折行/长路径/引号最佳；畸形 JSON 时仍可先抽块、
> 再容错重解析或回传纠错。C 丢参数保真度，`"G:\omp works"` 这类路径反而更脆。

**采纳**，并加了两条它的加固建议：
- 结束标记用不易撞车的 `@@END@@`
- 解析失败时**回传明确报错让模型重发**（可恢复性）
- A 保留为降级兼容

---

## 2. 沙箱架构（第 2、3 轮）

第 2 轮它推荐 **C（独立低权限用户 + ACL）**，并指出纯路径校验的致命缺陷：

> 字符串路径校验与实际文件系统解析之间存在 **TOCTOU + 路径等价性鸿沟**：
> - **junction**（`mklink /J`，普通用户可建）指向 Steam 目录 → 字符串检查过，写入落到 Steam
> - 8.3 短名、`\\?\`、UNC、尾随点/空格、大小写、`..` 多种编码、进程 CWD 漂移
> - 更根本：allowlist 只拦**路径参数**，拦不住被 spawn 的进程**自身**读写任意位置
> - exfiltration（出网）字符串检查完全不覆盖

**第 3 轮我实测反驳了它的前提**：

```
whoami: LAY1NN\o_Obl
token groups: BUILTIN\Administrators -> "Group used for deny only"
              NT AUTHORITY\本地帐户和管理员组成员 -> "Group used for deny only"
```

即：用户在 Administrators 组，但**进程未提权**，提权只能靠 UAC 弹窗（后台网关点不了）。
所以 `net user /add` 会失败，改 ACL 加 Deny 也需要提权。

**它据此改口，并给了明确排序**：

| 方案 | 排名 | 阻止 | 不阻止 |
|---|---|---|---|
| **D 命令白名单 + 固定 argv** | **最高（诚实答案）** | 任意命令执行、注入、未授权二进制、shell 元字符逃逸 | **被允许命令自身的能力**（允许 `git` 仍能读写其可达路径）——是能力约束，不是路径约束 |
| A per-run temp + realpath + 拒符号链接 | 次高，**必配 D** | 天真相对路径逃逸、`..`、你自己的代码误用 | **子进程本身**；TOCTOU 竞态仍在。只保护网关逻辑，不是子进程沙箱 |
| C AppContainer / LowBox | 理论最强，工程重 | 内核级文件/网络能力限制（唯一真·子进程隔离） | 需 C++/N-API 辅助程序；很多工具在 AppContainer 内会崩 |
| B Job Object 资源上限 | **安全价值≈0** | fork 炸弹、内存/CPU 耗尽、进程树残留 | 任何文件/数据越权。**不是安全边界** |

> **D 是诚实答案。** 无提权时你无法获得内核级文件隔离，唯一真正可靠的边界是命令白名单 + 固定 argv。
> 落地建议：D 为硬边界，叠加 A 收窄输入、B 防 DoS、ACL 最小化。

它还补了一条我没提的 E：
> **一次人工 UAC 预置受限账户**，之后用 `CreateProcessWithLogon` 以该账户跑子进程——一次提权换长期隔离。

---

## 3. 工具集（第 4 轮）

它先给出**根目录白名单** `G:\omp works\Sts` + `E:\Slay the Spire 2`，每个工具先 realpath 解析。

| 工具 | schema | argv | 必须校验 |
|---|---|---|---|
| `fs_read` | `{path, max_bytes?}` | 无（直接读） | realpath 在白名单内；≤2MB；拒目录 |
| `fs_search` | `{pattern, dir, glob?}` | `rg --json -e <pattern> -g <glob> -- <dir>` | dir 在白名单；pattern/glob 作**独立 argv**（非 shell）；超时+行数 cap |
| `fs_write` | `{path, content}` | 无（原子写 temp→rename） | realpath 在白名单；扩展名白名单（`.cs/.csproj/.json`）；字节 cap |
| `dotnet_build` | `{csproj, config}` | `dotnet build <csproj> -c <config>` | csproj 在仓库内且 `.csproj`；config 枚举固定；超时 cap |
| `git` | `{op, message?, paths?}` | `git -C <repo> <op> [-m <msg>] [-- <paths>]` | op 枚举（禁 `-c`/hooks）；repo 固定；禁任意子命令防 `git <alias>` |
| `read_log` | `{client, tail?}` | 无 | client 枚举→固定日志路径；tail cap |

**它主动指出的不可安全暴露项**：

> **`dotnet build` 会执行 csproj 内的 MSBuild target / 编译任意代码 —— 这是不可消除的信任**，
> 依赖锁定仓库本身。allowlist 保护的是**调用形态**，不是被执行代码的安全性。
>
> **`launch_game`**：游戏是任意 GUI 进程，长驻、产生子进程，无法用固定 argv+超时安全套住。
> 对策：人工/外部脚本启动，工具侧只 `read_log` 轮询。

---

## 4. 与真实工作流的冲突（第 5 轮）

我提出两条冲突，它给了修正：

**冲突 1：它禁了 `git push`，但项目硬规则要求"每次改动都提交并推送"。**
> 可以允许白名单形式的 push。推荐：**只允许推到专用分支（如 `agent/*`），禁止推 master**；
> master 合并由人工 PR 把关。既满足"无未推送提交"，又避免污染主干。可再叠加服务端分支保护。

**冲突 2：它说不能安全启动游戏，但项目规则要求"运行真实程序验证"。**
> 当前"人工启动、agent 只读日志"**不是最优**——违背"运行真实程序验证"。
> 推荐中间地带：**允许 agent 启动固定二进制 + 固定参数，不经 shell，进程短生命周期、
> 随 job 结束被 kill**。验证闭环由 agent 自主完成，攻击面压到最小。

**它给的"最大风险"一句话**：

> 整个设计的安全性完全依赖"白名单固定二进制/固定分支"这道边界不被绕过——一旦参数注入、
> 分支通配符或 shell 逃逸让 agent 能执行任意命令或推送任意分支，受限授权就瞬间等同于
> 完全授权，这是未来维护者绝不能忘记的单点底线。

---

## 5. 我的核实（不盲信）

- **"创建本地用户不需要管理员"** —— **它错了**。实测当前进程 `Group used for deny only`，
  `net user /add` 需要提权。我第 3 轮把证据摆出来后它承认并改口。
- **游戏 exe 路径** —— 实测两个测试副本都有 `SlayTheSpire2.exe`（B 副本：
  `G:\omp works\Sts\_runtime\sts2-test-client-B\SlayTheSpire2.exe`），且**都没有
  `steam_api64.dll`**（Steam 副本有）。启动工具的固定路径前提成立。
- **git remote/分支** —— forms 仓库 remote 为 `github.com/Twelve-eight/sts2-forms.git`，
  当前在 `main`。它建议的 `agent/*` 专用分支方案可直接落地。

---

## 6. 待决（实现前需拍板）

1. **是否接受"无内核级隔离"**：D 是硬边界，但 `dotnet build` 执行仓库代码这一点不可消除。
   要真隔离必须上一次 UAC 预置受限账户（它补的 E 方案）或上 AppContainer（工程重）。
2. **游戏启动是否交给 agent**：它推荐给（固定二进制+固定 argv+job kill）；保守做法是人工启动。
3. **push 分支策略**：`agent/*` 专用分支 + 人工 PR，还是维持现状。
4. **落地位置**：本设计**不动现有网关进程**。新东西应是一个**独立脚本/服务**，
   直连上游，与 7878 完全隔离。

---

## 7. 一句话总结

借壳可行（载波=栅栏块，实测模型照办）；沙箱的诚实边界是**命令白名单+固定 argv**
（无提权拿不到内核级隔离）；STS2 工作流的绝大多数步骤可安全暴露，
**唯二例外**是"执行仓库内构建代码"（不可消除的信任）与"启动任意 GUI 进程"（改为固定二进制+job kill）。
