# Knotline 产品需求文档（PRD）

> 文档状态：当前产品基线  
> 产品阶段：单一 Map 工作流 MVP  
> 最后更新：2026-08-15  
> 适用项目：Knotline  
> 依附平台：DeepSeek Harness（DSH）

## 1. 文档目的

本文档沉淀产品讨论中的全部有效要求，并作为当前产品范围、交互、业务规则和验收标准的唯一产品依据。

早期方案曾把产品定义为覆盖组织、知识、工作和治理四种网络的通用 Project Operating Map，并要求保留 Dashboard、Board、List、Gantt、Workflow 等入口。后续产品决定已经明确收敛：**Knotline 是依附 DeepSeek Harness 的单一 Map 侧边栏插件，只做一条“小而美”的 Map 工作流。**

因此，本文遵循以下优先级：

1. 后续明确决定覆盖早期设想。
2. 用户可见产品只保留 Map。
3. 旧的数据结构或代码只有在支撑 Map 主路径时才复用，不再形成独立功能入口。
4. 所有扩展必须继续服务同一条 Map 工作流，不能重新长成一组并列产品。

## 2. 产品摘要

### 2.1 一句话定义

Knotline 是 DeepSeek Harness 侧边栏中的项目运行地图：用户只需创建 Agent、诉求、Skill、积压池、审批池和定时触发，并通过思维导图式连线，让系统自动完成能力装配、分类、分工、定时输入、执行、审批和交付。

### 2.2 核心价值

- 简化操作：用户不需要理解 Task、Workstream、Node Run、Review Gate 等内部概念。
- 真实执行：节点和连线不只是可视化，它们会驱动真实 DSH Agent、工作区工具和后台任务。
- 可观察：所有自动分类、转交、执行和审核都必须在地图上留下节点或连线。
- 可扩展：新增能力优先表现为现有根节点之间的新连线语义或系统衍生节点，而不是新增页面和功能模块。
- 长期上下文：一个 Agent 就是一个可恢复的 DSH 对话；Team 必须保留成员各自的历史和工作方式。

### 2.3 产品原则

1. **单一点产品**：只有 Map，没有第二套 Dashboard、任务系统或独立运行页。
2. **六类根节点**：用户只能主动创建 Agent、诉求、Skill、积压池、审批池和定时触发。
3. **连线即行动**：节点之间建立连接时，系统执行明确动作或创建明确关系。
4. **衍生而非堆叠**：回答、计划、任务台、审核、Team 和交付均由工作流衍生。
5. **自动但不隐形**：自动转交、排队和协作必须可见、可追踪。
6. **真实状态**：运行状态来自 DSH Session、Node Run 和结构化生命周期事件，不使用假的进度动画。
7. **宿主优先**：项目、会话、模型、Skill、工具和工作区能力均以 DeepSeek Harness 为准。

## 3. 产品边界

### 3.1 当前范围

- DeepSeek Harness 侧边栏插件入口。
- 必选的 DSH 工作区项目。
- 无限画布及节点位置持久化。
- Agent、诉求、积压池、审批池、定时触发五个顶部抽屉，以及读取当前工作区已安装能力的 Skill 选择器。
- 思维导图式连线。
- 诉求自动分类与真实 Agent 执行。
- Agent 自动转交与 Agent Team。
- 回答、审核反馈、计划、任务台、预审查档案、返工和交付等衍生节点。
- 诉求（包括 Debug）直接拖入积压池，或通过连线入池。
- 积压池排队、Agent 接入和连续调度。
- 审批预案统一存入审批池，或由受信任 Agent 连续抽取执行。
- Task Bench 的暂停、继续和运行中消息控制。
- Host 重启后的 Agent Session 与运行关系恢复。
- Map 内的审核通知操作，不增加独立通知页面。
- 由 Leader 初始化的 Project Knowledge、Delivery 更新提案和 Agent 版本同步，全部作为 Map 衍生节点运行。

### 3.2 明确不做

- 独立网页或 `/knotline/map/` 页面。
- Map 之外的 Dashboard、Board、List、Gantt、Timeline、Workflow Editor、AI Chat 或 Operations Console。
- 在插件内创建 DSH 工作区项目。
- 允许用户直接创建 Answer、Plan、Task Bench、Review、Delivery、Team 等衍生节点。
- 通过节点重叠或拖拽嵌套触发通用业务动作；仅保留诉求投放积压池、Skill 投放 Agent/Team 两条明确的容器式快捷入口。
- 与 Map 并列的通用自动化搭建器。
- Slack、Teams、邮件等外部通知集成。
- 为未来可能性提前增加新的根节点、页面或抽象层。

### 3.3 复用边界

内部可以继续复用已有的 Project、Task、Workstream、Node Run、Session、Knowledge、Review、Delivery、Notification、SQLite、HTTP、SSE 和版本控制代码。

这些内部能力不得重新暴露成独立产品模式。它们只负责支撑 Map 中可观察的节点、连线和状态。

## 4. 目标用户与主要场景

### 4.1 目标用户

- 已经使用 DeepSeek Harness 管理本地项目的人。
- 希望让多个长期 Agent 围绕同一项目工作的个人或小团队。
- 不希望维护复杂任务系统，但需要看见需求如何被执行、审核和交付的人。

### 4.2 核心使用场景

1. 把一个简单问题交给 Agent，获得独立 Answer 节点。
2. 把一个复杂需求交给 Agent，先获得审核反馈，再获得完整计划。
3. 把 Debug 诉求交给 Agent，让它进入当前 DSH 工作区检查、修复并验证。
4. 让系统把任务自动转给更合适的 Agent。
5. 把两个已有 Agent 组合成一个对外工作的 Team。
6. 把多个诉求投入积压池，由接入的 Agent 自动排布和持续执行。
7. 在任务运行期间通过 Task Bench 暂停、继续或追加指令。
8. 把预审查档案交给另一个 Agent，形成独立审核和最终交付。
9. 把多个复杂需求的独立预案统一存入审批池，再由受信任 Agent 串行抽取执行。

## 5. 信息架构

```text
DeepSeek Harness
└─ 侧边栏：地图
   ├─ 必选项目选择器
   ├─ 顶部根节点抽屉
   │  ├─ Agent
   │  ├─ Skill
   │  ├─ 诉求
   │  ├─ 积压池
   │  ├─ 审批池
   │  └─ 定时触发
   ├─ Project Map 无限画布
   │  ├─ 用户创建的根节点
   │  ├─ 系统衍生节点
   │  └─ 具有业务语义的连线
   └─ 节点 Inspector
      ├─ 内容与状态
      ├─ 运行指令与产物
      ├─ Task Bench 控制
      └─ 审核动作
```

进入 Map 后，用户必须先选择一个已经存在于 DSH 工作区中的项目。未选择项目时，只显示选择提示，不允许创建或运行节点。

## 6. 节点模型

### 6.1 用户可创建的根节点

| 根节点 | 产品含义 | 创建方式 | 创建后的默认行为 |
| --- | --- | --- | --- |
| Agent | 一个长期存在、可恢复的 DSH 对话 | 从顶部 Agent 抽屉向下拖出 | 创建 Agent 卡片并绑定真实 DSH Session；不自动领取工作 |
| 诉求（Request） | 用户尚未执行的需求、问题或 Debug 意图 | 从顶部诉求抽屉向下拖出 | 打开模糊背景标准对话框；提交后只生成独立节点 |
| Skill | 当前 DSH 工作区中已经安装的工作能力 | 点击顶部 Skill，在“已安装的 Skill”列表中选择 | 生成可复用 Skill 节点；可拖入 Agent 或 Team 设为其后续工作方式 |
| 积压池（Backlog） | 接收多个诉求并由 Agent 自动排布的宏观队列 | 从顶部积压池抽屉向下拖出 | 生成空积压池；等待诉求和 Agent 连入 |
| 审批池（Approval Pool） | 集中容纳复杂需求产生的独立审批预案，并允许受信任 Agent 连续执行 | 从顶部审批池抽屉向下拖出 | 生成空审批池；等待 Agent 以存入或抽取模式连入 |
| 定时触发（Scheduled Trigger） | 按固定频次向执行主体重复输入同一 Prompt | 从顶部定时触发抽屉向下拖出 | 填写 Prompt、分钟频次和启停状态；连接 Agent 或 Team 后开始计时 |

### 6.2 系统衍生节点

| 衍生节点 | 触发条件 | 用途 |
| --- | --- | --- |
| Answer | 问题类诉求执行完成 | 保存独立回答，不把答案塞回诉求卡片 |
| Review Feedback | 复杂需求开始处理 | 先指出完整性、风险、假设和缺失信息 |
| Plan / Approval Proposal | Review Feedback 之后 | 保存完整范围、步骤、依赖、验收标准和交付物；进入审批池后以审批预案设计显示，但仍是同一个独立 Plan 节点 |
| Task Bench | Agent 运行后台任务 | 显示真实 Node Run、Agent、Session 和当前状态 |
| Pre-review Artifact | 执行 Agent 提交结果 | 保存交付摘要、证据和待审内容 |
| Team | 两个 Agent 连接 | 对外作为一个 Agent 工作，对内保留两个成员 |
| Team Plan / Working Protocol | Team 建立或接单 | 记录内部计划、分工、协议和共享工作文档 |
| Review / Rework | 预审查档案被分配或驳回 | 形成独立审核或返工流程 |
| Delivery | 审核通过 | 形成最终交付物 |
| Project Knowledge | Leader 完成项目初始化 | 保存有版本号的项目事实、规则、决策、风险和开放问题 |
| Knowledge Proposal | Delivery 或 Agent 提议更新知识 | 等待人工批准或拒绝，不能直接覆盖正式知识 |

衍生节点不能从工具栏直接创建，也不能被包装成新的根节点类型。

## 7. 核心交互需求

### 7.1 项目选择

- 项目选择是必选项，不得再标记为“可选”。
- 只能选择已经由 DeepSeek Harness 工作区管理的项目。
- 切换项目后，地图必须切换到该项目的节点、连线和 Agent 状态。
- 项目上下文、工作目录和 Debug 权限均来自所选项目。

### 7.2 顶部抽屉

- 顶部只显示 Agent、Skill、诉求、积压池、审批池、定时触发六个入口。
- 顶部全局模型选择器复用 DeepSeek 聊天框的模型目录、模型选择和推理强度语义；保存到同一份 DSH 默认模型设置，并从下一步开始应用到全部 Map Agent。
- 入口不是统一的“添加”按钮，而是可向下拖出的独立抽屉按钮。
- 拖动时应有明确的抽出动画和落点反馈。
- 节点创建在用户松手的画布位置。
- Skill 入口是选择器：点击后只展示当前工作区已安装的 Skill，选中后由系统自动安排不重叠的节点位置。
- Skill 节点直接拖入 Agent 或 Team 时，写入该目标的 `skill_id`，Skill 节点保留并显示绑定连线。

### 7.2.1 定时触发任务

- 创建器包含必填 Prompt、正整数分钟频次和启停开关。
- 定时触发节点通过 `scheduled_for` 连线绑定一个或多个 Agent/Team；建立连线时开始按当前频次计时。
- 到点后由 DSH Host 创建真实 Task Bench，并通过目标的原有 DSH 对话输入该 Prompt；执行不依赖 Map 页面保持打开。
- 关闭节点开关后清除下一次触发时间；重新开启后从当前时间重新计时。
- 节点显示频次、目标数量、启停状态和下一次触发时间；每次触发后更新时间并生成可观察的 Task Bench。

### 7.3 诉求创建对话框

- 诉求卡片落到画布后，才打开与 DeepSeek 对话输入器一致的 Composer。
- 对话框出现时背景模糊。
- 使用单一自然语言输入，不再拆分标题、描述和验收标准字段。
- 占位文案为“描述你想要构建的内容”；底栏沿用 `Workspace Write`、当前模型和圆形发送按钮的 DeepSeek 对话结构。
- `Enter` 创建诉求，`Shift+Enter` 换行。
- 系统以第一行作为节点标题，以完整输入作为诉求正文；验收标准可在后续 Agent 受理和规划阶段衍生。
- 提交仅创建独立诉求节点，不发送给 Agent、不开始执行。
- 取消后不生成诉求节点。

### 7.4 Agent 编辑

- Agent 创建后立即绑定真实 DSH Session。
- 双击 Agent 卡片可以直接修改名称。
- 改名不创建新 Agent，不丢失 Session、历史或工作方式。

### 7.5 思维导图式连线

- 节点通过连接点建立源到目标的连线。
- 业务动作由连线触发，不再依赖两个节点重叠或嵌套。
- 唯一例外是积压池：任意分类的诉求（Question、Complex、Debug 或未分类）既可连线入池，也可直接拖入池内。
- 直接拖入命中时积压池必须给出视觉反馈；松手后创建同一条 `queued_in` 关系，诉求节点不永久叠放在积压池上。
- 每条自动关系必须在图上可见，并显示简洁的关系标签。
- 一个尚未连接的诉求可以长期作为孤岛存在。

## 8. 诉求分类与执行

### 8.1 分类类别

当前至少支持三类：

| 分类 | 典型输入 | 系统动作 | 主要产物 |
| --- | --- | --- | --- |
| Question | 简单问题、解释、查询 | Agent 直接回答 | Answer |
| Complex | 新功能、产品规划、设计、重构、多条件需求 | 先审核需求，再制定计划 | Review Feedback → Plan |
| Debug | Bug、报错、异常、无法运行、修复请求 | 连接当前工作区，检查、修复并验证 | Task Bench → Pre-review Artifact |

分类发生在诉求连接 Agent 或从积压池正式派发时。分类结果必须显示在诉求节点中。

### 8.2 简单问题路径

```text
诉求 → Agent → Task Bench → Answer → Pre-review Artifact
```

- Answer 是独立节点。
- Answer 必须回答原问题，不得把内部实现数据误当成产品答案。
- 回答完成仍需留下真实 Node Run 和预审查记录。

### 8.3 复杂需求路径

```text
诉求 → Agent → Task Bench → Review Feedback → Plan → Pre-review Artifact
```

- Review Feedback 必须先于 Plan。
- 审核反馈至少覆盖需求完整性、风险、假设和缺失信息。
- Plan 至少覆盖目标、范围、排除项、步骤、依赖、风险、验收标准和交付物。
- 两个文档分别成为节点，并使用 `Then plan` 等明确连线表达顺序。

### 8.4 Debug 路径

```text
Debug 诉求 → Agent → 当前 DSH 工作区 → Task Bench → 修复/验证 → Pre-review Artifact
```

- Debug Agent 的工作目录必须是当前选中的 DSH 工作区。
- Agent 必须拥有受 DSH 权限控制的文件读取、搜索、编辑和 PowerShell 工具。
- Agent 必须先检查真实错误，再实施修复。
- 结果必须包含实际命令、输出或等价验证证据。
- 如果诉求明确要求只读诊断，Agent 不得修改文件。
- 无法获得必要工具或权限时，必须形成明确 blocker，不能伪装已修复。

## 9. Agent 与 Team

### 9.1 Agent 等同于对话

- 每个 Agent Profile 对应一个 DSH Session。
- Session 可被 Host 创建、恢复和继续使用。
- Agent 的历史上下文、模型、Skill、角色和工作方式属于该 Agent。
- 关闭 Map 或刷新页面不能销毁后台 Agent。

### 9.2 自动能力转交

- 系统根据诉求分类，以及 Agent 的名称、角色和 Skill 判断能力匹配。
- 如果用户连接的 Agent 不是最合适执行者，并且存在匹配的专门 Agent，系统可以自动转交。
- 转交必须创建可见的 `delegated_to` 连线，并显示分类原因。
- 不允许静默换人。
- 转交后的实际 Agent、Task Bench 和产物必须使用同一诉求上下文。

### 9.3 Team

- Agent 与 Agent 连线后，系统衍生一个 Team；Team 不是用户可直接创建的根节点。
- Team 对外 `work as one single agent`。
- Team 内部保留每个成员完整的历史上下文、Session、Skill 和工作方式。
- 成员先进行内部讨论、比较方案、分工和处理分歧。
- Team 在对外产出计划的同时，必须形成内部 Working Protocol 或共享文档。
- Team 后续接单时，应继续使用成员已有的历史，而不是创建两个无记忆的新 Agent。

## 10. 积压池

### 10.1 连接语义

- 诉求连接积压池或直接拖入积压池：创建同一条 `queued_in` 关系。
- 诉求直接连接 Agent：创建 `direct_for` 关系；Agent 同时只运行一项，其余直接诉求进入该 Agent 自己的队列。
- Agent 连接积压池：创建 `executor_for` 关系，并由用户选择“抽取模式”或“暂存模式”。
- 积压池显示等待中的诉求数量和已接入 Agent 数量。
- Agent 节点只统计 `direct_for` 等待项，不把 `queued_in` 积压池事项计入自身排队数。

### 10.2 调度规则

1. Agent 的优先级固定为：直接诉求队列 > 关联积压池；积压池永远最低。
2. 有空闲 Agent 时，最早的直接诉求立即运行；Agent 忙碌时，新诉求只排队，不得并发创建第二个 Node Run。
3. 直接队列中的事项仍可由用户重新直接交给可用 Agent 运行。
4. Agent 节点显示直接排队数量：`0–2` 为绿色健康、`3–5` 为橙色略微积压、`6+` 为红色严重积压。
5. 没有暂存模式连接时，10 个直接诉求表现为 1 个运行、9 个直接排队。
6. 抽取模式下，Agent 在直接队列为空且自身空闲时持续从积压池领取事项。
7. 暂存模式下，Agent 最多保留 5 个等待中的直接诉求，超出的直接诉求转入该积压池；直接队列清空且 Agent 空闲后，连接自动转为抽取模式。
8. 当前任务提交预审查后，系统先领取下一条直接诉求；没有直接诉求时才从关联积压池领取。
9. 正式领取时仍需执行分类和能力匹配；自动转交到专门 Agent 时必须保留可见转交关系。
10. 已经进入执行或审核的诉求不得被重复领取。
11. Worker 只有在存在 `queued`、`running`、`waiting_input` 或 `changes_requested` Run 时才算忙碌；上一项已进入 `waiting_review` 后必须立即调度下一项。

### 10.3 产品目标

积压池让用户能够持续投入问题、需求和 Debug 任务，由一个或多个 Agent 自动排布。未来扩展应优先增强调度策略、优先级和 Team 分工，不应增加另一个任务管理页面。

### 10.4 审批池

审批池集中管理复杂诉求所产生的审批预案，不另建第二套审批文档模型：Complex 流程原本生成的独立 Plan 节点进入审批池后，直接显示为 Approval Proposal。

- Agent 连接审批池时必须选择“抽取模式”或“存入模式”；同一个 Agent 与同一个审批池之间只保留一种当前模式。
- 存入模式创建 `approval_writes` 关系。该 Agent 每完成一项复杂诉求，就把对应的独立 Plan 通过 `stored_for_approval` 放进审批池。
- 多个预案只被统一收纳，不合并内容：10 个诉求必须仍然形成 10 个可单独追踪的审批预案节点。
- 抽取模式创建 `approval_reads` 关系。Agent 空闲时持续领取池内最早的待审批预案，并把它视为已获授权的执行输入。
- 抽取会创建真实 Task Bench，并使用该 Agent 原有的 DSH 对话和工作区能力逐项执行；领取一项后必须等该项提交完成才可领取下一项。
- 抽取模式等同于用户主动信任模型的规范和设计判断，因此不再插入人工批准步骤；地图通过“待审批 → 执行中”的边状态表达这次隐式批准。
- 多个 Agent 可以分别作为写入端或读取端，形成“需求规范 Agent → 审批池 → 执行 Agent”的自动审批管线。
- 固定调度优先级为：直接诉求队列 > 审批池 > 积压池。积压池仍然永远最低。
- 带存入关系的 Agent 必须亲自处理其直接诉求，确保它生成的预案可以落入已连接的审批池，而不是在自动转交后丢失存入关系。

## 11. Task Bench

### 11.1 生成条件

任何 Agent 开始真实后台工作时，系统必须衍生一个 Task Bench 节点。它是 Node Run 的实时投影，不是独立任务数据库。

### 11.2 展示内容

- 当前 Agent 或 Team。
- DSH Session ID。
- 运行状态。
- 原始诉求和分类。
- 当前运行指令。
- 已产出的摘要、证据和错误。

### 11.3 运行控制

- 暂停：中断当前 Agent turn，把 Node Run 保留为 `waiting_input`，Agent 状态为 `paused`。
- 继续：使用同一个 Agent Session 和历史恢复任务。
- Follow up：把新的后续工作排入 Agent。
- Steer：在运行中改变当前执行方向。
- Inject：把信息注入下一步上下文。
- 暂停不能被监控器误判为完成或自动提交审核。
- Agent 进入空闲但未调用结构化完成工具时，Task Bench 进入 `waiting_input` 并说明原因；不得生成预审查档案、Review Gate 或 Delivery。
- Host 重启只自动恢复 `queued` 和 `running`；`waiting_input` 必须保留原状态和 Session，直到用户明确点击继续。

## 12. 审核与交付

### 12.1 预审查档案

- Agent 完成一个诉求后，系统自动生成独立 Pre-review Artifact。
- 档案至少包含交付摘要、验证证据、执行 Agent、Node Run 和原始诉求。
- 生成档案不等于自动批准。

### 12.2 独立审核

- 用户可以把预审查档案连接给另一个 Agent。
- 系统在该 Agent 的既有 Session 中创建真实 Review Node Run。
- 执行 Agent 默认不能批准自己的结果。
- 驳回后生成 Rework，并返回执行 Agent。
- 通过后生成 Delivery。

### 12.3 Map 内审核通知

- 执行 Agent 提交结果后，在 Map 内产生审核通知；点击通知必须聚焦对应衍生节点，不进入独立通知页面。
- 未分配 Reviewer 时，通知只允许 `open` 和 `reassign`，不得显示可直接通过或驳回的动作。
- `reassign` 必须把 Pre-review Artifact 分配给另一个 Agent，并立即创建、启动真实 Review Node Run。
- 后端必须拒绝任何没有独立 Reviewer 的审核决定，即使调用者绕过界面直接请求 API。
- Reviewer 分配完成后，新的审核通知才允许 `approve`、`reject`、`ask`、`reassign` 和 `postpone`。

### 12.4 Project Knowledge

- 首个 Project Knowledge 只能由该项目的 Leader Agent 初始化；Leader 必须读取当前工作区、文档、任务、历史 Session 和运行状态。
- Knowledge Asset 使用单调递增版本；Agent 绑定的是明确版本，不是无版本的共享文本。
- Knowledge 绑定会创建真实同步 Node Run；同步完成后 Agent Binding 为 `current`。
- 已批准 Delivery 可以生成 Knowledge Proposal；Proposal 在通知中通过后才发布新版本。
- 新版本发布后，仍绑定旧版本的 Agent 自动变为 `stale`；重新同步后变为最新 `current`。
- Knowledge 同步 Run 只能理解和同步现有版本，不得在同步过程中创建新的 Knowledge Proposal。

## 13. 状态模型

### 13.1 Agent

```text
offline | idle | working | waiting | blocked | paused
```

### 13.2 Node Run / Task Bench

```text
queued | running | waiting_input | waiting_review | changes_requested
| approved | failed | canceled | completed
```

### 13.3 诉求

```text
new → planned/executing → review → delivered
```

界面状态必须来自数据库记录或 DSH Session Event。自然语言中声称“完成”不能直接推进正式状态；Agent 必须调用结构化 Knotline 生命周期工具。

## 14. 系统与数据要求

### 14.1 真实操作路径

```text
DSH 侧边栏 Map
→ 选择 DSH 工作区项目
→ 创建六类根节点
→ React Flow 连线
→ Relation Resolver / Graph Command
→ Governance / Orchestration
→ DSH Agent Session 与工作区工具
→ SQLite 领域状态
→ SSE 更新
→ Map 衍生节点与连线
```

### 14.2 数据原则

- Graph Node 只保存实体引用、位置、尺寸、折叠、图层和视图版本。
- 诉求、Agent、Skill、Node Run、审核、产物和交付由各自领域实体保存。
- 已经存在的领域事实不能在图数据库中重复保存第二份。
- Graph Command 必须具有幂等键和可审计结果。
- SQLite 是当前事实存储；HTTP 提交动作；SSE 广播状态。
- 暂不引入 WebSocket 或图数据库。

### 14.3 DSH Host 编排

- 后台 Agent 由 Host 管理，不依赖 React 页面存活。
- 使用 `ctx.agents.create()` 和 `ctx.agents.resume()` 创建或恢复 Session。
- 使用 `agent.followup()`、`agent.steer()`、`agent.inject()`、`agent.whenIdle()` 和 `agent.cancel()` 管理运行。
- Agent setup 注入生命周期工具、文件工具、搜索、PowerShell、Skill、项目上下文、角色和验收标准。
- Host 重启后自动恢复正在排队或运行的 Node Run；等待输入和暂停状态只恢复绑定关系，不自动开启新 turn。

## 15. 功能需求清单

| ID | 优先级 | 需求 | 验收摘要 |
| --- | --- | --- | --- |
| FR-001 | P0 | Map 只能从 DSH 侧边栏进入 | 无独立页面；可返回聊天 |
| FR-002 | P0 | 必须选择已有 DSH 工作区项目 | 未选择时禁止创建和运行 |
| FR-003 | P0 | 只显示六个根节点入口 | Agent、Skill、诉求、积压池、审批池、定时触发，无其他创建入口 |
| FR-004 | P0 | 诉求落地后打开模糊对话框 | 提交只生成孤岛节点 |
| FR-005 | P0 | Agent 双击改名 | Session 与历史不变 |
| FR-006 | P0 | 使用连接点建立关系 | 不依赖节点重叠 |
| FR-007 | P0 | 自动分类 Question/Complex/Debug | 分类结果在诉求节点可见 |
| FR-008 | P0 | Question 生成独立 Answer | Answer 内容对应原问题 |
| FR-009 | P0 | Complex 先审核再计划 | 两个节点及顺序连线均可见 |
| FR-010 | P0 | Debug 进入当前工作区执行 | 能调用真实文件及 PowerShell 工具并提交证据 |
| FR-011 | P0 | 能力匹配自动转交 | 转交连线可见，不静默 |
| FR-012 | P0 | Agent + Agent 衍生 Team | 保留两个成员 Session 和工作方式 |
| FR-013 | P0 | 诉求可连线或直接拖入积压池，Agent 可连线接入 | 队列和 Worker 关系持久化；直接投放有命中反馈 |
| FR-014 | P0 | 积压池连续调度 | 忙碌不并发；完成后启动下一项 |
| FR-015 | P0 | 每个后台任务生成 Task Bench | 状态来自真实 Node Run |
| FR-016 | P0 | Task Bench 可暂停和继续 | 同一 Session 恢复，暂停不误交付 |
| FR-017 | P0 | 结构化提交后生成预审查档案 | 仅生命周期工具可推进；包含摘要和证据 |
| FR-018 | P0 | 档案可交给另一个 Agent 审核 | 形成独立 Review Run |
| FR-019 | P0 | 审核驳回形成 Rework，通过形成 Delivery | 结果在 Map 可观察 |
| FR-020 | P0 | Host 重启后恢复运行关系 | 页面和 Host 重启不丢 Session 绑定 |
| FR-021 | P0 | 从已安装列表生成 Skill 节点并拖入 Agent/Team | 目标 `skill_id` 更新；后续 Node Run 加载该 Skill；节点和连线可见 |
| FR-022 | P0 | 顶部修改全局模型与推理强度 | 使用 DSH 模型目录和默认模型设置；所有 Map Agent 的下一步读取新选择 |
| FR-023 | P0 | 定时触发向 Agent/Team 重复输入 Prompt | Prompt、分钟频次、开关持久化；到点产生真实 Task Bench；关闭后不再派发 |
| FR-024 | P0 | Agent 直接诉求串行排队并显示严重程度 | 同时只运行 1 项；队列数不含积压池；0–2 绿、3–5 橙、6+ 红 |
| FR-025 | P0 | Agent 连接积压池时选择抽取或暂存模式 | 直接诉求永远优先；暂存超额事项后在空闲时自动转为抽取 |
| FR-026 | P0 | Agent 连接审批池时选择抽取或存入模式 | 多个独立 Plan 可集中存入；抽取 Agent 将其视为获批预案并串行创建真实 Task Bench |

## 16. 非功能需求

- **简单**：首次使用只需要理解六个根节点和连线。
- **持久**：节点位置、关系、Agent Session、队列和运行状态可恢复。
- **可观察**：每次自动动作都有节点、边、状态或事件作为证据。
- **一致**：一个业务事实只有一个来源。
- **精准修改**：实现新能力时优先复用现有领域代码，不恢复已删除的多页面产品。
- **权限一致**：文件和 PowerShell 操作遵循 DSH 当前访问模式与审批机制。
- **无假执行**：不得用本地动画或生成文本冒充真实 Agent 运行与验证。

## 17. 核心验收场景

### 场景 A：新手首个问题

1. 从 DSH 侧边栏进入 Map。
2. 选择已有项目。
3. 拖出 Agent。
4. 拖出诉求，在 DeepSeek 对话式输入器中填写问题并提交。
5. 确认诉求仍为孤岛，没有自动发送。
6. 从诉求连接到 Agent。
7. 确认系统分类为 Question，出现 Task Bench 和 Answer。

### 场景 B：复杂需求

1. 创建包含功能规划和验收要求的诉求。
2. 连接 Agent。
3. 确认分类为 Complex。
4. 确认先出现 Review Feedback，再出现 Plan。
5. 确认两个文档内容独立且有顺序连线。

### 场景 C：Debug

1. 创建 Debug 诉求并连接 Agent。
2. 确认 Task Bench 使用当前项目的真实工作目录。
3. 确认 Agent 能使用读取、搜索、编辑和 PowerShell 工具。
4. 确认最终档案包含实际命令与验证输出。
5. 只读诉求不得产生文件变更。

### 场景 D：自动转交

1. 创建通用 Agent 与专门 Agent。
2. 把匹配专门能力的诉求连接给通用 Agent。
3. 确认系统转交给专门 Agent。
4. 确认地图显示 `delegated_to` 连线和分类原因。

### 场景 E：Team

1. 创建两个有独立 Session 的 Agent。
2. 将二者连线。
3. 确认衍生 Team、计划和 Working Protocol。
4. 把诉求交给 Team。
5. 确认成员先内部讨论，Team 再统一对外交付。

### 场景 F：积压池与任务台

1. 创建积压池并连接 Agent。
2. 连入两个诉求。
3. 确认第一个开始运行，第二个保持排队。
4. 在 Task Bench 暂停并继续第一个任务。
5. 确认使用同一 Session 恢复。
6. 第一个提交预审查后，确认第二个自动开始。

### 场景 G：Agent 直接积压

1. 将 10 个诉求直接连接到同一忙碌 Agent。
2. 确认 1 个运行、其余直接诉求串行排队，Agent 节点显示红色排队计数。
3. 连接积压池并选择暂存模式，确认超过 5 个的等待项移入池内，且不再计入 Agent 排队数。
4. 确认直接队列全部完成后，连接自动转为抽取模式并领取积压池事项。

### 场景 H：Agent 自动审批管线

1. 创建审批池，把规范 Agent 以存入模式连接到审批池。
2. 连续把两个 Complex 诉求交给规范 Agent，并分别提交完成。
3. 确认审批池出现两个独立 Approval Proposal，没有合并为一个节点。
4. 把执行 Agent 以抽取模式连接到同一审批池。
5. 确认第一个预案立即生成真实 Task Bench，第二个仍留在审批池等待。
6. 提交第一个 Task Bench，确认第二个自动开始，审批池待处理数从 `2 → 1 → 0`。

## 18. 成功标准

只有以下条件同时成立，当前产品闭环才算完成：

- 用户只看到一个 Map 产品入口。
- 用户只能创建 Agent、诉求、Skill、积压池、审批池、定时触发六类根节点。
- 诉求创建和诉求执行是两个独立动作。
- 连线可以驱动真实分类、转交、协作、排队和执行。
- Question、Complex、Debug 三条路径均产生正确衍生节点。
- Debug Agent 能操作当前 DSH 工作区，而不只是输出建议。
- Agent + Agent 能形成保留历史的 Team。
- 后台运行始终有 Task Bench 投影。
- Task Bench 可以暂停、继续和注入消息。
- Agent 忙碌时积压池不会重复并发派单。
- 审批预案保持独立；抽取 Agent 串行执行，不会并发领取或跳过直接诉求。
- 执行完成自动产生预审查档案，并可交给其他 Agent。
- 审核结果能形成 Rework 或 Delivery。
- 无 Reviewer 时不能通过通知或 API 绕过独立审核。
- Leader 能初始化 Knowledge v1，Delivery 能经 Proposal 发布新版本，旧 Agent Binding 能正确 stale 并重新同步。
- Host 和页面重启后，Agent 与运行关系可以恢复。

## 19. 当前实现基线与验证证据

截至 2026-08-15，当前实现已经验证：

- DSH 侧边栏 Map 入口和强制项目选择。
- Agent、诉求、积压池、审批池、定时触发五个根节点抽屉、已安装 Skill 选择器，以及诉求/定时触发 Composer。
- 定时触发已实跑：连接 Agent 后按 1 分钟频次连续产生 3 个真实 Task Bench；关闭开关后 `nextTriggerAt` 清空且停止派发。
- Skill 节点已真实绑定单独 Agent 与 Team，并投影可见 `skill_for` 连线；后续运行读取目标 `skill_id`。
- Agent 双击改名和 Session 持久绑定。
- React Flow 连接点与业务连线。
- Question、Complex、Debug 自动分类。
- Answer、Review Feedback、Plan、Task Bench、Pre-review Artifact 等衍生节点。
- 可见的 Agent 自动转交。
- Team 的成员历史、内部讨论、计划和工作协议。
- 积压池忙碌排队和完成后自动领取下一项。
- 审批池已实跑：两个 Complex 诉求分别形成两个 Plan 并存入同一池；读取 Agent 接入后待处理数按 `2 → 1 → 0` 变化，第一项提交完成后自动创建第二项真实 Task Bench，两个 Node Run 复用读取 Agent 的同一 DSH Session。
- 同一 Worker 的两条积压诉求已实跑为严格串行；上一项进入 `waiting_review` 后投入的迟到诉求也会立即领取。
- Task Bench 暂停、继续及同 Session 恢复。
- Agent 空闲但未调用结构化完成工具时，Task Bench 停留在 `waiting_input`，且不会生成审核或交付节点。
- 结构化提交会生成独立预审查档案；不同 Agent 的真实 Review Node Run 可批准并生成 Delivery。
- 新生成的未分配审核通知只提供 `open,reassign`；通过通知重新分配后，真实 Review Node Run 会立刻从 `queued` 进入 `running`。
- 无 Reviewer 的直接审核请求返回 HTTP 409 `REVIEWER_REQUIRED`，Review Gate 保持 `pending`。
- Leader 使用独立 DSH Session 生成了 5710 字符的 Project Knowledge v1；内容包含工作区代码、文档、任务、历史运行态、架构、决策、风险与开放问题。
- Agent Knowledge Binding 已实跑 `syncing → current v1`；Delivery Proposal 经通知批准后 Asset 升至 v2，旧绑定自动 `stale v1`，再次同步后恢复 `current v2`。
- Knowledge 同步期间 Proposal 数保持不变，确认同步 Run 不会再误生成知识更新提案。
- Debug Agent 在所选工作区真实运行 PowerShell 和 Git 只读验证。
- `npm run check` 的 lint、TypeScript、测试和构建通过。
- `/knotline/api/health` 返回 HTTP 200，DSH 浏览器集成无运行时错误。
- Host 重启实跑证明：`waiting_input` 的版本、时间戳和 Session 保持不变；`running` 使用原 Node Run 与原 Session 恢复并完成结构化提交。

## 20. 决策记录

| 时间/顺序 | 决策 | 影响 |
| --- | --- | --- |
| 初始设想 | 建立覆盖组织、知识、工作、治理四种网络的 Project Operating Map | 提供了领域模型、Graph Command、DSH 编排和审核闭环基础 |
| 范围收敛 1 | 产品必须“小而美”，只做 Map | 删除多页面、多视图和功能并列入口 |
| 范围收敛 2 | Map 不是独立页面，而是 DSH 侧边栏插件 | 宿主项目、Session、模型和工具成为硬依赖 |
| 交互调整 1 | 项目必选，且必须来自 DSH 工作区 | 插件不再管理项目创建 |
| 交互调整 2 | Agent 使用顶部抽屉，支持双击改名 | 一个 Agent 明确等同一个长期对话 |
| 节点收敛 | 用户节点先收敛为诉求和 Agent，后加入 Skill、积压池、审批池与定时触发 | 最终根节点固定为六类，其余全部衍生 |
| 协作定义 | Agent + Agent 形成 Team | Team 继承历史和工作方式，对外统一工作 |
| 交互升级 | 从拖拽重叠改为思维导图式连线 | 连线成为统一业务命令入口 |
| 工作流扩展 | 增加分类、自动转交、Task Bench 和积压池 | 在不增加新页面的前提下扩展同一 Map 工作流 |
| 积压池快捷投放 | 所有诉求（含 Debug）可直接拖入积压池，同时保留连线 | 直接投放复用 `queued_in`，不形成节点嵌套 |
| Skill 能力装配 | 顶部从当前工作区已安装列表选择 Skill，并可直接拖入 Agent 或 Team | 写入目标工作方式，后续运行真实加载；Skill 节点保持可复用和可追踪 |
| 定时触发 | 顶部创建含 Prompt、分钟频次和开关的节点，并连接 Agent 或 Team | DSH Host 到点创建真实 Task Bench，并向目标原有对话输入 Prompt；停用后停止派发 |
| 审批池 | Agent 可按存入或抽取模式连接审批池 | Plan 保持独立并统一收纳；受信任 Agent 将其视为获批预案，按“直接诉求 > 审批池 > 积压池”串行执行 |

## 21. 后续演进原则

未来需求进入产品前必须通过三个问题：

1. 它能否通过现有六类根节点和新的连线语义完成？
2. 它能否表现为系统衍生节点，而不是新增页面或模式？
3. 它是否直接增强“诉求进入 → Agent 协作 → 执行 → 审核 → 交付”这条主路径？

任一答案为否时，默认不进入当前产品。独立知识管理页面、跨系统通用通知中心、多视图投影和跨平台集成可以保留为研究方向，但不是当前承诺，也不得破坏单一 Map 产品边界。当前 Knowledge 与通知能力只作为 Map 主工作流的衍生节点和就地操作存在。
