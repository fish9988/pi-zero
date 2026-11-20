/**
 * Pi 原生会话与侧栏项目/任务目录统一适配器（project 模块 adapters 层）。
 *
 * 职责：
 * - 以 Pi `<agentDir>/sessions/<encoded-cwd>/*.jsonl` 与内存活跃 Pi 会话为权威事实源；
 * - 自动将发现的 Pi 会话 `cwd` 聚合为侧栏项目（按跨平台归一化路径去重，合并用户已有/置顶/新建项目，尊重软删项目）；
 * - 将 Pi 会话镜像写入 `tasks` 表以完整保留置顶/归档/未读/重命名/分组等产品壳能力；
 * - 过滤仅属于旧版 ZCode 的历史死任务及纯旧版 ZCode 遗留项目，避免侧栏残留与 Pi 脱节的脏数据；
 * - 监听 `~/.pi/agent/sessions` 变更，实现终端 `pi` 与 Pi Zero 侧栏实时互通。
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateTraceId, ZCODE_AGENT_PROVIDER, type ZCodeTaskMeta } from "@zcode/shared";
import type {
  IProjectService,
  ProjectTask,
  ProjectTree,
  VirtualProject,
} from "#src/project/contract.js";
import type { ProjectRepositoryContract } from "#src/project-storage/contract.js";

export interface PiDiscoveredSessionItem {
  readonly sessionId: string;
  readonly cwd: string;
  readonly normalizedCwd: string;
  readonly file?: string | undefined;
  readonly title: string;
  readonly titleSource: "custom" | "default";
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly lastOutcome?: "completed" | "interrupted" | "error" | undefined;
  readonly parentSessionId?: string | undefined;
  readonly live: boolean;
}

export interface PiSessionDiscoverySource {
  listAllSessions(): Promise<readonly PiDiscoveredSessionItem[]>;
  watchSessions(onChange: () => void): () => void;
  normalizePathKey(rawPath: string): string;
}

export interface PiTaskFactMirrorStore {
  applyCliFacts(params: {
    meta: ZCodeTaskMeta;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<ZCodeTaskMeta>;
}

export interface CreatePiUnifiedProjectServiceOptions {
  readonly base: IProjectService;
  readonly repository: () => Promise<ProjectRepositoryContract>;
  readonly taskStore: PiTaskFactMirrorStore;
  readonly piDiscovery: PiSessionDiscoverySource;
  readonly workspaceDirectory: string;
  readonly onDidSync?: (() => void | Promise<void>) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly tempDir?: string | undefined;
  readonly pathExists?: ((targetPath: string) => boolean) | undefined;
}

export interface PiUnifiedProjectServiceHandle {
  readonly service: IProjectService;
  syncNow(): Promise<void>;
  dispose(): void;
}

interface CwdSessionGroup {
  readonly normalizedCwd: string;
  readonly canonicalCwd: string;
  readonly latestActivityAt: number;
  readonly isInternalDraftDir: boolean;
  readonly sessions: PiDiscoveredSessionItem[];
}

interface ActiveProjectMatch {
  readonly project: VirtualProject;
  readonly matchedRootPath: string;
  readonly isPrimary: boolean;
}

interface PiSyncResult {
  readonly activePiSessionIds: ReadonlySet<string>;
  readonly activePiRootKeys: ReadonlySet<string>;
  readonly fallbackProjectIdBySessionId: ReadonlyMap<string, string>;
  readonly changed: boolean;
}

function resolveCanonicalCwd(rawPath: string, platform: NodeJS.Platform): string {
  const pathMod = platform === "win32" ? path.win32 : path.posix;
  const resolved = pathMod.resolve(rawPath.trim());
  const parsedRoot = pathMod.parse(resolved).root;
  if (resolved === parsedRoot) return resolved;
  return resolved.replace(/[\\/]+$/, (match) => (match.length === resolved.length ? match : ""));
}

function isPathInsideDir(childKey: string, parentKey: string, sep: string): boolean {
  if (!childKey || !parentKey) return false;
  if (childKey === parentKey) return true;
  const prefix = parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`;
  return childKey.startsWith(prefix);
}

function expectedTaskStatus(
  lastOutcome: PiDiscoveredSessionItem["lastOutcome"],
): "completed" | "error" | undefined {
  if (lastOutcome === "error") return "error";
  if (lastOutcome) return "completed";
  return undefined;
}

function needsTaskFactWrite(
  existing: ProjectTask | undefined,
  session: PiDiscoveredSessionItem,
): boolean {
  if (!existing) return true;
  const nextStatus = expectedTaskStatus(session.lastOutcome);
  if (existing.createdAt !== session.createdAt) return true;
  if (session.lastActivityAt > existing.updatedAt) return true;
  if (nextStatus !== undefined && existing.status !== nextStatus) return true;
  if (session.titleSource === "custom" && existing.title !== session.title) return true;
  if (!existing.titleOverridden && existing.title !== session.title) return true;
  return false;
}

function buildDiscoveryFingerprint(sessions: readonly PiDiscoveredSessionItem[]): string {
  return [...sessions]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map(
      (item) =>
        `${item.sessionId}\0${item.normalizedCwd}\0${item.title}\0${item.titleSource}\0${item.lastActivityAt}\0${item.lastOutcome ?? ""}`,
    )
    .join("\n");
}

function buildActiveProjectMatches(
  projects: readonly VirtualProject[],
  normalizePathKey: (rawPath: string) => string,
): {
  activeProjectsByRootKey: Map<string, ActiveProjectMatch>;
  activeProjectIds: Set<string>;
  deletedProjectRootKeys: Set<string>;
} {
  const activeProjectsByRootKey = new Map<string, ActiveProjectMatch>();
  const activeProjectIds = new Set<string>();
  const deletedProjectRootKeys = new Set<string>();

  const ordered = [...projects].sort((a, b) => a.position - b.position);
  for (const project of ordered) {
    if (project.deleted) {
      for (const root of project.roots) {
        const key = normalizePathKey(root.rootPath);
        if (key) deletedProjectRootKeys.add(key);
      }
      continue;
    }
    activeProjectIds.add(project.id);
    for (const root of project.roots) {
      const key = normalizePathKey(root.rootPath);
      if (!key) continue;
      const existing = activeProjectsByRootKey.get(key);
      if (!existing || (!existing.isPrimary && root.isPrimary)) {
        activeProjectsByRootKey.set(key, {
          project,
          matchedRootPath: root.rootPath,
          isPrimary: root.isPrimary,
        });
      }
    }
  }

  return { activeProjectsByRootKey, activeProjectIds, deletedProjectRootKeys };
}

export function createPiUnifiedProjectService(
  options: CreatePiUnifiedProjectServiceOptions,
): PiUnifiedProjectServiceHandle {
  const platform = options.platform ?? process.platform;
  const pathSep = platform === "win32" ? "\\" : "/";
  const pathExists = options.pathExists ?? existsSync;
  const normalizedTempDir = options.piDiscovery.normalizePathKey(options.tempDir ?? tmpdir());
  const normalizedInternalWorkspaceDir = options.piDiscovery.normalizePathKey(
    options.workspaceDirectory,
  );
  const userSavedProjectIds = new Set<string>();

  let disposed = false;
  let lastFingerprint = "";
  let inFlightSync: Promise<PiSyncResult> | null = null;
  let resyncRequested = false;

  const isLocalHost = (hostId?: string): boolean => !hostId || hostId === "local";

  const runSyncPass = async (): Promise<PiSyncResult> => {
    const rawSessions = await options.piDiscovery.listAllSessions();
    const groups = new Map<string, CwdSessionGroup>();
    const validSessions: PiDiscoveredSessionItem[] = [];

    for (const session of rawSessions) {
      if (!session.normalizedCwd) continue;
      if (
        !session.live &&
        isPathInsideDir(session.normalizedCwd, normalizedTempDir, pathSep) &&
        !pathExists(session.cwd)
      ) {
        continue;
      }
      validSessions.push(session);
      const existingGroup = groups.get(session.normalizedCwd);
      if (!existingGroup) {
        groups.set(session.normalizedCwd, {
          normalizedCwd: session.normalizedCwd,
          canonicalCwd: resolveCanonicalCwd(session.cwd, platform),
          latestActivityAt: session.lastActivityAt,
          isInternalDraftDir: isPathInsideDir(
            session.normalizedCwd,
            normalizedInternalWorkspaceDir,
            pathSep,
          ),
          sessions: [session],
        });
      } else {
        existingGroup.sessions.push(session);
        if (session.lastActivityAt > existingGroup.latestActivityAt) {
          groups.set(session.normalizedCwd, {
            ...existingGroup,
            canonicalCwd: resolveCanonicalCwd(session.cwd, platform),
            latestActivityAt: session.lastActivityAt,
          });
        }
      }
    }

    const repo = await options.repository();
    const snapshot = repo.readTree({
      includeDeleted: true,
      includeDeletedTasks: true,
      includeTasks: true,
    });
    const { activeProjectsByRootKey, activeProjectIds, deletedProjectRootKeys } =
      buildActiveProjectMatches(snapshot.projects, options.piDiscovery.normalizePathKey);
    const existingTaskById = new Map<string, ProjectTask>(
      snapshot.tasks.map((task) => [task.taskId, task]),
    );
    const deletedTaskIds = new Set<string>(
      (snapshot.deletedTasks ?? []).map((task) => task.taskId),
    );

    let mutated = false;
    const newProjectGroups = [...groups.values()]
      .filter(
        (group) =>
          !group.isInternalDraftDir &&
          !activeProjectsByRootKey.has(group.normalizedCwd) &&
          !deletedProjectRootKeys.has(group.normalizedCwd) &&
          group.sessions.some((session) => !deletedTaskIds.has(session.sessionId)),
      )
      // repo.saveProject 按 min(position)-1 置顶插入，因此先建旧项目再建新项目，
      // 最终让最近活跃的 Pi 项目排在侧栏顶部。
      .sort((a, b) => a.latestActivityAt - b.latestActivityAt);

    for (const group of newProjectGroups) {
      const created = repo.saveProject({ roots: [group.canonicalCwd] });
      const primaryRoot = created.roots[0]?.rootPath ?? group.canonicalCwd;
      activeProjectsByRootKey.set(group.normalizedCwd, {
        project: created,
        matchedRootPath: primaryRoot,
        isPrimary: true,
      });
      activeProjectIds.add(created.id);
      mutated = true;
    }

    const activePiSessionIds = new Set<string>();
    const activePiRootKeys = new Set<string>();
    const fallbackProjectIdBySessionId = new Map<string, string>();

    for (const group of groups.values()) {
      const matched = activeProjectsByRootKey.get(group.normalizedCwd);
      const isDeletedProjectOnly = !matched && deletedProjectRootKeys.has(group.normalizedCwd);
      for (const session of group.sessions) {
        if (deletedTaskIds.has(session.sessionId)) continue;
        if (isDeletedProjectOnly) continue;

        activePiSessionIds.add(session.sessionId);
        activePiRootKeys.add(group.normalizedCwd);
        if (matched) {
          fallbackProjectIdBySessionId.set(session.sessionId, matched.project.id);
        }

        const existing = existingTaskById.get(session.sessionId);
        const workspacePath = existing
          ? existing.workspacePath
          : (matched?.matchedRootPath ?? group.canonicalCwd);

        if (needsTaskFactWrite(existing, session)) {
          const status = expectedTaskStatus(session.lastOutcome);
          await options.taskStore.applyCliFacts({
            meta: {
              taskId: session.sessionId,
              traceId: generateTraceId(session.sessionId),
              title: session.title,
              workspacePath,
              createdAt: session.createdAt,
              updatedAt: session.lastActivityAt,
              mode: "default",
              provider: ZCODE_AGENT_PROVIDER,
              ...(session.parentSessionId ? { forkedFromTaskId: session.parentSessionId } : {}),
              ...(status ? { status } : {}),
            },
            titleSource: session.titleSource,
            lastOutcome: session.lastOutcome,
          });
          mutated = true;
        }

        if (
          matched &&
          (!existing || existing.projectId === null || !activeProjectIds.has(existing.projectId)) &&
          matched.project.roots.some((root) => root.rootPath === workspacePath)
        ) {
          try {
            repo.moveTask({
              task: { workspacePath, taskId: session.sessionId },
              projectId: matched.project.id,
            });
            mutated = true;
          } catch {
            // 并发删除或非匹配 root 时忽略，由投影兜底保持归属一致。
          }
        }
      }
    }

    const fingerprint = buildDiscoveryFingerprint(validSessions);
    const changed = mutated || fingerprint !== lastFingerprint;
    lastFingerprint = fingerprint;

    return {
      activePiSessionIds,
      activePiRootKeys,
      fallbackProjectIdBySessionId,
      changed,
    };
  };

  const syncFromPiSessions = async (): Promise<PiSyncResult> => {
    if (inFlightSync) {
      resyncRequested = true;
      return inFlightSync;
    }
    const flight = (async () => {
      let latest: PiSyncResult;
      let anyChanged = false;
      do {
        resyncRequested = false;
        latest = await runSyncPass();
        if (latest.changed) anyChanged = true;
      } while (resyncRequested && !disposed);
      return { ...latest, changed: anyChanged };
    })().finally(() => {
      if (inFlightSync === flight) inFlightSync = null;
    });
    inFlightSync = flight;
    return flight;
  };

  const projectUnifiedLocalTree = (rawTree: ProjectTree, sync: PiSyncResult): ProjectTree => {
    const activeProjectIds = new Set(
      rawTree.projects.filter((project) => !project.deleted).map((project) => project.id),
    );
    const legacyTaskProjectIds = new Set<string>();
    const piTaskProjectIds = new Set<string>();
    const piTasks: ProjectTask[] = [];

    for (const task of rawTree.tasks) {
      if (!sync.activePiSessionIds.has(task.taskId)) {
        if (task.projectId) legacyTaskProjectIds.add(task.projectId);
        continue;
      }
      const fallbackProjectId =
        task.projectId === null || !activeProjectIds.has(task.projectId)
          ? sync.fallbackProjectIdBySessionId.get(task.taskId)
          : undefined;
      const effectiveTask =
        fallbackProjectId && activeProjectIds.has(fallbackProjectId)
          ? { ...task, projectId: fallbackProjectId }
          : task;
      if (effectiveTask.projectId) piTaskProjectIds.add(effectiveTask.projectId);
      piTasks.push(effectiveTask);
    }

    const filteredProjects = rawTree.projects.filter((project) => {
      if (project.deleted || project.pinned || userSavedProjectIds.has(project.id)) return true;
      if (piTaskProjectIds.has(project.id)) return true;
      if (
        project.roots.some((root) =>
          sync.activePiRootKeys.has(options.piDiscovery.normalizePathKey(root.rootPath)),
        )
      ) {
        return true;
      }
      // 保留用户手工添加的空文件夹；隐藏仅承载旧版 ZCode 死任务的遗留项目。
      return !legacyTaskProjectIds.has(project.id);
    });

    return {
      ...rawTree,
      projects: filteredProjects,
      tasks: piTasks,
    };
  };

  const stopWatch = options.piDiscovery.watchSessions(() => {
    if (disposed) return;
    void syncFromPiSessions()
      .then((result) => {
        if (!disposed && result.changed) {
          void options.onDidSync?.();
        }
      })
      .catch(() => {
        // 目录热监听瞬态异常不阻断宿主进程，下次焦点/读取自动补扫。
      });
  });

  const service: IProjectService = {
    readDirectory: (params) => options.base.readDirectory(params),

    async readProjects(params) {
      if (!isLocalHost(params?.hostId)) return options.base.readProjects(params);
      const sync = await syncFromPiSessions();
      const rawTree = await options.base.readTree({ includeDeleted: params?.includeDeleted });
      return projectUnifiedLocalTree(rawTree, sync).projects;
    },

    async readTree(params) {
      if (!isLocalHost(params?.hostId)) return options.base.readTree(params);
      const sync = await syncFromPiSessions();
      const rawTree = await options.base.readTree(params);
      return projectUnifiedLocalTree(rawTree, sync);
    },

    async saveProject(input) {
      const saved = await options.base.saveProject(input);
      if (isLocalHost(input.hostId)) userSavedProjectIds.add(saved.id);
      return saved;
    },

    deleteProject: (id, hostId) => options.base.deleteProject(id, hostId),

    async restoreProject(id, hostId) {
      const restored = await options.base.restoreProject(id, hostId);
      if (isLocalHost(hostId)) userSavedProjectIds.add(restored.id);
      return restored;
    },

    moveTask: (input) => options.base.moveTask(input),
    reorderProjects: (ids, hostId) => options.base.reorderProjects(ids, hostId),
    prepareSession: (params) => options.base.prepareSession(params),
    measureProjectData: (ids, hostId) => options.base.measureProjectData(ids, hostId),
    deleteProjectData: (id, hostId) => options.base.deleteProjectData(id, hostId),
    resolveSessionDirectories: (task, hostId) =>
      options.base.resolveSessionDirectories(task, hostId),
  };

  return {
    service,
    async syncNow() {
      await syncFromPiSessions();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatch();
    },
  };
}
