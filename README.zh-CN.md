<div align="center">

<img src="docs/assets/knotline-banner.svg" alt="运筹 Knotline — 一张图统筹 Agent：连线即执行" width="100%" />

<br/><br/>

[![License](https://img.shields.io/badge/license-Apache--2.0-6172f3)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-2e90fa)](package.json)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.0--rc.6-12b76a)](docs/compatibility.md)

[English](README.md) · **简体中文**

</div>

---

**运筹**（Knotline）是挂在 DeepSeek Harness 侧边栏上的项目运行地图插件。产品只有一个界面：Map。诉求、Agent、项目知识、执行、交付和审核都在同一张地图上完成，没有任务列表、看板、概览、时间线或独立运行监控模式。**连线即命令：一条线就能驱动真实的 Agent 工作。**

## 亮点

- **连线即执行** — 把诉求连向 Agent，系统自动分类：问题生成回答，复杂需求依次生成审核反馈与计划书，Debug 在当前工作区启动实时任务台。
- **六种根节点** — 诉求、Agent、Skill、积压池、审批池、定时触发。回答、计划、Team、审核、交付都是系统自动长在图上的。
- **对话框级的可见性** — 运行中的任务台内嵌实时会话转录；完成的工作带回 Agent 完整回复、交付摘要和验证证据。
- **报告像帖子一样读** — Work Report 以全屏详情页打开：Markdown 排版、选中批注、评论回传给产出它的 Agent。
- **治理内建** — 执行必经预审查档案与独立审核，后端直接拒绝自批。
- **Team、队列与定时** — Agent 连 Agent 组成 Team；积压池与审批池承接排队和受信执行；定时触发按 Host 持有的持久频次发送 Prompt。

## 唯一工作流

1. 在全屏选择页选中一个已有的 DeepSeek Harness 工作区。
2. 从顶部抽屉拖出根节点；诉求提交后只是孤岛，不会立即执行。
3. 把诉求连向 Agent——这条线完成分类并启动一个真实、可恢复的 DSH 对话。
4. 实时旁观运行，批注它产出的报告，让独立审核把工作带到 Delivery。

## 运行

```powershell
npm install
npm run build
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add (Resolve-Path .).Path
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

打开 DSH 输出的地址，从侧栏选择 **运筹**。Map 由 DSH 插件层直接渲染，不存在独立页面。

## 开发验证

```powershell
npm run check
npm run pack:check
```

产品范围与验收标准见 [docs/PRD.md](docs/PRD.md)，架构见 [docs/architecture.md](docs/architecture.md)，本地开发见 [docs/development.md](docs/development.md)。

## 许可与来源

运筹（Knotline）以 [Apache License 2.0](LICENSE) 发布。代码承继自 Dashi Taskboard 项目：[PROVENANCE.md](PROVENANCE.md) 记录了保留的部分，[NOTICE](NOTICE) 包含必需的署名。捆绑的第三方代码列于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。运筹是独立的社区项目，与 DeepSeek 及上游 Dashi Taskboard 作者均无隶属、赞助或背书关系；产品名称仅用于描述互操作性。
