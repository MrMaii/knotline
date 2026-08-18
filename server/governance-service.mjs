import { randomUUID } from "node:crypto";

import { ApiError } from "./database.mjs";

function requester(actor) {
  return `${actor.type}:${actor.id}`;
}

const CLASSIFICATION_CAPABILITIES = {
  context: /.*/,
  question: /question|answer|research|analyst|qa|问答|研究|分析/i,
  complex: /plan|product|architect|leader|strategy|规划|产品|架构|方案/i,
  debug: /debug|bug|fix|developer|engineer|调试|修复|开发|工程/i,
};

export function classifyDemand(demand) {
  const content = `${demand.title}\n${demand.description}`;
  const assertedIntent = content.replace(
    /(?:不要|无需|不用|不需要|禁止|do not|don't|not to)[^\n。！？.!?]{0,40}(?:feature|plan|roadmap|implement|build|refactor|design|change|execute|新功能|规划|计划|实现|开发|重构|设计|修改|新增|构建|执行)/gi,
    "",
  );
  if (/\b(debug|bug|error|exception|traceback|crash|broken|fix)\b|调试|修复|报错|错误|异常|崩溃|故障|无法运行/i.test(assertedIntent)) {
    return "debug";
  }
  const requestsWork = /\b(feature|plan|roadmap|implement|build|refactor|design|change|execute)\b|新功能|规划|计划|实现|开发|重构|设计|修改|新增|构建|执行/i.test(assertedIntent);
  const requestsContext = /\b(remember|memorize|familiarize|learn about|read and understand)\b|(?:建立|创建|生成|沉淀|保存|补充|吸收|同步)[^\n。！？.!?]{0,16}(?:上下文|记忆)|记住|了解项目|熟悉项目|阅读项目|项目事项|项目背景|供后续|以后对话|后续对话|先了解|先熟悉/i.test(content);
  if (
    !requestsWork
    && requestsContext
  ) {
    return "context";
  }
  if (
    demand.acceptanceCriteria.length > 0
    || content.length >= 120
    || requestsWork
    || /流程/i.test(content)
  ) {
    return "complex";
  }
  if (/\?|？|\b(what|why|how|when|where|who|can|could|should|is|are|does|do)\b|什么|为什么|为何|怎么|如何|是否|能否/i.test(content)) {
    return "question";
  }
  return "complex";
}

function agentCapabilityText(agent) {
  return `${agent.name} ${agent.skillId ?? ""} ${agent.role}`;
}

export function createGovernanceService(database) {
  function projectState(projectId) {
    return {
      agents: database.listAgentProfiles(projectId),
      demands: database.listDemands(projectId),
      workstreams: database.listWorkstreams(projectId),
      reviewGates: database.listReviewGates(projectId),
      changeRequests: database.listChangeRequests(projectId),
      teamMemberships: database.listAgentTeamMemberships(projectId),
      backlogPools: database.listBacklogPools(projectId),
      approvalPools: database.listApprovalPools(projectId),
      requestArtifacts: database.listRequestArtifacts(projectId),
    };
  }

  function createAgent(projectId, input) {
    if (!database.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return database.createAgentProfile({ id: randomUUID(), projectId, ...input });
  }

  function renameAgent(agentId, name) {
    if (!database.getAgentProfile(agentId)) {
      throw new ApiError(404, "AGENT_NOT_FOUND", "Agent no longer exists");
    }
    return database.renameAgentProfile(agentId, name);
  }

  function bindSkill(skillNodeId, agentProfileId) {
    const skillNode = database.getSkillNode(skillNodeId);
    const agent = database.getAgentProfile(agentProfileId);
    if (!skillNode || !agent || skillNode.projectId !== agent.projectId) {
      throw new ApiError(404, "GOVERNANCE_ENTITY_NOT_FOUND", "Skill or Agent no longer exists");
    }
    return {
      skillNode,
      agent: database.setAgentProfileSkill(agent.id, skillNode.skillId),
    };
  }

  function createTeam(firstAgentId, secondAgentId) {
    const first = database.getAgentProfile(firstAgentId);
    const second = database.getAgentProfile(secondAgentId);
    if (!first || !second || first.projectId !== second.projectId) {
      throw new ApiError(404, "AGENT_NOT_FOUND", "Both Agents must exist in the same Project");
    }
    if (first.id === second.id) {
      throw new ApiError(409, "DISTINCT_AGENTS_REQUIRED", "A Team requires two different Agents");
    }
    if (database.getAgentTeamMembers(first.id).length > 0 || database.getAgentTeamMembers(second.id).length > 0) {
      throw new ApiError(409, "TEAM_MEMBER_REQUIRED", "Create a Team from two individual Agents");
    }
    const teamAgentId = randomUUID();
    const name = `${first.name} + ${second.name}`;
    const memberLine = (agent) => {
      const binding = database.getAgentRuntimeBindingByProfile(agent.id);
      return `- ${agent.name}: session ${binding?.sessionId ?? "not provisioned"}; work style ${agent.skillId ?? agent.role}; model ${agent.model ?? "workspace default"}`;
    };
    return database.createAgentTeam({
      teamAgentId,
      projectId: first.projectId,
      name,
      memberAgentIds: [first.id, second.id],
      planItemId: randomUUID(),
      protocolItemId: randomUUID(),
      plan: [
        `# ${name} Collaboration Plan`,
        memberLine(first),
        memberLine(second),
        "- Preserve each member's own conversation history and working method.",
        "- Reconcile both member perspectives before publishing one external response.",
      ].join("\n"),
      protocol: [
        `# ${name} Working Protocol`,
        "1. Read both member histories before starting shared work.",
        "2. Produce an internal plan and resolve disagreements explicitly.",
        "3. Work externally through the Team as one Agent.",
        "4. Publish one shared working document with evidence and open questions.",
      ].join("\n"),
    });
  }

  function createDemand(projectId, input, actor) {
    if (!database.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return database.createDemand({
      id: randomUUID(),
      projectId,
      ...input,
      createdBy: requester(actor),
    });
  }

  function createBacklogPool(projectId, input, actor) {
    if (!database.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return database.createBacklogPool({
      id: randomUUID(),
      projectId,
      title: input.title,
      createdBy: requester(actor),
    });
  }

  function createApprovalPool(projectId, input, actor) {
    if (!database.getProject(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    return database.createApprovalPool({
      id: randomUUID(),
      projectId,
      title: input.title,
      createdBy: requester(actor),
    });
  }

  function intakeDemand(demandId, leaderAgentId) {
    const demand = database.getDemand(demandId);
    const leader = database.getAgentProfile(leaderAgentId);
    if (!demand || !leader || demand.projectId !== leader.projectId) {
      throw new ApiError(404, "GOVERNANCE_ENTITY_NOT_FOUND", "Demand or Leader no longer exists");
    }
    if (leader.role !== "leader") {
      throw new ApiError(409, "LEADER_REQUIRED", "Demand intake requires a Leader Agent");
    }
    if (demand.status !== "new") {
      throw new ApiError(409, "DEMAND_ALREADY_ROUTED", "Demand has already entered governance");
    }
    return database.createWorkstreamWithReviewGate({
      workstreamId: randomUUID(),
      reviewGateId: randomUUID(),
      projectId: demand.projectId,
      demandId: demand.id,
      leaderAgentId: leader.id,
      title: demand.title,
      goal: demand.description || demand.title,
      scope: [demand.description || demand.title],
      exclusions: ["未在需求与验收标准中明确列出的工作"],
      risks: ["Reviewer 需要确认范围、依赖和交付证据是否充分"],
      dependencies: [],
      acceptanceCriteria: demand.acceptanceCriteria.length > 0
        ? demand.acceptanceCriteria
        : [`完成并证明：${demand.title}`],
      deliverables: [`${demand.title} 的实现、验证证据与交付说明`],
    });
  }

  function routeDemandToAgent(demandId, agentProfileId, agentAvailable = () => true) {
    const demand = database.getDemand(demandId);
    const agent = database.getAgentProfile(agentProfileId);
    if (!demand || !agent || demand.projectId !== agent.projectId) {
      throw new ApiError(404, "GOVERNANCE_ENTITY_NOT_FOUND", "Demand or Agent no longer exists");
    }
    if (demand.status !== "new") {
      throw new ApiError(409, "DEMAND_ALREADY_ROUTED", "Demand has already been assigned");
    }
    const classification = classifyDemand(demand);
    const capability = CLASSIFICATION_CAPABILITIES[classification];
    const requestedMatches = capability.test(agentCapabilityText(agent));
    const specialist = requestedMatches ? null : database.listAgentProfiles(demand.projectId)
      .filter((candidate) => (
        candidate.id !== agent.id
        && capability.test(agentCapabilityText(candidate))
        && agentAvailable(candidate.id)
      ))
      .sort((left, right) => {
        const leftBusy = left.status === "working" ? 1 : 0;
        const rightBusy = right.status === "working" ? 1 : 0;
        return leftBusy - rightBusy || left.createdAt.localeCompare(right.createdAt);
      })[0] ?? null;
    const selectedAgent = specialist ?? agent;
    const classifiedDemand = database.setDemandClassification(demand.id, classification);
    return {
      ...database.createApprovedWorkstream({
      workstreamId: randomUUID(),
      projectId: demand.projectId,
      demandId: demand.id,
      agentProfileId: selectedAgent.id,
      title: demand.title,
      goal: demand.description || demand.title,
      scope: [demand.description || demand.title],
      exclusions: [],
      risks: classification === "debug" ? ["修复必须在当前 DeepSeek 工作区内验证"] : [],
      dependencies: [],
      acceptanceCriteria: demand.acceptanceCriteria.length > 0
        ? demand.acceptanceCriteria
        : [`完成并证明：${demand.title}`],
      deliverables: classification === "question"
        ? [`${demand.title} 的独立回答节点`]
        : classification === "complex"
          ? [`${demand.title} 的审核反馈`, `${demand.title} 的完整计划书`]
          : [`${demand.title} 的修复、验证证据与预审查档案`],
      }),
      demand: classifiedDemand,
      requestedAgent: agent,
      agent: selectedAgent,
      classification,
      delegated: selectedAgent.id !== agent.id,
    };
  }

  function assignArtifactReviewer(reviewGateId, reviewerAgentId) {
    const reviewGate = database.getReviewGate(reviewGateId);
    const reviewer = database.getAgentProfile(reviewerAgentId);
    const workstream = reviewGate ? database.getWorkstream(reviewGate.workstreamId) : null;
    const executionRun = reviewGate?.nodeRunId ? database.getNodeRun(reviewGate.nodeRunId) : null;
    if (!reviewGate || !reviewer || !workstream || reviewer.projectId !== reviewGate.projectId) {
      throw new ApiError(404, "GOVERNANCE_ENTITY_NOT_FOUND", "Pre-review artifact or Agent no longer exists");
    }
    if (reviewGate.purpose !== "execution" || reviewGate.status !== "pending") {
      throw new ApiError(409, "PRE_REVIEW_REQUIRED", "Only a pending pre-review artifact can be assigned");
    }
    if (executionRun?.agentProfileId === reviewer.id) {
      throw new ApiError(409, "INDEPENDENT_REVIEW_REQUIRED", "Send the artifact to a different Agent");
    }
    return database.assignWorkstreamReviewer(workstream.id, reviewer.id);
  }

  function assignReviewer(workstreamId, reviewerAgentId) {
    const workstream = database.getWorkstream(workstreamId);
    const reviewer = database.getAgentProfile(reviewerAgentId);
    if (!workstream || !reviewer || workstream.projectId !== reviewer.projectId) {
      throw new ApiError(404, "GOVERNANCE_ENTITY_NOT_FOUND", "Workstream or Reviewer no longer exists");
    }
    if (reviewer.role !== "reviewer") {
      throw new ApiError(409, "REVIEWER_REQUIRED", "Review assignment requires a Reviewer Agent");
    }
    if (workstream.leaderAgentId === reviewer.id) {
      throw new ApiError(409, "INDEPENDENT_REVIEW_REQUIRED", "A Workstream Leader cannot review the same Workstream");
    }
    if (workstream.status !== "review") {
      throw new ApiError(409, "WORKSTREAM_NOT_IN_REVIEW", "Reviewer can only be assigned while the Workstream is in review");
    }
    return database.assignWorkstreamReviewer(workstream.id, reviewer.id);
  }

  function decideReview(reviewGateId, decision, comment, actor) {
    const reviewGate = database.getReviewGate(reviewGateId);
    if (!reviewGate) throw new ApiError(404, "REVIEW_GATE_NOT_FOUND", "Review Gate no longer exists");
    if (reviewGate.status !== "pending") {
      throw new ApiError(409, "REVIEW_ALREADY_DECIDED", "Review Gate already has a decision");
    }
    if (!reviewGate.reviewerAgentId) {
      throw new ApiError(409, "REVIEWER_REQUIRED", "Assign an independent Reviewer before deciding");
    }
    return database.recordReviewDecision({
      id: randomUUID(),
      reviewGateId,
      workstreamId: reviewGate.workstreamId,
      decision,
      comment,
      decidedBy: requester(actor),
    });
  }

  function createChangeRequest(demandId, workstreamId) {
    const demand = database.getDemand(demandId);
    const workstream = database.getWorkstream(workstreamId);
    if (!demand || !workstream || demand.projectId !== workstream.projectId) {
      throw new ApiError(404, "GOVERNANCE_ENTITY_NOT_FOUND", "Demand or Workstream no longer exists");
    }
    if (demand.status !== "new") {
      throw new ApiError(409, "DEMAND_ALREADY_ROUTED", "Demand has already entered governance");
    }
    if (!["approved", "staffed", "executing", "acceptance", "delivered"].includes(workstream.status)) {
      throw new ApiError(409, "APPROVED_WORKSTREAM_REQUIRED", "Scope changes require an approved Workstream");
    }
    return database.createChangeRequest({
      id: randomUUID(),
      projectId: demand.projectId,
      workstreamId: workstream.id,
      demandId: demand.id,
      title: `Change: ${demand.title}`,
      description: demand.description,
    });
  }

  return {
    projectState,
    createAgent,
    renameAgent,
    bindSkill,
    createTeam,
    createDemand,
    createBacklogPool,
    createApprovalPool,
    intakeDemand,
    routeDemandToAgent,
    assignReviewer,
    assignArtifactReviewer,
    decideReview,
    createChangeRequest,
  };
}
