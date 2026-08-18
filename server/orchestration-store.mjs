import { randomUUID } from "node:crypto";

import { ApiError } from "./database.mjs";

const SYSTEM_ACTOR = {
  type: "agent",
  id: "knotline-orchestrator",
  name: "Knotline Orchestrator",
  avatarUrl: null,
};

function executionInstruction(agent, workstream, demand, options = {}) {
  const outputInstruction = options.planningOnly
    ? "Do not modify project files. Produce one formal feature module report with implementation scope, file-level changes, risks, acceptance criteria, and verification steps. Put the report summary in delivery summary and the complete report in evidence."
    : demand?.classification === "question"
    ? "Answer the question directly. Put the complete answer in delivery summary and supporting detail in evidence."
    : demand?.classification === "complex"
      ? "First write review feedback in delivery summary. Then write the complete implementation plan in evidence."
      : demand?.classification === "debug"
        ? "Inspect and repair the currently selected DeepSeek workspace. Run relevant verification and include exact evidence."
        : "Produce the requested result and verification evidence.";
  return [
    `Execute Workstream: ${workstream.title}`,
    `Request classification: ${demand?.classification ?? "complex"}`,
    "Map contract: the only user-creatable root nodes are Agent, Request, Skill, Backlog, and Scheduled Trigger. Every other visible node is derived by the system.",
    `Goal: ${workstream.goal}`,
    `Scope: ${workstream.scope.join("; ")}`,
    `Exclusions: ${workstream.exclusions.join("; ")}`,
    `Acceptance criteria: ${workstream.acceptanceCriteria.join("; ")}`,
    `Deliverables: ${workstream.deliverables.join("; ")}`,
    `Assigned role: ${agent.role}`,
    outputInstruction,
    "Use Knotline node tools for every lifecycle change. Submit delivery when evidence is ready.",
  ].join("\n");
}

export function createOrchestrationStore(database) {
  function createStandaloneRun(agentProfileId, title, instruction) {
    const agent = database.getAgentProfile(agentProfileId);
    if (!agent) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent no longer exists");
    const task = database.createTask({
      projectId: agent.projectId,
      title,
      description: instruction,
      status: "todo",
      priority: "medium",
      labels: [],
      sortOrder: undefined,
      threadId: null,
      threadBinding: null,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
      actor: SYSTEM_ACTOR,
      assignee: { type: "agent", id: agent.id, name: agent.name, avatarUrl: null },
    });
    const nodeRun = database.createNodeRun({
      id: randomUUID(),
      projectId: agent.projectId,
      workstreamId: null,
      taskId: task.id,
      agentProfileId: agent.id,
      instruction,
    });
    database.createAgentRuntimeBinding({
      id: randomUUID(),
      projectId: agent.projectId,
      agentProfileId: agent.id,
      currentNodeRunId: nodeRun.id,
    });
    const binding = database.updateAgentRuntimeBinding(agent.id, {
      currentNodeRunId: nodeRun.id,
      status: "waiting",
      lastError: null,
    });
    return { agent: database.getAgentProfile(agent.id), task, nodeRun, binding };
  }

  function projectState(projectId) {
    return {
      bindings: database.listAgentRuntimeBindings(projectId),
      nodeRuns: database.listNodeRuns(projectId),
    };
  }

  function assignAgent(agentProfileId, workstreamId, options = {}) {
    const agent = database.getAgentProfile(agentProfileId);
    const workstream = database.getWorkstream(workstreamId);
    if (!agent || !workstream || agent.projectId !== workstream.projectId) {
      throw new ApiError(404, "ORCHESTRATION_ENTITY_NOT_FOUND", "Agent or Workstream no longer exists");
    }
    if (workstream.status !== "approved") {
      throw new ApiError(409, "WORKSTREAM_NOT_APPROVED", "A Workstream must be approved before execution");
    }
    const demand = workstream.demandId ? database.getDemand(workstream.demandId) : null;
    const instruction = executionInstruction(agent, workstream, demand, options);
    const task = database.createTask({
      projectId: workstream.projectId,
      title: workstream.title,
      description: instruction,
      status: "todo",
      priority: "medium",
      labels: [],
      sortOrder: undefined,
      threadId: null,
      threadBinding: null,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
      actor: SYSTEM_ACTOR,
      assignee: { type: "agent", id: agent.id, name: agent.name, avatarUrl: null },
    });
    const nodeRun = database.createNodeRun({
      id: randomUUID(),
      projectId: workstream.projectId,
      workstreamId: workstream.id,
      taskId: task.id,
      agentProfileId: agent.id,
      instruction,
    });
    const binding = database.createAgentRuntimeBinding({
      id: randomUUID(),
      projectId: workstream.projectId,
      agentProfileId: agent.id,
      currentNodeRunId: nodeRun.id,
    });
    const activeBinding = database.updateAgentRuntimeBinding(agent.id, {
      currentNodeRunId: nodeRun.id,
      status: "waiting",
      lastError: null,
    }) ?? binding;
    return {
      agent: database.getAgentProfile(agent.id),
      workstream: database.setWorkstreamStatus(workstream.id, "staffed"),
      task,
      nodeRun,
      binding: activeBinding,
    };
  }

  function queueFollowup(agentProfileId, instruction) {
    const agent = database.getAgentProfile(agentProfileId);
    const binding = database.getAgentRuntimeBindingByProfile(agentProfileId);
    const currentRun = binding?.currentNodeRunId
      ? database.getNodeRun(binding.currentNodeRunId)
      : database.getLatestNodeRunForAgent(agentProfileId);
    if (!agent || !binding || !currentRun) {
      throw new ApiError(409, "AGENT_NOT_ASSIGNED", "Assign the Agent to a Workstream before adding queued work");
    }
    const task = database.createTask({
      projectId: agent.projectId,
      title: instruction.split(/\r?\n/, 1)[0].slice(0, 240),
      description: instruction,
      status: "todo",
      priority: "medium",
      labels: [],
      sortOrder: undefined,
      threadId: null,
      threadBinding: null,
      workflowId: null,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
      actor: SYSTEM_ACTOR,
      assignee: { type: "agent", id: agent.id, name: agent.name, avatarUrl: null },
    });
    return database.createNodeRun({
      id: randomUUID(),
      projectId: agent.projectId,
      workstreamId: currentRun.workstreamId,
      taskId: task.id,
      agentProfileId: agent.id,
      parentRunId: currentRun.id,
      instruction,
    });
  }

  function reviewArtifact(agentProfileId, reviewGateId) {
    const agent = database.getAgentProfile(agentProfileId);
    const reviewGate = database.getReviewGate(reviewGateId);
    const workstream = reviewGate ? database.getWorkstream(reviewGate.workstreamId) : null;
    const executionRun = reviewGate?.nodeRunId ? database.getNodeRun(reviewGate.nodeRunId) : null;
    if (!agent || !reviewGate || !workstream || !executionRun || agent.projectId !== reviewGate.projectId) {
      throw new ApiError(404, "REVIEW_ENTITY_NOT_FOUND", "Pre-review artifact or Agent no longer exists");
    }
    const result = executionRun.result ?? {};
    return createStandaloneRun(
      agent.id,
      `Review: ${workstream.title}`,
      [
        `Review the pre-review artifact for ${workstream.title}.`,
        `Project ID: ${workstream.projectId}`,
        `Review Gate ID: ${reviewGate.id}`,
        `Workstream ID: ${workstream.id}`,
        `Summary: ${String(result.summary ?? workstream.title)}`,
        `Evidence: ${String(result.evidence ?? "No evidence supplied")}`,
        "Use knotline_submit_artifact_review with this Node Run ID, Review Gate ID, Project ID, and Workstream ID.",
        "Approve only when the evidence satisfies the Demand; otherwise reject with a concrete reason.",
      ].join("\n"),
    );
  }

  return {
    projectState,
    assignAgent,
    queueFollowup,
    reviewArtifact,
    createStandaloneRun,
    getNodeRun: (id) => database.getNodeRun(id),
    getBindingByProfile: (id) => database.getAgentRuntimeBindingByProfile(id),
    getBindingBySession: (id) => database.getAgentRuntimeBindingBySession(id),
    listRecoverableNodeRuns: () => database.listRecoverableNodeRuns(),
    updateNodeRun: (id, changes) => database.updateNodeRun(id, changes),
    updateBinding: (id, changes) => database.updateAgentRuntimeBinding(id, changes),
  };
}
