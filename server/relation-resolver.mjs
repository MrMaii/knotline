import { classifyDemand } from "./governance-service.mjs";

export function resolveRelation(source, target) {
  if (source.entityType === "scheduled_trigger" && target.entityType === "agent_profile") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "connect_scheduled_trigger",
        label: target.data.kind === "Team" ? "定时输入 Team" : "定时输入 Agent",
        labelEn: target.data.kind === "Team" ? "Schedule prompt for Team" : "Schedule prompt for Agent",
        input: {},
      },
    };
  }
  if (source.entityType === "skill" && target.entityType === "agent_profile") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "bind_skill",
        label: target.data.kind === "Team" ? "设为 Team 工作 Skill" : "设为 Agent 工作 Skill",
        labelEn: target.data.kind === "Team" ? "Set Team work Skill" : "Set Agent work Skill",
        input: {},
      },
    };
  }
  if (source.entityType === "demand" && target.entityType === "backlog_pool") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "queue_demand",
        label: "加入积压池并自动排期",
        labelEn: "Queue in Backlog and schedule",
        input: {},
      },
    };
  }
  if (source.entityType === "backlog_pool" && target.entityType === "agent_profile") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "join_backlog",
        label: "从积压池持续提取事项",
        labelEn: "Pull work continuously from Backlog",
        input: { mode: "pull" },
      },
    };
  }
  if (source.entityType === "agent_profile" && target.entityType === "backlog_pool") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "join_backlog",
        label: "把超额待办暂存进积压池",
        labelEn: "Cache excess direct work in Backlog",
        input: { mode: "cache" },
      },
    };
  }
  if (source.entityType === "approval_pool" && target.entityType === "agent_profile") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "join_approval_pool",
        label: "从审批池读取并执行",
        labelEn: "Pull and execute from Approval Pool",
        input: { mode: "pull" },
      },
    };
  }
  if (source.entityType === "agent_profile" && target.entityType === "approval_pool") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "join_approval_pool",
        label: "把审批预案存入审批池",
        labelEn: "Deposit approval proposals into Approval Pool",
        input: { mode: "deposit" },
      },
    };
  }
  if (
    source.entityType === "agent_profile"
    && target.entityType === "agent_profile"
    && source.id !== target.id
    && !source.data.details?.teamMembers?.length
    && !target.data.details?.teamMembers?.length
  ) {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "create_team",
        label: "组合为一个 Team",
        labelEn: "Combine as one Team",
        input: {},
      },
    };
  }
  if (
    source.entityType === "review_gate"
    && source.data.details?.purpose === "execution"
    && source.data.status === "pending"
    && target.entityType === "agent_profile"
  ) {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "assign_artifact_review",
        label: "交给 Agent 预审查",
        labelEn: "Send to Agent for pre-review",
        input: {},
      },
    };
  }
  if (source.entityType === "demand" && target.entityType === "agent_profile") {
    const classification = classifyDemand({
      title: source.data.title,
      description: source.data.subtitle,
      acceptanceCriteria: source.data.details?.acceptanceCriteria ?? [],
    });
    const contextRequest = source.data.details?.classification === "context" || classification === "context";
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: contextRequest ? "remember_context" : "execute_demand",
        label: contextRequest ? "交给 Agent 形成上下文" : "交给 Agent 执行需求",
        labelEn: contextRequest ? "Add to Agent context" : "Assign Demand to Agent",
        input: {},
      },
    };
  }
  if (
    ["prompt", "question", "constraint", "background_material"].includes(source.entityType)
    && target.entityType === "agent_profile"
  ) {
    const runtimeBinding = target.data.details?.runtimeBinding;
    const active = Boolean(runtimeBinding?.currentNodeRunId);
    const mode = !active
      ? "followup"
      : ["background_material", "constraint"].includes(source.entityType) ? "inject" : "steer";
    const labels = {
      followup: ["加入 Agent 后续队列", "Queue as Agent follow-up"],
      steer: ["调整 Agent 当前方向", "Steer active Agent"],
      inject: ["注入 Agent 当前上下文", "Inject active Agent context"],
    };
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "message_agent",
        label: labels[mode][0],
        labelEn: labels[mode][1],
        input: { mode, message: source.data.details?.content || source.data.title },
      },
    };
  }
  if (source.entityType === "knowledge_asset" && target.entityType === "agent_profile") {
    const contextDocument = source.data.kind === "Context Document";
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: contextDocument ? "attach_context" : "bind_knowledge",
        label: contextDocument ? "把上下文吸附到 Agent" : "同步知识并创建了解项目节点",
        labelEn: contextDocument ? "Attach context to Agent" : "Bind knowledge and create a sync node",
        input: {},
      },
    };
  }
  if (source.entityType === "delivery" && target.entityType === "knowledge_asset") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "propose_knowledge_update",
        label: "创建知识更新提案",
        labelEn: "Create Knowledge Update Proposal",
        input: {},
      },
    };
  }
  if (
    source.entityType === "agent_profile"
    && ["leader", "executor"].includes(source.data.role)
    && target.entityType === "workstream"
  ) {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "assign_agent",
        label: "分配 Agent 执行 Workstream",
        labelEn: "Assign Agent to Workstream",
        input: {},
      },
    };
  }
  if (source.entityType === "agent_profile" && source.data.role === "reviewer" && target.entityType === "workstream") {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "assign_reviewer",
        label: "指定独立 Reviewer",
        labelEn: "Assign independent Reviewer",
        input: {},
      },
    };
  }
  if (
    source.entityType === "demand"
    && target.entityType === "workstream"
    && ["approved", "staffed", "executing", "acceptance", "delivered"].includes(target.data.status)
  ) {
    return {
      mode: "direct",
      source: { id: source.id, entityType: source.entityType, title: source.data.title },
      target: { id: target.id, entityType: target.entityType, title: target.data.title },
      action: {
        actionType: "create_change_request",
        label: "创建 Change Request",
        labelEn: "Create Change Request",
        input: {},
      },
    };
  }
  return {
    mode: "unsupported",
    source: { id: source.id, entityType: source.entityType, title: source.data.title },
    target: { id: target.id, entityType: target.entityType, title: target.data.title },
    message: `该方向不能执行：${source.data.title} → ${target.data.title}。请向接收节点方向滑动。`,
  };
}
