<div align="center">

<img src="docs/assets/knotline-banner.svg" alt="运筹 Knotline — 一张图统筹 Agent：连线即执行" width="100%" />

<br/><br/>

[![License](https://img.shields.io/badge/license-Apache--2.0-6172f3)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-2e90fa)](package.json)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-12b76a)](docs/compatibility.md)
[![npm version](https://img.shields.io/npm/v/knotline-dsh)](https://www.npmjs.com/package/knotline-dsh)
[![npm downloads](https://img.shields.io/npm/dm/knotline-dsh)](https://www.npmjs.com/package/knotline-dsh)

[English](README.md) · **简体中文**

<br/>

**运筹**（Knotline）是挂在 DeepSeek Harness 侧边栏上的项目运行地图。<br/>
诉求、Agent、执行、审核与交付都在同一张图上完成 —— **连线即命令，一条线驱动真实的 Agent 工作。**

</div>

<img src="docs/assets/divider.svg" width="100%" alt="" />

## 一条线，跑完一次真实执行

<div align="center">
<img src="docs/assets/demo-workflow.svg" width="92%" alt="诉求连向 Agent，自动分类并真实执行，回答长在图上" />
</div>

把诉求拖到画布，连向一个 Agent：系统自动分类（问题 → 回答；复杂需求 → 审核反馈 + 计划书；Debug → 实时任务台），随后启动一个**真实、可恢复的 DSH 对话**去完成它。没有假执行——状态只能由结构化生命周期工具推进。

<img src="docs/assets/divider.svg" width="100%" alt="" />

## 对话框有的，图上都有

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/assets/demo-transcript.svg" width="100%" alt="实时转录" />
</td>
<td width="50%" valign="top">
<img src="docs/assets/demo-governance.svg" width="100%" alt="治理流程" />
</td>
</tr>
<tr>
<td valign="top">

**对话框级可见性。** 运行中的任务台内嵌实时会话转录（你 / Agent / 工具三种角色）；完成的工作带回 **Agent 完整回复**、交付摘要与验证证据，一个字都不丢。

</td>
<td valign="top">

**治理内建。** 执行必经预审查档案与**独立审核**，后端直接拒绝自批；通过后才产生 Delivery。审批池让受信 Agent 只执行已批准的计划。

</td>
</tr>
</table>

<img src="docs/assets/divider.svg" width="100%" alt="" />

## 六种根节点，其余一切自动生长

<div align="center">
<img src="docs/assets/demo-nodes.svg" width="100%" alt="诉求、Agent、Skill、积压池、审批池、定时触发" />
</div>

- **Agent 连 Agent** 组成 Team，保留双方对话历史，指派前先进行内部讨论；
- **积压池**承接排队，空闲的 Agent 自动拉取工作；
- **定时触发**由 Host 持有计时器，重启不丢；
- **Skill** 拖到 Agent 或 Team 即绑定能力，影响后续所有运行。

## 报告像帖子一样读

单击 Work Report / 回答 / 计划书，展开**全屏详情页**：产出方 Agent 领衔、Markdown 正文（含表格）、右侧栏显示该 Agent 忙不忙、排了几件事。**选中任意文字浮出批注按钮**，评论发布后回传给产出它的 Agent，并在评论下方逐字打出它的状态回复。

## 快速开始

```powershell
npm install
npm run build
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add (Resolve-Path .).Path
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

打开 DSH 输出的地址，从侧栏选择 **运筹**：先在全屏选择页挑一个工作区，右下角"进入运筹"。首次进入有三步引导。

### 开发验证

```powershell
npm run check     # lint + 类型 + 55 个测试 + 双端构建
npm run pack:check
```

产品范围与验收标准见 [docs/PRD.md](docs/PRD.md)，架构见 [docs/architecture.md](docs/architecture.md)，本地开发见 [docs/development.md](docs/development.md)。

<img src="docs/assets/divider.svg" width="100%" alt="" />

<div align="center">
<img src="docs/assets/knotline-wordmark.svg" width="300" alt="运筹 Knotline" />
</div>

运筹（Knotline）以 [Apache License 2.0](LICENSE) 发布。代码承继自 Dashi Taskboard 项目：[PROVENANCE.md](PROVENANCE.md) 记录了保留的部分，[NOTICE](NOTICE) 包含必需的署名，捆绑的第三方代码列于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。运筹是独立的社区项目，与 DeepSeek 及上游 Dashi Taskboard 作者均无隶属、赞助或背书关系；产品名称仅用于描述互操作性。
