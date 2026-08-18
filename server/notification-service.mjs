import { randomUUID } from "node:crypto";

import { ApiError } from "./database.mjs";

const DEFAULT_ACTIONS = {
  "review.requested": ["open", "approve", "reject", "ask", "reassign", "postpone"],
  "review.approved": ["open"],
  "review.rejected": ["open"],
  "task.completed": ["open"],
  "agent.blocked": ["open", "ask", "reassign"],
  "workstream.scope_changed": ["open"],
  "delivery.created": ["open"],
  "knowledge.updated": ["open"],
  "knowledge.binding_stale": ["open"],
  "decision.required": ["open", "approve", "reject", "ask", "reassign", "postpone"],
};

function recipientKey(recipient) {
  return `${recipient.type}:${recipient.id}`;
}

export function createNotificationService(database) {
  function publish(eventType, input) {
    const event = database.createDomainEvent({
      id: randomUUID(),
      projectId: input.projectId,
      eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      actor: `${input.actor.type}:${input.actor.id}`,
      payload: input.context ?? {},
    });
    const recipients = [
      ...(input.reviewerAgentId ? [{ type: "agent", id: input.reviewerAgentId }] : []),
      ...(input.actor.type === "user" ? [{ type: "user", id: input.actor.id }] : [{ type: "user", id: "local-user" }]),
    ];
    const uniqueRecipients = [...new Map(recipients.map((recipient) => [recipientKey(recipient), recipient])).values()];
    return database.createNotification({
      id: randomUUID(),
      projectId: input.projectId,
      eventId: event.id,
      eventType,
      actor: input.actor,
      title: input.title,
      body: input.body,
      reason: input.reason,
      graphNodeId: input.graphNodeId,
      dueAt: input.dueAt ?? null,
      impact: input.impact,
      actions: input.actions ?? DEFAULT_ACTIONS[eventType] ?? ["open"],
      context: input.context ?? {},
      dedupeKey: input.dedupeKey ?? event.id,
      recipients: uniqueRecipients,
    });
  }

  function list(projectId) {
    return database.listNotifications(projectId);
  }

  function get(id) {
    return database.getNotification(id);
  }

  function updateRecipient(id, actor, changes) {
    return database.updateNotificationRecipient(id, { type: actor.type, id: actor.id }, changes);
  }

  function actionCommand(notificationId, action, input = {}) {
    const notification = get(notificationId);
    if (!notification) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification no longer exists");
    if (!notification.actions.includes(action)) {
      throw new ApiError(409, "NOTIFICATION_ACTION_UNAVAILABLE", "This notification does not offer that action");
    }
    const context = notification.context;
    const idempotencyKey = input.idempotencyKey ?? `notification:${notification.id}:${action}:${randomUUID()}`;
    if (action === "approve" || action === "reject") {
      if (context.executionReview && context.reviewGateNodeId && context.workstreamNodeId) {
        return {
          projectId: notification.projectId,
          sourceNodeId: context.reviewGateNodeId,
          targetNodeId: context.reviewGateNodeId,
          actionType: "decide_execution_review",
          idempotencyKey,
          input: { decision: action === "approve" ? "approved" : "rejected", comment: input.comment ?? "" },
        };
      }
      if (context.knowledgeProposalNodeId && context.knowledgeNodeId) {
        return {
          projectId: notification.projectId,
          sourceNodeId: context.knowledgeProposalNodeId,
          targetNodeId: context.knowledgeNodeId,
          actionType: "decide_knowledge_proposal",
          idempotencyKey,
          input: { decision: action === "approve" ? "approved" : "rejected" },
        };
      }
      if (context.reviewGateNodeId && context.workstreamNodeId) {
        return {
          projectId: notification.projectId,
          sourceNodeId: context.reviewGateNodeId,
          targetNodeId: context.reviewGateNodeId,
          actionType: "decide_review",
          idempotencyKey,
          input: { decision: action === "approve" ? "approved" : "rejected", comment: input.comment ?? "" },
        };
      }
      if (context.taskNodeId) {
        return {
          projectId: notification.projectId,
          sourceNodeId: context.taskNodeId,
          targetNodeId: context.taskNodeId,
          actionType: "decide_task_review",
          idempotencyKey,
          input: { decision: action === "approve" ? "approved" : "rejected", comment: input.comment ?? "" },
        };
      }
    }
    if (action === "reassign" && context.executionReview && context.reviewGateNodeId) {
      const reviewerAgentId = String(input.reviewerAgentId ?? "").trim();
      if (!reviewerAgentId) throw new ApiError(400, "INVALID_FIELD", "Reviewer Agent id is required");
      return {
        projectId: notification.projectId,
        sourceNodeId: context.reviewGateNodeId,
        targetNodeId: `agent_profile:${reviewerAgentId}`,
        actionType: "assign_artifact_review",
        idempotencyKey,
        input: {},
      };
    }
    if (action === "ask" && context.taskNodeId) {
      return {
        projectId: notification.projectId,
        sourceNodeId: context.taskNodeId,
        targetNodeId: context.taskNodeId,
        actionType: "comment_on_task",
        idempotencyKey,
        input: { comment: input.comment ?? "Please clarify the review evidence." },
      };
    }
    if (action === "reassign" && context.taskNodeId) {
      return {
        projectId: notification.projectId,
        sourceNodeId: context.taskNodeId,
        targetNodeId: context.taskNodeId,
        actionType: "reassign_task_review",
        idempotencyKey,
        input: { reviewerAgentId: input.reviewerAgentId },
      };
    }
    if (action === "postpone" && context.taskNodeId) {
      return {
        projectId: notification.projectId,
        sourceNodeId: context.taskNodeId,
        targetNodeId: context.taskNodeId,
        actionType: "postpone_task_review",
        idempotencyKey,
        input: { dueAt: input.dueAt, comment: input.comment ?? "" },
      };
    }
    if (action === "reassign" && context.workstreamNodeId) {
      const reviewerAgentId = String(input.reviewerAgentId ?? "").trim();
      if (!reviewerAgentId) throw new ApiError(400, "INVALID_FIELD", "Reviewer Agent id is required");
      return {
        projectId: notification.projectId,
        sourceNodeId: `agent_profile:${reviewerAgentId}`,
        targetNodeId: context.workstreamNodeId,
        actionType: "assign_reviewer",
        idempotencyKey,
        input: {},
      };
    }
    if ((action === "ask" || action === "postpone") && context.reviewGateNodeId && context.workstreamNodeId) {
      return {
        projectId: notification.projectId,
        sourceNodeId: context.reviewGateNodeId,
        targetNodeId: context.workstreamNodeId,
        actionType: "create_relation",
        idempotencyKey,
        input: {
          relationType: action === "ask" ? "question" : "postponed",
          label: action === "ask" ? input.comment ?? "Review question" : input.dueAt ?? "Postponed",
        },
      };
    }
    throw new ApiError(409, "NOTIFICATION_ACTION_UNAVAILABLE", "Notification action is missing its graph context");
  }

  return { publish, list, get, updateRecipient, actionCommand };
}
