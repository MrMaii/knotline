# Knotline

Knotline 是挂在 DeepSeek Harness 侧边栏上的项目运行地图插件。

产品只有一个界面：Map。需求、Agent、项目知识、执行、交付和审核都在同一张地图上完成，没有任务列表、看板、概览、时间线、Workflow 编辑器或独立运行监控模式。

## 唯一工作流

1. 选择一个已经存在于 DeepSeek Harness 工作区里的项目；未选择时不能使用 Map。
2. 只主动创建六种根节点：**诉求**、**Agent**、**Skill**、**积压池**、**审批池**和**定时触发**。每个 Agent 都绑定一个可恢复的 DSH 对话。
3. 诉求从顶部抽屉拖到画布后打开模糊背景输入框；提交只创建独立节点，不会立即执行。
4. 从诉求向 Agent 拉线后，系统自动分类：问题生成回答，复杂需求依次生成审核反馈与计划书，Debug 在当前工作区启动实时任务台。
5. Agent 可以因能力匹配自动、可见地转交（衍生转交边）；两个 Agent 连线会衍生 Team，保留各自对话历史和工作方式。
6. 把诉求与 Agent 连到积压池，系统会建立队列并分配工作。把审批池连到受信 Agent，可以让执行只在计划获批后串行进行。把定时触发连到 Agent 或 Team，会按 Host 持有的持久间隔发送其 Prompt。
7. 完成后继续经过预审查档案、独立审核，最终产生 Delivery。

Task、NodeRun、Session、Workstream、Knowledge、Review 和 Notification 仍是底层实现原语，不作为用户可创建的节点类型出现。

## 运行

```powershell
npm install
npm run build
npx @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web add (Resolve-Path .).Path
npx @deepseek-ai/dsh@0.1.0-rc.6 web
```

打开 DSH 输出的地址，从侧栏选择 **地图**。Map 由 DSH 插件层直接渲染，不存在独立页面。

## 开发验证

```powershell
npm run check
npm run pack:check
```

产品范围与验收标准见 [docs/PRD.md](docs/PRD.md)，架构见 [docs/architecture.md](docs/architecture.md)，本地开发见 [docs/development.md](docs/development.md)。English version: [README.md](README.md).

## 许可与来源

Knotline 以 [Apache License 2.0](LICENSE) 发布。代码承继自 Dashi Taskboard 项目：[PROVENANCE.md](PROVENANCE.md) 记录了保留的部分，[NOTICE](NOTICE) 包含必需的署名。捆绑的第三方代码列于 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Knotline 是独立的社区项目，与 DeepSeek 及上游 Dashi Taskboard 作者均无隶属、赞助或背书关系；产品名称仅用于描述互操作性。
