import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { InstallationVersion } from "@jyycode-ai/core/installation/version"
import { InstanceState } from "@/effect/instance-state"
import { SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import * as Blackboard from "@/plan/blackboard"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(Blackboard.defaultLayer)

const rootSessionID = SessionID.make("ses_blackboard_root")
const childSessionID = SessionID.make("ses_blackboard_child")
const domainRootSessionID = SessionID.make("ses_blackboard_domain_root")
const domainChildASessionID = SessionID.make("ses_blackboard_domain_child_a")
const domainChildBSessionID = SessionID.make("ses_blackboard_domain_child_b")
const candidateRootSessionID = SessionID.make("ses_blackboard_candidate_root")
const candidateChildASessionID = SessionID.make("ses_blackboard_candidate_child_a")
const candidateChildBSessionID = SessionID.make("ses_blackboard_candidate_child_b")

const plan = {
  title: "blackboard",
  goal: "test blackboard persistence",
  status: "active" as const,
  revision: 1,
  current_step: "s1",
  steps: [
    {
      id: "s1",
      title: "Step 1",
      goal: "test",
      done_criteria: "test",
      status: "active" as const,
      tasks: [
        {
          id: "s1_t1",
          title: "Task 1",
          goal: "test",
          done_criteria: "test",
          output_path: null,
          status: "pending" as const,
          dispatch: null,
          report: null,
        },
        {
          id: "s1_t2",
          title: "Task 2",
          goal: "test",
          done_criteria: "test",
          output_path: null,
          status: "pending" as const,
          dispatch: null,
          report: null,
        },
      ],
    },
  ],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
}

const domainPlan = {
  ...plan,
  current_step: "s1",
  steps: [
    {
      ...plan.steps[0]!,
      tasks: [
        {
          ...plan.steps[0]!.tasks[0]!,
          status: "running" as const,
          dispatch: {
            run_id: "run__blackboard__s1_t1",
            child_session_id: domainChildASessionID,
            dispatched_at: new Date().toISOString(),
            cancelled_at: null,
          },
        },
        {
          ...plan.steps[0]!.tasks[1]!,
          status: "running" as const,
          dispatch: {
            run_id: "run__blackboard__s1_t2",
            child_session_id: domainChildBSessionID,
            dispatched_at: new Date().toISOString(),
            cancelled_at: null,
          },
        },
        {
          id: "s1_t3",
          title: "Task 3",
          goal: "test",
          done_criteria: "test",
          output_path: null,
          status: "pending" as const,
          dispatch: null,
          report: null,
        },
      ],
    },
    {
      id: "s2",
      title: "Step 2",
      goal: "test",
      done_criteria: "test",
      status: "pending" as const,
      tasks: [
        {
          id: "s2_t1",
          title: "Future task",
          goal: "test",
          done_criteria: "test",
          output_path: null,
          status: "pending" as const,
          dispatch: null,
          report: null,
        },
      ],
    },
  ],
}

const candidatePlan = {
  ...plan,
  steps: [
    {
      ...plan.steps[0]!,
      tasks: [
        {
          ...plan.steps[0]!.tasks[0]!,
          mode: "candidate" as const,
          output_path: ".jyycode/plan/candidates/a/proposal.md",
          status: "running" as const,
          dispatch: {
            run_id: "run__blackboard_candidate_root__s1_t1",
            child_session_id: candidateChildASessionID,
            dispatched_at: new Date().toISOString(),
            cancelled_at: null,
          },
        },
        {
          ...plan.steps[0]!.tasks[1]!,
          mode: "candidate" as const,
          output_path: ".jyycode/plan/candidates/b/proposal.md",
          status: "running" as const,
          dispatch: {
            run_id: "run__blackboard_candidate_root__s1_t2",
            child_session_id: candidateChildBSessionID,
            dispatched_at: new Date().toISOString(),
            cancelled_at: null,
          },
        },
      ],
      candidate_discussion: { phase: "declaring" as const, ready_task_ids: [] },
    },
  ],
}

function insertSession(input: {
  id: SessionID
  projectID: string
  directory: string
  parentID?: SessionID
  title: string
}) {
  const now = Date.now()
  Database.legacyQuery((db) =>
    db
      .insert(SessionTable)
      .values({
        id: input.id,
        project_id: input.projectID as never,
        parent_id: input.parentID,
        slug: input.id,
        directory: input.directory,
        title: input.title,
        version: InstallationVersion,
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
}

function setupSessions(input: {
  directory: string
  projectID: string
  rootSessionID: SessionID
  childSessionIDs: SessionID[]
  plan: object
}) {
  insertSession({ id: input.rootSessionID, projectID: input.projectID, directory: input.directory, title: "Root" })
  for (const [index, childSessionID] of input.childSessionIDs.entries())
    insertSession({
      id: childSessionID,
      projectID: input.projectID,
      directory: input.directory,
      parentID: input.rootSessionID,
      title: `Child ${index + 1}`,
    })
  const planPath = path.join(input.directory, ".jyycode", "plan", input.rootSessionID, "plan.json")
  return Effect.promise(async () => {
    await fs.mkdir(path.dirname(planPath), { recursive: true })
    await fs.writeFile(planPath, JSON.stringify(input.plan))
  })
}

it.instance("persists step messages across service calls", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    yield* setupSessions({
      directory: ctx.directory,
      projectID: ctx.project.id,
      rootSessionID,
      childSessionIDs: [childSessionID],
      plan,
    })
    const board = yield* Blackboard.Service
    const posted = yield* board.postUser({ rootSessionID, message: "发现公共接口风险" })
    const snapshot = yield* board.listUser({ rootSessionID })
    expect(snapshot.messages.map((item) => item.id)).toContain(posted.id)
  }),
)

it.instance("resolves participants, associations, replies, cursors, mentions, and attachments", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    yield* setupSessions({
      directory: ctx.directory,
      projectID: ctx.project.id,
      rootSessionID: domainRootSessionID,
      childSessionIDs: [domainChildASessionID, domainChildBSessionID],
      plan: domainPlan,
    })
    const board = yield* Blackboard.Service
    const workspaceFile = path.join(ctx.directory, "blackboard.txt")
    const workspaceDirectory = path.join(ctx.directory, "blackboard-dir")
    yield* Effect.promise(async () => {
      await fs.writeFile(workspaceFile, "attachment")
      await fs.mkdir(workspaceDirectory)
    })

    const blocker = yield* board.postAgent({
      sessionID: domainChildBSessionID,
      message: "@s1_t1 blocker needs coordination @main @s2_t1",
      kind: "blocker",
      taskIDs: ["s1_t1"],
      attachments: [workspaceFile, workspaceDirectory, "https://example.com/reference"],
    })
    expect(blocker.authorKind).toBe("sub_agent")
    expect(blocker.purpose).toBe("general")
    expect(blocker.authorTaskID).toBe("s1_t2")
    expect(blocker.mentions).toEqual(["s1_t1", "main"])
    expect(blocker.taskIDs).toEqual(expect.arrayContaining(["s1_t1", "s1_t2"]))
    expect(blocker.attachments.map((item) => item.type)).toEqual(["path", "directory", "url"])

    const userMessage = yield* board.postUser({ rootSessionID: domainRootSessionID, message: "Please review" })
    const childA = yield* board.postAgent({ sessionID: domainChildASessionID, message: "I am checking the API" })
    expect(childA.authorTaskID).toBe("s1_t1")

    const snapshot = yield* board.listUser({ rootSessionID: domainRootSessionID, taskID: "s1_t1" })
    expect(snapshot.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "s1_t1", title: "Task 1", status: "running", hasAgent: true }),
        expect.objectContaining({ id: "s1_t2", title: "Task 2", status: "running", hasAgent: true }),
      ]),
    )
    expect(snapshot.tasks[0]).not.toHaveProperty("goal")
    expect(snapshot.messages.map((item) => item.id)).toContain(blocker.id)
    expect(snapshot.messages.map((item) => item.id)).not.toContain(userMessage.id)

    const childARead = yield* board.readAgent(domainChildASessionID)
    expect(childARead.messages.map((item) => item.id)).toEqual(expect.arrayContaining([blocker.id, userMessage.id]))
    expect(childARead.messages.map((item) => item.id)).not.toContain(childA.id)
    const childBRead = yield* board.readAgent(domainChildBSessionID)
    expect(childBRead.messages.map((item) => item.id)).toContain(userMessage.id)
    expect(childBRead.messages.map((item) => item.id)).not.toContain(blocker.id)
    expect((yield* board.unreadForAgent(domainChildBSessionID)).count).toBe(0)

    const reply = yield* board.postAgent({
      sessionID: domainChildASessionID,
      message: "Reply with the same Task context",
      replyTo: blocker.id,
    })
    expect(reply.parentMessageID).toBe(blocker.id)
    expect(reply.taskIDs).toEqual(expect.arrayContaining(["s1_t1", "s1_t2"]))
    const nested = yield* Effect.exit(
      board.postUser({ rootSessionID: domainRootSessionID, message: "nested", replyTo: reply.id }),
    )
    expect(Exit.isFailure(nested)).toBe(true)

    const invalidTask = yield* Effect.exit(
      board.postUser({ rootSessionID: domainRootSessionID, message: "bad", taskIDs: ["s2_t1"] }),
    )
    expect(Exit.isFailure(invalidTask)).toBe(true)
    const invalidAgentAttachment = yield* Effect.exit(
      board.postAgent({ sessionID: domainChildASessionID, message: "bad file", attachments: ["file:///outside.txt"] }),
    )
    expect(Exit.isFailure(invalidAgentAttachment)).toBe(true)
    const userFile = yield* board.postUser({
      rootSessionID: domainRootSessionID,
      message: "local reference",
      attachments: ["file:///outside.txt"],
    })
    expect(userFile.attachments[0]?.value).toBe("file:///outside.txt")

    for (let index = 0; index < 51; index++)
      yield* board.postUser({ rootSessionID: domainRootSessionID, message: `page-${index}` })
    const firstPage = yield* board.readAgent(domainChildASessionID)
    expect(firstPage.messages).toHaveLength(50)
    expect(firstPage.remaining).toBeGreaterThan(0)
    const secondPage = yield* board.readAgent(domainChildASessionID)
    expect(secondPage.messages.length).toBeGreaterThan(0)
    expect(secondPage.messages.map((item) => item.id)).not.toEqual(expect.arrayContaining(firstPage.messages.map((item) => item.id)))

    const nextPlan = structuredClone(domainPlan) as any
    nextPlan.current_step = "s2"
    nextPlan.steps[0]!.status = "done"
    nextPlan.steps[1]!.status = "active"
    const nextPlanPath = path.join(ctx.directory, ".jyycode", "plan", domainRootSessionID, "plan.json")
    yield* Effect.promise(() => fs.writeFile(nextPlanPath, JSON.stringify(nextPlan)))
    const nextMessage = yield* board.postUser({ rootSessionID: domainRootSessionID, message: "new step" })
    expect(nextMessage.stepID).toBe("s2")
    const historical = yield* board.listUser({ rootSessionID: domainRootSessionID, stepID: "s1" })
    expect(historical.readonly).toBe(true)
    const oldStepAgent = yield* Effect.exit(
      board.postAgent({ sessionID: domainChildASessionID, message: "old step" }),
    )
    expect(Exit.isFailure(oldStepAgent)).toBe(true)
  }),
)

it.instance("stores candidate declarations as top-level messages and validates peer coverage", () =>
  Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    yield* setupSessions({
      directory: ctx.directory,
      projectID: ctx.project.id,
      rootSessionID: candidateRootSessionID,
      childSessionIDs: [candidateChildASessionID, candidateChildBSessionID],
      plan: candidatePlan,
    })
    const board = yield* Blackboard.Service
    const declarationA = yield* board.postCandidateDeclaration({
      sessionID: candidateChildASessionID,
      approach: "A",
      assumptions: ["a"],
      risks: ["risk-a"],
      differentiator: "fast",
    })
    const declarationB = yield* board.postCandidateDeclaration({
      sessionID: candidateChildBSessionID,
      approach: "B",
      assumptions: ["b"],
      risks: ["risk-b"],
      differentiator: "safe",
    })
    expect(declarationA.parentMessageID).toBeUndefined()
    expect(declarationA.purpose).toBe("candidate_declaration")
    expect((yield* board.candidateDeclarations({ rootSessionID: candidateRootSessionID, stepID: "s1" })).map((item) => item.authorTaskID)).toEqual([
      "s1_t1",
      "s1_t2",
    ])
    expect(Exit.isFailure(yield* Effect.exit(board.readAgent(candidateChildBSessionID)))).toBe(true)
    const crossReviewPlan = structuredClone(candidatePlan) as any
    crossReviewPlan.steps[0]!.candidate_discussion.phase = "cross_review"
    const candidatePlanPath = path.join(ctx.directory, ".jyycode", "plan", candidateRootSessionID, "plan.json")
    yield* Effect.promise(() => fs.writeFile(candidatePlanPath, JSON.stringify(crossReviewPlan)))
    const userMessage = yield* board.postUser({ rootSessionID: candidateRootSessionID, message: "Please compare the risks" })
    expect(userMessage.purpose).toBe("general")
    expect((yield* board.readAgent(candidateChildASessionID)).messages.map((item) => item.id)).toContain(userMessage.id)

    const beforeReply = yield* board.candidatePeerReplyCoverage({
      rootSessionID: candidateRootSessionID,
      stepID: "s1",
      taskID: "s1_t1",
    })
    expect(beforeReply).toMatchObject({ missingTaskIDs: ["s1_t2"], complete: false })
    yield* board.postAgent({ sessionID: candidateChildASessionID, message: "review B", replyTo: declarationB.id })
    const afterReply = yield* board.candidatePeerReplyCoverage({
      rootSessionID: candidateRootSessionID,
      stepID: "s1",
      taskID: "s1_t1",
    })
    expect(afterReply).toMatchObject({ repliedTaskIDs: ["s1_t2"], missingTaskIDs: [], complete: true })

    const runningPlan = structuredClone(candidatePlan) as any
    runningPlan.steps[0]!.candidate_discussion.phase = "running"
    const runningPlanPath = path.join(ctx.directory, ".jyycode", "plan", candidateRootSessionID, "plan.json")
    yield* Effect.promise(() => fs.writeFile(runningPlanPath, JSON.stringify(runningPlan)))
    expect(Exit.isFailure(yield* Effect.exit(board.postAgent({ sessionID: candidateChildASessionID, message: "second round" })))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(board.readAgent(candidateChildASessionID)))).toBe(true)
  }),
)
