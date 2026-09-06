---
title: 多模型工作流
description: 使用 Codex 规划、原生 CLI 执行，再通过 OpenCodex 审查代码。
---

`ocx workflow` 记录任务阶段和审批节点。在 Codex 项目对话里发起任务，
在页面查看进度、阶段结果，并批准或驳回。

## 在 Codex 对话里发起

启动 OpenCodex 代理并安装 `ocx-workflow` Skill 后，可以直接说：

> 用 ocx-workflow 处理当前项目：你先规划，OpenCode 执行，然后你来 review。
> 计划完成后等我确认。需求：[描述改动和验收条件]。

Codex 使用当前项目目录及你指定的执行工具、模型创建任务并记录计划。
当前对话负责组织流程：逐阶段调用执行工具，执行完成后在当前对话中审查代码。
执行工具必须已在代理所在机器安装并登录，项目目录也必须能在该机器访问。
不同机器上的目录不会自动推断或传输。

页面自动刷新进度，已完成和已中止的任务默认隐藏，可用“显示已结束任务”展开。
模板选择显示在任务列表上方。点击任务即可查看各阶段结果及审批按钮。
在网页审批后，回到原来的 Codex 对话说“继续”；网页目前不能自动唤醒该对话。
任务详情可以复制包含任务编号的继续提示。

这种模式使用不带 `--auto` 的 `workflow run` 创建任务，在对话中规划和审查，
对执行阶段逐次调用 `workflow execute TASK_ID`，用 `workflow advance` 记录对话产出。

## 全自动执行

`go` 会启动独立的 Codex 规划进程，再调用执行工具，最后通过 OpenCodex API
调模型审查。需要引擎自动完成各执行阶段时使用这个模式。

先启动 OpenCodex 代理，并安装、登录需要使用的原生 CLI。将下面的模型占位符
替换为你的实际模型标识：

```bash
ocx workflow go "完整需求与验收条件" \
  --workspace /absolute/path/to/project \
  --agent grok \
  --set planner=YOUR_CODEX_MODEL \
  --set worker=YOUR_GROK_MODEL \
  --set reviewer=YOUR_OCX_REVIEW_MODEL
```

`--agent` 选择 worker 的执行工具：`codex`、`agy`、`grok`、`opencode` 或
`claude`，不会更改 planner 的执行工具。编辑器也支持逐阶段选择执行工具，
未指定时使用 Codex。原生 CLI 接收自己的模型标识，chat 阶段接收 OpenCodex
模型标识。OpenCode 的 provider/model 与代理的模型标识不保证可以互换。

模型按“阶段显式模型 → 本次任务角色覆盖 → 模板角色默认值 → go 的后备模型”
解析。后备模型不会覆盖模板已配置的角色分工。各 CLI 使用自身的登录和权限配置，
工作流不会启用跳过权限检查的参数。

CLI 默认使用当前目录；REST API 必须填写代理所在机器的绝对项目路径。
自动代码工作流需要已有基准提交的 Git 仓库。默认保存启动时的 HEAD，也可以
用 `--base <revision>` 指定分支或提交。

## 审查和返工

```bash
ocx workflow status TASK_ID --json
ocx workflow gate TASK_ID approve
ocx workflow gate TASK_ID reject --note "补充超时处理并验证取消行为"
ocx workflow abort TASK_ID
```

自动任务在审批决定后继续执行。手动任务可用 `ocx workflow execute TASK_ID --auto`
执行到下一个审批节点；自行完成阶段后，用 `ocx workflow advance TASK_ID --outputs "验证证据"`
记录结果。后台执行期间禁止手动推进，终止任务会取消执行并丢弃迟到结果。

自动审查收到完整需求、计划、实现与验证输出，以及真实 Git diff。diff 包含基准提交之后
的提交、暂存和未暂存改动、未被 Git 忽略的新文件；工作目录中原有的改动也属于
审查范围。超过 2 MB 时会报错，不能静默截断。验证输出属于代理报告的证据，
不等于独立测试运行器给出的结论。

驳回后，执行端收到上一轮结果及驳回意见，下游阶段需要重新验证。对于自动采集了审查证据的任务，审查之后代码
若又发生变化，不能直接接受旧结果，需要驳回并重新审查。对话内的手动审查需要
在接受前核对实际工作目录。

首页可以选择内置模板或“我的模板”。在“配置模板”里保存执行工具和角色模型；
“另存为我的模板”会复制当前模板的步骤和配置，用新的编号保存。
选择后页面会生成带模板编号的对话提示，并在当前浏览器记住所选模板。
复制提示不会启动任务。在 Codex 中说“用 daily-opencode 模板，需求是……”即可。
Skill 会读取保存的模板，保留阶段、执行工具、模型和审批节点，仅在明确要求时覆盖。
对话模式下规划和审查由当前 Codex 对话完成；模板的 planner/reviewer 模型用于后台自动执行这些阶段。
界面同时负责进度、结果和审批。
需求和项目目录由发起任务的对话或 CLI 提供。
模板保存在 OpenCodex 配置目录的 `workflows/definitions/`；任务定义快照、完整需求、
基准提交、阶段输出和审查证据保存在 `workflows/tasks/<id>/task.json`，转换日志在
`journal.jsonl`。修改模板只影响新任务。没有快照的旧任务仍使用原有定义，缺少目录或
审查基准时建议重新创建。

更多定义细节见[英文参考](../../../reference/workflows/)。
