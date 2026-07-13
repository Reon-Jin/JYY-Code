import { Effect, Layer, Context, Schema, Stream, Scope } from "effect"
import { formatPatch, structuredPatch } from "diff"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { Git } from "@/git"
import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "vcs" })
const MAX_PATCH_BYTES = 10_000_000
const MAX_TOTAL_PATCH_BYTES = 10_000_000
const PATCH_CONTEXT_LINES = MAX_TOTAL_PATCH_BYTES
type DiffOptions = {
  readonly context?: number
}

const emptyPatch = (file: string) => formatPatch(structuredPatch(file, file, "", "", "", "", { context: 0 }))

const nums = (list: Git.Stat[]) =>
  new Map(list.map((item) => [item.file, { additions: item.additions, deletions: item.deletions }] as const))

const merge = (...lists: Git.Item[][]) => {
  const out = new Map<string, Git.Item>()
  lists.flat().forEach((item) => {
    if (!out.has(item.file)) out.set(item.file, item)
  })
  return [...out.values()]
}

const emptyBatch = () => ({ patches: new Map<string, string>(), capped: false })

const parseQuotedPath = (value: string) => {
  let out = ""
  for (let idx = 1; idx < value.length; idx++) {
    const char = value[idx]
    if (char === '"') return { value: out, end: idx + 1 }
    if (char !== "\\") {
      out += char
      continue
    }

    const next = value[++idx]
    if (next === "t") out += "\t"
    else if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === '"' || next === "\\") out += next
    else out += next ?? ""
  }
}

const parsePathToken = (value: string) => {
  if (!value.startsWith('"')) return value.split("\t")[0]
  return parseQuotedPath(value)?.value ?? value
}

const fileFromDiffPath = (value: string | undefined) => {
  if (!value || value === "/dev/null") return
  const file = parsePathToken(value)
  if (file.startsWith("a/") || file.startsWith("b/")) return file.slice(2)
  return file
}

const fileFromGitHeader = (header: string) => {
  if (header.startsWith('"')) {
    const first = parseQuotedPath(header)
    const second = first ? header.slice(first.end).trimStart() : undefined
    if (!second) return
    if (!second.startsWith('"')) return fileFromDiffPath(second)
    return fileFromDiffPath(parseQuotedPath(second)?.value)
  }

  const separator = header.indexOf(" b/")
  if (separator === -1) return
  return fileFromDiffPath(header.slice(separator + 1))
}

const fileFromPatchChunk = (chunk: string) => {
  const next = /^\+\+\+ (.+)$/m.exec(chunk)?.[1]
  const before = /^--- (.+)$/m.exec(chunk)?.[1]
  const file = fileFromDiffPath(next) ?? fileFromDiffPath(before)
  if (file) return file

  const header = /^diff --git (.+)$/m.exec(chunk)?.[1]
  return fileFromGitHeader(header ?? "")
}

const splitGitPatch = (patch: Git.Patch) => {
  const starts = [...patch.text.matchAll(/(?:^|\n)diff --git /g)].map((match) =>
    match[0].startsWith("\n") ? match.index + 1 : match.index,
  )
  const chunks = starts.map((start, index) => patch.text.slice(start, starts[index + 1] ?? patch.text.length))
  if (!patch.truncated) return chunks
  return chunks.slice(0, -1)
}

const batchPatches = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  list: Git.Item[],
  options?: DiffOptions,
) {
  if (list.length === 0) return { patches: new Map<string, string>(), capped: false }

  const result = yield* git.patchAll(cwd, ref, {
    context: options?.context ?? PATCH_CONTEXT_LINES,
    maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
  })
  if (result.truncated) log.warn("batched patch exceeded byte limit", { max: MAX_TOTAL_PATCH_BYTES })

  return {
    patches: splitGitPatch(result).reduce((acc, patch, index) => {
      const file = fileFromPatchChunk(patch) ?? list[index]?.file
      if (!file) return acc
      acc.set(file, (acc.get(file) ?? "") + patch)
      return acc
    }, new Map<string, string>()),
    capped: result.truncated,
  }
})

const nativePatch = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  options?: DiffOptions,
) {
  const result =
    item.code === "??" || !ref
      ? yield* git.patchUntracked(cwd, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
      : yield* git.patch(cwd, ref, item.file, {
          context: options?.context ?? PATCH_CONTEXT_LINES,
          maxOutputBytes: MAX_PATCH_BYTES,
        })
  if (!result.truncated && result.text) return result.text

  if (result.truncated) log.warn("patch exceeded byte limit", { file: item.file, max: MAX_PATCH_BYTES })
  return emptyPatch(item.file)
})

const totalPatch = (file: string, patch: string, total: number) => {
  if (total + Buffer.byteLength(patch) <= MAX_TOTAL_PATCH_BYTES) return { patch, capped: false }
  log.warn("total patch budget exceeded", { file, max: MAX_TOTAL_PATCH_BYTES })
  return { patch: emptyPatch(file), capped: true }
}

const patchForItem = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  item: Git.Item,
  batch: { patches: Map<string, string>; capped: boolean },
  capped: boolean,
  options?: DiffOptions,
) {
  if (capped) return emptyPatch(item.file)

  const batched = batch.patches.get(item.file)
  if (batched !== undefined) return batched
  if (item.code !== "??" && batch.capped) return emptyPatch(item.file)
  return yield* nativePatch(git, cwd, ref, item, options)
})

const files = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  list: Git.Item[],
  map: Map<string, { additions: number; deletions: number }>,
  batch: { patches: Map<string, string>; capped: boolean },
  options?: DiffOptions,
) {
  const next: FileDiff[] = []
  let total = 0
  let capped = false

  for (const item of list.toSorted((a, b) => a.file.localeCompare(b.file))) {
    const stat = map.get(item.file) ?? (item.status === "added" ? yield* git.statUntracked(cwd, item.file) : undefined)
    const patch = yield* patchForItem(git, cwd, ref, item, batch, capped, options)
    const result: { patch: string; capped: boolean } = capped
      ? { patch, capped: true }
      : totalPatch(item.file, patch, total)
    capped = capped || result.capped
    if (!capped) {
      total += Buffer.byteLength(result.patch)
      capped = total >= MAX_TOTAL_PATCH_BYTES
    }
    next.push({
      file: item.file,
      patch: result.patch,
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      status: item.status,
    })
  }

  return next
})

const diffAgainstRef = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string,
  options?: DiffOptions,
) {
  const [list, stats, extra] = yield* Effect.all([git.diff(cwd, ref), git.stats(cwd, ref), git.status(cwd)], {
    concurrency: 3,
  })
  return yield* files(
    git,
    cwd,
    ref,
    merge(
      list,
      extra.filter((item) => item.code === "??"),
    ),
    nums(stats),
    yield* batchPatches(git, cwd, ref, list, options),
    options,
  )
})

const track = Effect.fnUntraced(function* (
  git: Git.Interface,
  cwd: string,
  ref: string | undefined,
  options?: DiffOptions,
) {
  if (!ref) return yield* files(git, cwd, ref, yield* git.status(cwd), new Map(), emptyBatch(), options)
  return yield* diffAgainstRef(git, cwd, ref, options)
})

const parseRemotes = (text: string): Remote[] => {
  const remotes = new Map<string, { fetchUrl?: string; pushUrl?: string }>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.+)\s+\((fetch|push)\)$/.exec(line)
    if (!match) continue
    const [, name, url, kind] = match
    if (!name || !url) continue
    const remote = remotes.get(name) ?? {}
    if (kind === "fetch") remote.fetchUrl = url
    if (kind === "push") remote.pushUrl = url
    remotes.set(name, remote)
  }
  return [...remotes].map(([name, remote]) => ({ name, ...remote })).toSorted((a, b) => a.name.localeCompare(b.name))
}

const remoteName = (ref: string, remotes: Remote[]) =>
  remotes
    .map((remote) => remote.name)
    .toSorted((a, b) => b.length - a.length)
    .find((name) => ref.startsWith(`${name}/`)) ?? ref.split("/")[0]

const parseBranches = (text: string, current: string | undefined, remotes: Remote[]): Branch[] => {
  const branches: Branch[] = []
  for (const line of text.split(/\r?\n/)) {
    const [ref = "", upstream = "", symref = ""] = line.split("\t")
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length)
      branches.push({
        name,
        kind: "local",
        current: name === current,
        ...(upstream ? { upstream } : {}),
      })
      continue
    }
    if (!ref.startsWith("refs/remotes/") || symref) continue
    const name = ref.slice("refs/remotes/".length)
    branches.push({ name, kind: "remote", remote: remoteName(name, remotes), current: false })
  }
  return branches.toSorted((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

const safeCommandMessage = (result: Git.Result, fallback: string) => {
  const text = result.stderr
    .toString("utf8")
    .replace(/:\/\/[^\s/@:]+:[^\s/@]+@/g, "://***@")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
  return (text || fallback).slice(0, 2_000)
}

const isConflict = (message: string) =>
  /local changes|would be overwritten|please commit your changes|untracked working tree files/i.test(message)

export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Event = {
  BranchUpdated: BusEvent.define(
    "vcs.branch.updated",
    Schema.Struct({
      branch: Schema.optional(Schema.String),
    }),
  ),
}

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Branch = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["local", "remote"]),
  current: Schema.Boolean,
  remote: Schema.optional(Schema.String),
  upstream: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsBranch" })
export type Branch = Schema.Schema.Type<typeof Branch>

export const Remote = Schema.Struct({
  name: Schema.String,
  fetchUrl: Schema.optional(Schema.String),
  pushUrl: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsRemote" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Branches = Schema.Struct({
  current: Schema.optional(Schema.String),
  branches: Schema.Array(Branch),
  remotes: Schema.Array(Remote),
}).annotate({ identifier: "VcsBranches" })
export type Branches = Schema.Schema.Type<typeof Branches>

export const CreateBranchInput = Schema.Struct({
  name: Schema.String,
  checkout: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "VcsCreateBranchInput" })
export type CreateBranchInput = Schema.Schema.Type<typeof CreateBranchInput>

export const SwitchBranchInput = Schema.Struct({
  name: Schema.String,
  createLocal: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "VcsSwitchBranchInput" })
export type SwitchBranchInput = Schema.Schema.Type<typeof SwitchBranchInput>

export const PushInput = Schema.Struct({
  remote: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsPushInput" })
export type PushInput = Schema.Schema.Type<typeof PushInput>

export const OperationReason = Schema.Literals([
  "non-git",
  "invalid-name",
  "already-exists",
  "not-found",
  "conflict",
  "missing-remote",
  "ambiguous-remote",
  "command-failed",
])
export type OperationReason = Schema.Schema.Type<typeof OperationReason>

export class OperationError extends Schema.TaggedErrorClass<OperationError>()("VcsOperationError", {
  message: Schema.String,
  reason: OperationReason,
  candidates: Schema.optional(Schema.Array(Schema.String)),
}) {}

export type PushRemoteSelection =
  | { readonly remote: string; readonly setUpstream: boolean }
  | { readonly reason: "missing-remote" }
  | { readonly reason: "ambiguous-remote" | "not-found"; readonly candidates: string[] }

export const selectPushRemote = (input: {
  readonly remotes: readonly Remote[]
  readonly upstream?: string
  readonly requested?: string
}): PushRemoteSelection => {
  const names = input.remotes.map((remote) => remote.name).toSorted((a, b) => a.localeCompare(b))
  const upstream = names.toSorted((a, b) => b.length - a.length).find((name) => input.upstream?.startsWith(`${name}/`))
  if (input.requested) {
    if (!names.includes(input.requested)) return { reason: "not-found", candidates: names }
    return { remote: input.requested, setUpstream: upstream === undefined }
  }
  if (upstream) return { remote: upstream, setUpstream: false }
  if (names.includes("origin")) return { remote: "origin", setUpstream: true }
  if (names.length === 1) return { remote: names[0]!, setUpstream: true }
  if (names.length === 0) return { reason: "missing-remote" }
  return { reason: "ambiguous-remote", candidates: names }
}

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash /instance/vcs/diff.
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly branch: () => Effect.Effect<string | undefined>
  readonly branches: () => Effect.Effect<Branches>
  readonly createBranch: (input: CreateBranchInput) => Effect.Effect<Branches, OperationError>
  readonly switchBranch: (input: SwitchBranchInput) => Effect.Effect<Branches, OperationError>
  readonly fetch: () => Effect.Effect<Branches, OperationError>
  readonly push: (input?: PushInput) => Effect.Effect<Branches, OperationError>
  readonly defaultBranch: () => Effect.Effect<string | undefined>
  readonly status: () => Effect.Effect<FileStatus[]>
  readonly diff: (mode: Mode, options?: DiffOptions) => Effect.Effect<FileDiff[]>
  readonly diffRaw: () => Effect.Effect<string>
  readonly apply: (input: ApplyInput) => Effect.Effect<ApplyResult, PatchApplyError>
}

interface State {
  current: string | undefined
  root: Git.Base | undefined
}

export class Service extends Context.Service<Service, Interface>()("@jyycode/Vcs") {}

export const layer: Layer.Layer<Service, never, Git.Service | Bus.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const bus = yield* Bus.Service
    const scope = yield* Scope.Scope

    const state = yield* InstanceState.make<State>(
      Effect.fn("Vcs.state")(function* (ctx) {
        if (ctx.project.vcs !== "git") {
          return { current: undefined, root: undefined }
        }

        const get = Effect.fnUntraced(function* () {
          return yield* git.branch(ctx.directory)
        })
        const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
          concurrency: 2,
        })
        const value = { current, root }
        log.info("initialized", { branch: value.current, default_branch: value.root?.name })

        yield* (yield* bus.subscribe(FileWatcher.Event.Updated)).pipe(
          Stream.filter((evt) => evt.properties.file.endsWith("HEAD")),
          Stream.runForEach((_evt) =>
            Effect.gen(function* () {
              const next = yield* get()
              if (next !== value.current) {
                log.info("branch changed", { from: value.current, to: next })
                value.current = next
                yield* bus.publish(Event.BranchUpdated, { branch: next })
              }
            }),
          ),
          Effect.forkScoped,
        )

        return value
      }),
    )

    const branchList = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return { branches: [], remotes: [] } satisfies Branches
      const [current, refs, configuredRemotes] = yield* Effect.all(
        [
          git.branch(ctx.directory),
          git.run(
            [
              "for-each-ref",
              "--format=%(refname)%09%(upstream:short)%09%(symref)%09%(HEAD)",
              "refs/heads",
              "refs/remotes",
            ],
            { cwd: ctx.directory },
          ),
          git.run(["remote", "-v"], { cwd: ctx.directory }),
        ],
        { concurrency: 3 },
      )
      const remotes = parseRemotes(configuredRemotes.text())
      return {
        ...(current ? { current } : {}),
        branches: parseBranches(refs.text(), current, remotes),
        remotes,
      }
    })

    const gitContext = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") {
        return yield* new OperationError({ message: "The project is not a Git repository", reason: "non-git" })
      }
      return ctx
    })

    const validateBranchName = Effect.fnUntraced(function* (cwd: string, name: string) {
      const result = yield* git.run(["check-ref-format", "--branch", name], { cwd })
      if (result.exitCode !== 0) {
        return yield* new OperationError({ message: "The branch name is invalid", reason: "invalid-name" })
      }
    })

    const refExists = Effect.fnUntraced(function* (cwd: string, ref: string) {
      return (yield* git.run(["show-ref", "--verify", "--quiet", ref], { cwd })).exitCode === 0
    })

    const publishBranchUpdated = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const current = yield* git.branch(ctx.directory)
      const value = yield* InstanceState.get(state)
      value.current = current
      yield* bus.publish(Event.BranchUpdated, { branch: current })
    })

    return Service.of({
      init: Effect.fn("Vcs.init")(function* () {
        yield* InstanceState.get(state).pipe(Effect.forkIn(scope))
      }),
      branch: Effect.fn("Vcs.branch")(function* () {
        return yield* InstanceState.use(state, (x) => x.current)
      }),
      branches: Effect.fn("Vcs.branches")(branchList),
      createBranch: Effect.fn("Vcs.createBranch")(function* (input: CreateBranchInput) {
        const ctx = yield* gitContext()
        yield* validateBranchName(ctx.directory, input.name)
        if (yield* refExists(ctx.directory, `refs/heads/${input.name}`)) {
          return yield* new OperationError({ message: "The branch already exists", reason: "already-exists" })
        }
        const args = input.checkout ? ["switch", "-c", input.name] : ["branch", input.name]
        const result = yield* git.run(args, { cwd: ctx.directory })
        if (result.exitCode !== 0) {
          return yield* new OperationError({
            message: safeCommandMessage(result, "Git could not create the branch"),
            reason: "command-failed",
          })
        }
        yield* publishBranchUpdated()
        return yield* branchList()
      }),
      switchBranch: Effect.fn("Vcs.switchBranch")(function* (input: SwitchBranchInput) {
        const ctx = yield* gitContext()
        yield* validateBranchName(ctx.directory, input.name)

        let args: string[]
        if (input.createLocal) {
          const branches = yield* branchList()
          const remote = branches.branches.find((branch) => branch.kind === "remote" && branch.name === input.name)
          if (!remote?.remote || !(yield* refExists(ctx.directory, `refs/remotes/${input.name}`))) {
            return yield* new OperationError({ message: "The remote branch was not found", reason: "not-found" })
          }
          const local = input.name.slice(remote.remote.length + 1)
          if (yield* refExists(ctx.directory, `refs/heads/${local}`)) {
            return yield* new OperationError({ message: "The local branch already exists", reason: "already-exists" })
          }
          args = ["switch", "--track", input.name]
        } else {
          if (!(yield* refExists(ctx.directory, `refs/heads/${input.name}`))) {
            return yield* new OperationError({ message: "The branch was not found", reason: "not-found" })
          }
          args = ["switch", input.name]
        }

        const result = yield* git.run(args, { cwd: ctx.directory })
        if (result.exitCode !== 0) {
          const message = safeCommandMessage(result, "Git could not switch branches")
          return yield* new OperationError({
            message,
            reason: isConflict(message) ? "conflict" : "command-failed",
          })
        }
        yield* publishBranchUpdated()
        return yield* branchList()
      }),
      fetch: Effect.fn("Vcs.fetch")(function* () {
        const ctx = yield* gitContext()
        const result = yield* git.run(["fetch", "--all", "--prune"], { cwd: ctx.directory })
        if (result.exitCode !== 0) {
          return yield* new OperationError({
            message: safeCommandMessage(result, "Git could not fetch remotes"),
            reason: "command-failed",
          })
        }
        return yield* branchList()
      }),
      push: Effect.fn("Vcs.push")(function* (input: PushInput = {}) {
        const ctx = yield* gitContext()
        const branches = yield* branchList()
        const current = branches.branches.find((branch) => branch.kind === "local" && branch.current)
        if (!current) {
          return yield* new OperationError({
            message: "Git cannot push while HEAD is detached",
            reason: "command-failed",
          })
        }
        const selection = selectPushRemote({
          remotes: branches.remotes,
          upstream: current.upstream,
          requested: input.remote,
        })
        if ("reason" in selection) {
          if (selection.reason === "missing-remote") {
            return yield* new OperationError({ message: "No Git remote is configured", reason: selection.reason })
          }
          return yield* new OperationError({
            message:
              selection.reason === "ambiguous-remote"
                ? "Choose a remote before pushing"
                : "The selected remote was not found",
            reason: selection.reason,
            candidates: selection.candidates,
          })
        }
        const args = selection.setUpstream
          ? ["push", "--set-upstream", selection.remote, "HEAD"]
          : ["push", selection.remote, "HEAD"]
        const result = yield* git.run(args, { cwd: ctx.directory })
        if (result.exitCode !== 0) {
          return yield* new OperationError({
            message: safeCommandMessage(result, "Git could not push the current branch"),
            reason: "command-failed",
          })
        }
        return yield* branchList()
      }),
      defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
        return yield* InstanceState.use(state, (x) => x.root?.name)
      }),
      status: Effect.fn("Vcs.status")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        const ref = (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined
        const [list, stats] = yield* Effect.all(
          [git.status(ctx.directory), ref ? git.stats(ctx.directory, ref) : Effect.succeed([])],
          { concurrency: 2 },
        )
        const map = nums(stats)
        return yield* Effect.forEach(
          list.toSorted((a, b) => a.file.localeCompare(b.file)),
          (item) =>
            Effect.gen(function* () {
              const stat =
                map.get(item.file) ??
                (item.status === "added" ? yield* git.statUntracked(ctx.worktree, item.file) : undefined)
              return {
                file: item.file,
                additions: stat?.additions ?? 0,
                deletions: stat?.deletions ?? 0,
                status: item.status,
              } satisfies FileStatus
            }),
        )
      }),
      diff: Effect.fn("Vcs.diff")(function* (mode: Mode, options?: DiffOptions) {
        const value = yield* InstanceState.get(state)
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return []
        if (mode === "git") {
          return yield* track(git, ctx.directory, (yield* git.hasHead(ctx.directory)) ? "HEAD" : undefined, options)
        }

        if (!value.root) return []
        if (value.current && value.current === value.root.name) return []
        const ref = yield* git.mergeBase(ctx.directory, value.root.ref)
        if (!ref) return []
        return yield* diffAgainstRef(git, ctx.directory, ref, options)
      }),
      diffRaw: Effect.fn("Vcs.diffRaw")(function* () {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") return ""
        const [hasHead, status] = yield* Effect.all([git.hasHead(ctx.directory), git.status(ctx.directory)], {
          concurrency: 2,
        })
        const tracked = hasHead ? (yield* git.patchAll(ctx.directory, "HEAD")).text : ""
        const untracked = yield* Effect.forEach(
          status.filter((item) => item.code === "??"),
          (item) => git.patchUntracked(ctx.directory, item.file).pipe(Effect.map((patch) => patch.text)),
        )
        return [tracked, ...untracked].filter(Boolean).join("\n")
      }),
      apply: Effect.fn("Vcs.apply")(function* (input: ApplyInput) {
        const ctx = yield* InstanceState.context
        if (ctx.project.vcs !== "git") {
          return yield* new PatchApplyError({
            message: "Patch can't be applied because the project is not git-based",
            reason: "non-git",
          })
        }
        const applied = yield* git.applyPatch(ctx.directory, input.patch)
        if (applied.exitCode !== 0) {
          return yield* new PatchApplyError({
            message: "Patch can't be applied",
            reason: "not-clean",
          })
        }
        return { applied: true }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Git.defaultLayer), Layer.provide(Bus.layer))

export * as Vcs from "./vcs"
