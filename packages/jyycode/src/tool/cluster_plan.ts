import * as Tool from "./tool"
import DESCRIPTION from "./cluster_plan.txt"
import { AgentCluster } from "@/agent-cluster/cluster"
import { AgentClusterRuntime } from "@/agent-cluster/runtime"
import { AgentClusterLifecycle } from "@/agent-cluster/lifecycle"
import { AgentClusterTaskTable } from "@/agent-cluster/cluster.sql"
import type { Plan, RunID, TaskID } from "@/agent-cluster/schema"
import { ConfigAgentCluster } from "@/config/agent-cluster"
import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { Event } from "@/agent-cluster/event"
import * as Database from "@/storage/db"
import { Effect, Schema } from "effect"
import { ulid } from "ulid"

const id = "cluster_plan"

const PlanTaskSchema = Schema.Struct({
  id: Schema.String,
  step: Schema.Number,
  title: Schema.String,
  role: Schema.String,
  complexity: Schema.Literals(["simple", "complex"]),
  model: Schema.String,
  dependencies: Schema.Array(Schema.String),
  prompt: Schema.String,
  acceptanceCriteria: Schema.Array(Schema.String),
  expectedArtifacts: Schema.Array(Schema.String),
})

const Parameters = Schema.Struct({
  goal: Schema.String.annotate({ description: "The goal of this cluster run" }),
  tasks: Schema.Array(PlanTaskSchema).annotate({ description: "The task plan" }),
})

export const ClusterPlanTool = Tool.define(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bus = yield* Bus.Service

    const execute = Effect.fn("ClusterPlanTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const runID = ctx.extra?.agentClusterRunID
      if (!runID || typeof runID !== "string") {
        return yield* Effect.fail(new Error("cluster_plan requires an active agent cluster run"))
      }

      const cfg = yield* config.get()
      const clusterConfig = ConfigAgentCluster.resolve(cfg.agent_cluster)

      // Validate the plan
      const plan: Plan = {
        goal: params.goal,
        tasks: params.tasks.map((task) => ({
          id: AgentClusterRuntime.coerceTaskID(task.id),
          step: task.step,
          title: task.title,
          role: task.role as Plan["tasks"][0]["role"],
          complexity: task.complexity,
          model: task.model,
          dependencies: task.dependencies.map(AgentClusterRuntime.coerceTaskID),
          prompt: task.prompt,
          acceptanceCriteria: task.acceptanceCriteria,
          expectedArtifacts: task.expectedArtifacts,
        })),
      }

      const validation = AgentClusterRuntime.validatePlan(plan, {
        maxSubagents: clusterConfig.max_subagents,
        maxConcurrency: clusterConfig.max_concurrency,
      })

      if (!validation.valid) {
        return yield* Effect.fail(
          new Error(`Plan validation failed:\n${validation.errors.map((e) => `- ${e}`).join("\n")}`),
        )
      }

      // Check for existing tasks in this run — reject re-plan if tasks exist
      const existingTasks = yield* Database.query((db) =>
        db
          .select({ id: AgentClusterTaskTable.id })
          .from(AgentClusterTaskTable)
          .where(Database.eq(AgentClusterTaskTable.run_id, runID as RunID))
          .all(),
      )

      if (existingTasks.length > 0) {
        // Check if any task has progressed beyond planned
        const nonPlanned = yield* Database.query((db) =>
          db
            .select({ id: AgentClusterTaskTable.id })
            .from(AgentClusterTaskTable)
            .where(
              Database.and(
                Database.eq(AgentClusterTaskTable.run_id, runID as RunID),
                Database.ne(AgentClusterTaskTable.status, "planned"),
              ),
            )
            .all(),
        )

        if (nonPlanned.length > 0) {
          return yield* Effect.fail(
            new Error(
              `Cannot re-plan run ${runID}: ${nonPlanned.length} task(s) have already started. ` +
                `Tasks can only be re-planned while all are in 'planned' status.`,
            ),
          )
        }

        // Delete existing planned tasks before re-planning
        yield* Database.query((db) =>
          db
            .delete(AgentClusterTaskTable)
            .where(Database.eq(AgentClusterTaskTable.run_id, runID as RunID))
            .run(),
        )
      }

      // Persist the plan
      yield* AgentCluster.persistPlan({ runID: runID as RunID, plan })

      // Transition dependency-free tasks to queued
      const ready = AgentClusterRuntime.nextReadyBatch(plan, { completed: [], dispatched: [], failed: [] })
      const now = Date.now()

      for (const task of ready.tasks) {
        yield* Database.query((db) =>
          db
            .update(AgentClusterTaskTable)
            .set({ status: "queued", status_version: 1, time_updated: now })
            .where(
              Database.and(
                Database.eq(AgentClusterTaskTable.run_id, runID as RunID),
                Database.eq(AgentClusterTaskTable.plan_task_id, task.id),
              ),
            )
            .run(),
        )
      }

      // Publish events
      const createdAt = Date.now()
      yield* bus.publish(Event, {
        sessionID: ctx.sessionID,
        runID: runID as RunID,
        type: "run",
        status: "dispatching",
        message: `Plan accepted: ${plan.tasks.length} tasks, ${ready.tasks.length} ready`,
        version: 1,
        createdAt,
      })

      return {
        title: "Cluster plan",
        metadata: {
          plan_status: "accepted",
          run_id: runID,
          tasks: plan.tasks.length,
          ready: ready.tasks.map((t) => t.id),
        },
        output: [
          `plan_status: accepted`,
          `run_id: ${runID}`,
          `tasks: ${plan.tasks.length}`,
          `ready: ${ready.tasks.map((t) => t.id).join(", ")}`,
        ].join("\n"),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      catalog: {
        category: "subagent",
        mutability: "external",
        risk: "medium",
        detail: "core",
      },
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        execute(params, ctx).pipe(Effect.orDie),
    }
  }),
)
