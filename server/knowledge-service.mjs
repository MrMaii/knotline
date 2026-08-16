import { randomUUID } from "node:crypto";

import { ApiError } from "./database.mjs";

const SYSTEM_ACTOR = {
  type: "agent",
  id: "knotline-orchestrator",
  name: "Knotline Orchestrator",
  avatarUrl: null,
};

function actorKey(actor) {
  return `${actor.type}:${actor.id}`;
}

export function createKnowledgeService(database, orchestration) {
  function projectState(projectId) {
    return {
      assets: database.listKnowledgeAssets(projectId).map((asset) => ({
        ...asset,
        currentVersionData: database.getKnowledgeVersion(asset.id, asset.currentVersion),
      })),
      bindings: database.listKnowledgeBindings(projectId),
      proposals: database.listKnowledgeProposals(projectId),
      deliveries: database.listDeliveries(projectId),
    };
  }

  function initializeWithLeader(projectId, leaderAgentId) {
    const project = database.getProject(projectId);
    const leader = database.getAgentProfile(leaderAgentId);
    if (!project || !leader || leader.projectId !== projectId || leader.role !== "leader") {
      throw new ApiError(409, "LEADER_REQUIRED", "Knowledge initialization requires this Project's Leader Agent");
    }
    if (database.listKnowledgeAssets(projectId).length > 0) {
      throw new ApiError(409, "KNOWLEDGE_ALREADY_INITIALIZED", "Project Knowledge v1 already exists");
    }
    return orchestration.createStandaloneRun(
      leader.id,
      `Initialize knowledge: ${project.name}`,
      [
        `Initialize Project Knowledge v1 for ${project.name}.`,
        "Read the current project code, documentation, Tasks, Workstreams, historical DSH Sessions, and runtime state.",
        "Capture architecture, decisions, rules, risks, open questions, and candidate Workstreams.",
        "Call knotline_propose_knowledge_update with the complete grounded result, then submit the node.",
      ].join("\n"),
    );
  }

  function bindKnowledge(assetId, agentProfileId) {
    const asset = database.getKnowledgeAsset(assetId);
    const agent = database.getAgentProfile(agentProfileId);
    if (!asset || !agent || asset.projectId !== agent.projectId) {
      throw new ApiError(404, "KNOWLEDGE_ENTITY_NOT_FOUND", "Knowledge or Agent no longer exists");
    }
    const version = database.getKnowledgeVersion(asset.id, asset.currentVersion);
    const run = orchestration.createStandaloneRun(
      agent.id,
      `Understand project: ${asset.title} v${asset.currentVersion}`,
      [
        `Synchronize Knowledge Asset ${asset.title} to version ${asset.currentVersion}.`,
        "Read and internalize this version. Report concrete implications for current work.",
        "Do not propose a Knowledge update during synchronization.",
        "Finish by calling knotline_submit_delivery with a concise synchronization summary and evidence.",
        `<knowledge_asset id="${asset.id}" version="${asset.currentVersion}">`,
        version.content,
        "</knowledge_asset>",
      ].join("\n"),
    );
    const binding = database.saveKnowledgeBinding({
      id: randomUUID(),
      projectId: asset.projectId,
      assetId: asset.id,
      agentProfileId: agent.id,
      boundVersion: database.getKnowledgeBinding(asset.id, agent.id)?.boundVersion ?? asset.currentVersion,
      syncTaskId: run.task.id,
    });
    return { ...run, asset, knowledgeVersion: version, knowledgeBinding: binding };
  }

  function contextualizeDemand(demandId, agentProfileId, actor, generatedContent = "") {
    const demand = database.getDemand(demandId);
    const agent = database.getAgentProfile(agentProfileId);
    if (!demand || !agent || demand.projectId !== agent.projectId) {
      throw new ApiError(404, "KNOWLEDGE_ENTITY_NOT_FOUND", "Context Request or Agent no longer exists");
    }
    const existing = database.getKnowledgeAssetBySourceDemand(demand.id);
    const initialized = existing
      ? {
          asset: existing,
          knowledgeVersion: database.getKnowledgeVersion(existing.id, existing.currentVersion),
        }
      : database.createKnowledgeAssetV1({
          assetId: randomUUID(),
          versionId: randomUUID(),
          projectId: demand.projectId,
          title: demand.title,
          kind: "context_document",
          sourceDemandId: demand.id,
          content: generatedContent.trim() || [
            `# ${demand.title}`,
            demand.description || demand.title,
          ].join("\n\n"),
          createdBy: actorKey(actor),
        });
    const knowledgeBinding = database.saveKnowledgeBindingDirect({
      id: randomUUID(),
      projectId: demand.projectId,
      assetId: initialized.asset.id,
      agentProfileId: agent.id,
      boundVersion: initialized.asset.currentVersion,
    });
    return {
      demand: database.contextualizeDemand(demand.id),
      agent,
      ...initialized,
      knowledgeBinding,
    };
  }

  function completeContextualization(nodeRunId, result, actor) {
    const nodeRun = database.getNodeRun(nodeRunId);
    const match = nodeRun?.instruction.match(/<knotline_context_request demand_id="([^"]+)">/);
    if (!nodeRun || !match) return null;
    const content = [result?.summary, result?.evidence].filter(Boolean).join("\n\n");
    return {
      kind: "context_attached",
      runtimeProduced: true,
      ...contextualizeDemand(match[1], nodeRun.agentProfileId, actor, content),
      ...finishStandaloneRun(nodeRun, result),
    };
  }

  function duplicateContext(assetId, actor) {
    const asset = database.getKnowledgeAsset(assetId);
    if (!asset || asset.kind !== "context_document") {
      throw new ApiError(404, "CONTEXT_DOCUMENT_NOT_FOUND", "Context Document no longer exists");
    }
    const version = database.getKnowledgeVersion(asset.id, asset.currentVersion);
    return database.createKnowledgeAssetV1({
      assetId: randomUUID(),
      versionId: randomUUID(),
      projectId: asset.projectId,
      title: `${asset.title} · 副本`,
      kind: "context_document",
      sourceDemandId: null,
      content: version.content,
      createdBy: actorKey(actor),
    });
  }

  function attachContext(assetId, agentProfileId) {
    const asset = database.getKnowledgeAsset(assetId);
    const agent = database.getAgentProfile(agentProfileId);
    if (!asset || !agent || asset.projectId !== agent.projectId || asset.kind !== "context_document") {
      throw new ApiError(404, "CONTEXT_DOCUMENT_NOT_FOUND", "Context Document or Agent no longer exists");
    }
    const knowledgeVersion = database.getKnowledgeVersion(asset.id, asset.currentVersion);
    const knowledgeBinding = database.saveKnowledgeBindingDirect({
      id: randomUUID(),
      projectId: asset.projectId,
      assetId: asset.id,
      agentProfileId: agent.id,
      boundVersion: asset.currentVersion,
    });
    return { asset, agent, knowledgeVersion, knowledgeBinding };
  }

  function finishStandaloneRun(nodeRun, result) {
    const task = database.getTask(nodeRun.taskId);
    const updatedTask = task.status === "done"
      ? task
      : database.moveTask(task.id, task.version, "done", undefined, undefined, undefined, SYSTEM_ACTOR);
    const completedRun = database.updateNodeRun(nodeRun.id, {
      status: "completed",
      result: result ?? nodeRun.result,
      error: null,
    });
    const binding = database.updateAgentRuntimeBinding(nodeRun.agentProfileId, {
      currentNodeRunId: null,
      status: "idle",
      lastError: null,
    });
    return { nodeRun: completedRun, task: updatedTask, binding };
  }

  function proposeFromNodeRun(nodeRunId, input, actor) {
    const nodeRun = database.getNodeRun(nodeRunId);
    if (!nodeRun) throw new ApiError(404, "NODE_RUN_NOT_FOUND", "Node Run no longer exists");
    if (nodeRun.status === "completed") {
      throw new ApiError(409, "NODE_RUN_ALREADY_COMPLETED", "A completed Node Run cannot create another Knowledge Proposal");
    }
    if (database.getKnowledgeBindingBySyncTask(nodeRun.taskId)) {
      throw new ApiError(409, "KNOWLEDGE_SYNC_ONLY", "Knowledge synchronization cannot create a Knowledge Proposal");
    }
    const assets = database.listKnowledgeAssets(nodeRun.projectId);
    if (assets.length === 0) {
      const leader = database.getAgentProfile(nodeRun.agentProfileId);
      if (leader?.role !== "leader") {
        throw new ApiError(409, "LEADER_REQUIRED", "Only a Leader Agent can publish Project Knowledge v1");
      }
      const initialized = database.createKnowledgeAssetV1({
        assetId: randomUUID(),
        versionId: randomUUID(),
        projectId: nodeRun.projectId,
        title: input.title,
        content: input.content,
        createdBy: actorKey(actor),
      });
      return { kind: "knowledge_initialized", ...initialized, ...finishStandaloneRun(nodeRun) };
    }
    const delivery = database.getDeliveryByNodeRun(nodeRun.id);
    const proposal = database.createKnowledgeProposal({
      id: randomUUID(),
      projectId: nodeRun.projectId,
      assetId: assets[0].id,
      deliveryId: delivery?.id ?? null,
      title: input.title,
      content: input.content,
      proposedBy: actorKey(actor),
    });
    return { kind: "knowledge_proposal", proposal, asset: assets[0] };
  }

  function completeKnowledgeSync(nodeRunId, result) {
    const nodeRun = database.getNodeRun(nodeRunId);
    const knowledgeBinding = nodeRun ? database.getKnowledgeBindingBySyncTask(nodeRun.taskId) : null;
    if (!nodeRun || !knowledgeBinding) return null;
    const asset = database.getKnowledgeAsset(knowledgeBinding.assetId);
    const completedBinding = database.completeKnowledgeBindingSync(knowledgeBinding.id, asset.currentVersion);
    return { ...finishStandaloneRun(nodeRun, result), asset, knowledgeBinding: completedBinding };
  }

  function completeStandaloneNodeRun(nodeRunId, result) {
    const nodeRun = database.getNodeRun(nodeRunId);
    return nodeRun ? finishStandaloneRun(nodeRun, result) : null;
  }

  function requestExecutionReview(nodeRunId) {
    const nodeRun = database.getNodeRun(nodeRunId);
    const workstream = nodeRun?.workstreamId ? database.getWorkstream(nodeRun.workstreamId) : null;
    if (!nodeRun || !workstream) {
      throw new ApiError(409, "WORKSTREAM_RUN_REQUIRED", "Independent execution review requires a Workstream Node Run");
    }
    const existing = database.getExecutionReviewByNodeRun(nodeRun.id);
    const reviewGate = existing ?? database.createExecutionReviewGate({
      id: randomUUID(),
      projectId: nodeRun.projectId,
      workstreamId: workstream.id,
      nodeRunId: nodeRun.id,
      reviewerAgentId: workstream.reviewerAgentId ?? null,
    });
    return { reviewGate, nodeRun, workstream };
  }

  function proposeFromDelivery(deliveryId, assetId, actor) {
    const delivery = database.getDelivery(deliveryId);
    const asset = database.getKnowledgeAsset(assetId);
    if (!delivery || !asset || delivery.projectId !== asset.projectId) {
      throw new ApiError(404, "KNOWLEDGE_ENTITY_NOT_FOUND", "Delivery or Knowledge no longer exists");
    }
    const currentVersion = database.getKnowledgeVersion(asset.id, asset.currentVersion);
    const proposal = database.createKnowledgeProposal({
      id: randomUUID(),
      projectId: delivery.projectId,
      assetId: asset.id,
      deliveryId: delivery.id,
      title: `Update ${asset.title} from Delivery`,
      content: [
        currentVersion.content,
        `## Delivery Update — ${delivery.summary}`,
        `Delivery ${delivery.id} approved for Workstream ${delivery.workstreamId}.`,
        `Evidence:\n${delivery.evidence}`,
      ].join("\n\n"),
      proposedBy: actorKey(actor),
    });
    return { proposal, asset, delivery };
  }

  function decideExecutionReview(reviewGateId, decision, comment, actor) {
    const reviewGate = database.getReviewGate(reviewGateId);
    if (!reviewGate || reviewGate.purpose !== "execution" || !reviewGate.nodeRunId) {
      throw new ApiError(404, "EXECUTION_REVIEW_NOT_FOUND", "Execution Review no longer exists");
    }
    if (reviewGate.status !== "pending") {
      throw new ApiError(409, "REVIEW_ALREADY_DECIDED", "Execution Review already has a decision");
    }
    if (!reviewGate.reviewerAgentId) {
      throw new ApiError(409, "REVIEWER_REQUIRED", "Assign an independent Reviewer before deciding");
    }
    const nodeRun = database.getNodeRun(reviewGate.nodeRunId);
    const task = database.getTask(nodeRun.taskId);
    const workstream = database.getWorkstream(nodeRun.workstreamId);
    const decidedGate = database.recordExecutionReviewDecision({
      id: randomUUID(),
      reviewGateId: reviewGate.id,
      decision,
      comment,
      decidedBy: actorKey(actor),
    });
    if (decision === "rejected") {
      const changedRun = database.updateNodeRun(nodeRun.id, { status: "changes_requested", error: comment || null });
      const changedTask = database.moveTask(
        task.id,
        task.version,
        "in_progress",
        undefined,
        undefined,
        undefined,
        actor,
      );
      const reworkRun = orchestration.queueFollowup(nodeRun.agentProfileId, `Rework requested: ${comment || "Address review feedback."}`);
      database.updateAgentRuntimeBinding(nodeRun.agentProfileId, {
        currentNodeRunId: reworkRun.id,
        status: "waiting",
        lastError: null,
      });
      return {
        kind: "execution_review_rejected",
        reviewGate: decidedGate,
        nodeRun: changedRun,
        task: changedTask,
        workstream: database.setWorkstreamStatus(workstream.id, "executing"),
        reworkRun,
      };
    }
    const result = nodeRun.result ?? { summary: task.title, evidence: "" };
    const delivery = database.createDelivery({
      id: randomUUID(),
      projectId: nodeRun.projectId,
      workstreamId: workstream.id,
      nodeRunId: nodeRun.id,
      taskId: task.id,
      reviewerAgentId: reviewGate.reviewerAgentId,
      summary: String(result.summary ?? task.title),
      evidence: String(result.evidence ?? ""),
    });
    const completedRun = database.updateNodeRun(nodeRun.id, { status: "completed", error: null });
    const completedTask = database.moveTask(task.id, task.version, "done", undefined, undefined, undefined, actor);
    const deliveredWorkstream = database.setWorkstreamStatus(workstream.id, "delivered");
    const binding = database.updateAgentRuntimeBinding(nodeRun.agentProfileId, {
      currentNodeRunId: null,
      status: "idle",
      lastError: null,
    });
    const asset = database.listKnowledgeAssets(nodeRun.projectId)[0] ?? null;
    const knowledge = asset ? proposeFromDelivery(delivery.id, asset.id, actor) : null;
    return {
      kind: "execution_review_approved",
      reviewGate: decidedGate,
      nodeRun: completedRun,
      task: completedTask,
      workstream: deliveredWorkstream,
      binding,
      delivery,
      knowledgeProposal: knowledge?.proposal ?? null,
      knowledgeAsset: knowledge?.asset ?? null,
    };
  }

  function decideKnowledgeProposal(proposalId, decision, actor) {
    const proposal = database.getKnowledgeProposal(proposalId);
    if (!proposal || proposal.status !== "pending") {
      throw new ApiError(409, "KNOWLEDGE_PROPOSAL_UNAVAILABLE", "Knowledge Proposal is missing or already decided");
    }
    return {
      kind: "knowledge_decision",
      ...database.decideKnowledgeProposal({
        proposalId,
        decision,
        versionId: randomUUID(),
        decidedBy: actorKey(actor),
      }),
    };
  }

  return {
    projectState,
    initializeWithLeader,
    bindKnowledge,
    contextualizeDemand,
    completeContextualization,
    duplicateContext,
    attachContext,
    proposeFromNodeRun,
    completeKnowledgeSync,
    completeStandaloneNodeRun,
    requestExecutionReview,
    proposeFromDelivery,
    decideExecutionReview,
    decideKnowledgeProposal,
  };
}
