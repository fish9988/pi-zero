import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateTraceId, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import {
  PiModelCatalog,
  createPiAgentService,
  encodePiSessionBucketDir,
  normalizeWorkspacePathKey,
} from "../src/pi-runtime/index.js";
import { createPiUnifiedProjectService, createProjectService } from "../src/project/index.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createHostCommandEnvelope } from "../src/zcode-agent/zcodeV4HostCommand.js";

const FAKE_PI_SCRIPT = path.resolve(import.meta.dirname, "./fixtures/fake-pi/fake-pi.mjs");

interface PiFixtureSessionInput {
  readonly agentDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly userText: string;
  readonly assistantText?: string;
  readonly customName?: string;
  readonly emptyShellOnly?: boolean;
}

async function writePiJsonlSession(input: PiFixtureSessionInput): Promise<string> {
  const bucketDir = path.join(input.agentDir, "sessions", encodePiSessionBucketDir(input.cwd));
  await mkdir(bucketDir, { recursive: true });
  const stamp = input.createdAt.replace(/[:.]/g, "-");
  const filePath = path.join(bucketDir, `${stamp}_${input.sessionId}.jsonl`);
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: input.sessionId,
      timestamp: input.createdAt,
      cwd: input.cwd,
    }),
  ];

  if (!input.emptyShellOnly) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: input.createdAt,
        message: {
          role: "user",
          content: [{ type: "text", text: input.userText }],
          timestamp: Date.parse(input.createdAt),
        },
      }),
    );
    if (input.assistantText) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: "m2",
          parentId: "m1",
          timestamp: input.lastActivityAt,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: input.assistantText }],
            timestamp: Date.parse(input.lastActivityAt),
          },
        }),
      );
    }
    if (input.customName) {
      lines.push(
        JSON.stringify({
          type: "session_info",
          id: "info1",
          parentId: input.assistantText ? "m2" : "m1",
          timestamp: input.lastActivityAt,
          name: input.customName,
        }),
      );
    }
  }

  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

describe("Pi native session & project unifier", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      await fn?.();
    }
  });

  async function createHarness(options?: {
    seedBeforeUnify?: (ctx: {
      repo: TaskIndexRepo;
      alphaDir: string;
      betaDir: string;
      legacyOnlyDir: string;
      emptyAddedDir: string;
      internalDraftDir: string;
      agentDir: string;
    }) => Promise<void>;
    onDidSync?: () => void;
  }) {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), "pi-session-unifier-"));
    const agentDir = path.join(sandbox, "pi-agent");
    const dbPath = path.join(sandbox, "tasks-index.sqlite");
    const internalWorkspaceDir = path.join(sandbox, "zcode-data", "workspace");
    const syntheticTempDir = path.join(sandbox, "ephemeral-temp");
    const alphaDir = path.join(sandbox, "repos", "AlphaProject");
    const betaDir = path.join(sandbox, "repos", "BetaProject");
    const legacyOnlyDir = path.join(sandbox, "repos", "LegacyZCodeOnly");
    const emptyAddedDir = path.join(sandbox, "repos", "FreshEmptyProject");
    const internalDraftDir = path.join(
      internalWorkspaceDir,
      "draft-11111111-2222-4333-8444-555555555555",
    );

    await Promise.all([
      mkdir(path.join(agentDir, "sessions"), { recursive: true }),
      mkdir(internalWorkspaceDir, { recursive: true }),
      mkdir(syntheticTempDir, { recursive: true }),
      mkdir(alphaDir, { recursive: true }),
      mkdir(betaDir, { recursive: true }),
      mkdir(legacyOnlyDir, { recursive: true }),
      mkdir(emptyAddedDir, { recursive: true }),
      mkdir(internalDraftDir, { recursive: true }),
    ]);

    const taskIndexRepo = new TaskIndexRepo(undefined, "local", dbPath);
    await taskIndexRepo.ensureReady();

    if (options?.seedBeforeUnify) {
      await options.seedBeforeUnify({
        repo: taskIndexRepo,
        alphaDir,
        betaDir,
        legacyOnlyDir,
        emptyAddedDir,
        internalDraftDir,
        agentDir,
      });
    }

    const isolatedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      ZCODE_TEST_PI: FAKE_PI_SCRIPT,
    };

    const catalog = new PiModelCatalog({ env: isolatedEnv });
    const piAgentService = createPiAgentService({
      env: isolatedEnv,
      catalog,
      prepareSessionCreation: async (target) => {
        const prepared = (await taskIndexRepo.getProjectRepository()).reserveCreatedTask({
          task: { ...target, taskId: target.sessionId },
          projectId: target.projectId,
          creationCommand: target.creationCommand,
          additionalDirectories: target.additionalDirectories,
        });
        return {
          sessionId: prepared.taskId,
          additionalDirectories: prepared.additionalDirectories,
        };
      },
    });

    const baseProjectService = createProjectService({
      repository: () => taskIndexRepo.getProjectRepository(),
      workspaceDirectory: internalWorkspaceDir,
      ownerHostId: "local",
    });

    const unified = createPiUnifiedProjectService({
      base: baseProjectService,
      repository: () => taskIndexRepo.getProjectRepository(),
      taskStore: taskIndexRepo,
      workspaceDirectory: internalWorkspaceDir,
      tempDir: syntheticTempDir,
      piDiscovery: {
        listAllSessions: () => piAgentService.listAllPiSessions?.() ?? Promise.resolve([]),
        watchSessions: (onChange) => piAgentService.watchAllPiSessions?.(onChange) ?? (() => {}),
        normalizePathKey: (rawPath) => normalizeWorkspacePathKey(rawPath),
      },
      onDidSync: options?.onDidSync,
    });

    cleanups.push(async () => {
      unified.dispose();
      await piAgentService.disposeAllAndWait();
      catalog.dispose();
      taskIndexRepo.close();
      await rm(sandbox, { recursive: true, force: true });
    });

    return {
      sandbox,
      agentDir,
      syntheticTempDir,
      internalWorkspaceDir,
      alphaDir,
      betaDir,
      legacyOnlyDir,
      emptyAddedDir,
      internalDraftDir,
      taskIndexRepo,
      piAgentService,
      projectService: unified.service,
      unified,
    };
  }

  it("discovers all Pi session cwds as Projects, deduplicates Windows casing/slashes, filters legacy ZCode dead tasks/projects, and keeps user projects", async () => {
    const h = await createHarness({
      seedBeforeUnify: async ({ repo, alphaDir, legacyOnlyDir, agentDir }) => {
        const projectRepo = await repo.getProjectRepository();
        // Existing pinned custom-named project matching alphaDir
        projectRepo.saveProject({
          name: "Alpha Custom",
          roots: [alphaDir],
          pinned: true,
        });
        // Legacy ZCode-only project with dead non-Pi task
        const legacyProj = projectRepo.saveProject({
          name: "LegacyZCodeOnly",
          roots: [legacyOnlyDir],
        });
        await repo.applyCliFacts({
          meta: {
            taskId: "sess_legacy_dead_1",
            traceId: generateTraceId("sess_legacy_dead_1"),
            title: "Old ZCode Dead Task",
            workspacePath: legacyOnlyDir,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_005_000,
            mode: "default",
            provider: ZCODE_AGENT_PROVIDER,
            status: "completed",
          },
          titleSource: "default",
          lastOutcome: "completed",
        });
        projectRepo.moveTask({
          task: { workspacePath: legacyOnlyDir, taskId: "sess_legacy_dead_1" },
          projectId: legacyProj.id,
        });
        // Legacy ZCode ungrouped dead task
        await repo.applyCliFacts({
          meta: {
            taskId: "sess_legacy_ungrouped",
            traceId: generateTraceId("sess_legacy_ungrouped"),
            title: "Dead Ungrouped ZCode Task",
            workspacePath: path.join(legacyOnlyDir, "ungrouped-sub"),
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_002_000,
            mode: "default",
            provider: ZCODE_AGENT_PROVIDER,
            status: "completed",
          },
          titleSource: "default",
          lastOutcome: "completed",
        });

        // Write real Pi sessions into isolated PI_CODING_AGENT_DIR
        await writePiJsonlSession({
          agentDir,
          sessionId: "pi-alpha-1",
          cwd: alphaDir,
          createdAt: "2026-04-01T10:00:00.000Z",
          lastActivityAt: "2026-04-01T10:05:00.000Z",
          userText: "Fix alpha build",
          assistantText: "Build fixed.",
        });
        // Same alphaDir with different casing/trailing slash on Windows (or trailing slash on POSIX)
        const variantAlphaCwd =
          process.platform === "win32"
            ? `${alphaDir.toLowerCase().replace(/\\/g, "/")}/`
            : `${alphaDir}/`;
        await writePiJsonlSession({
          agentDir,
          sessionId: "pi-alpha-2",
          cwd: variantAlphaCwd,
          createdAt: "2026-04-02T10:00:00.000Z",
          lastActivityAt: "2026-04-02T10:10:00.000Z",
          userText: "Initial prompt",
          assistantText: "Done!",
          customName: "Renamed Alpha Session",
        });
        // Brand-new Pi project betaDir (never added to ZCode SQLite before!)
        await writePiJsonlSession({
          agentDir,
          sessionId: "pi-beta-1",
          cwd: path.join(path.dirname(alphaDir), "BetaProject"),
          createdAt: "2026-04-05T08:00:00.000Z",
          lastActivityAt: "2026-04-05T09:00:00.000Z",
          userText: "Explore beta architecture",
          assistantText: "Here is the overview.",
        });
        // Empty-shell .jsonl (must be ignored)
        await writePiJsonlSession({
          agentDir,
          sessionId: "pi-empty-shell",
          cwd: alphaDir,
          createdAt: "2026-04-06T08:00:00.000Z",
          lastActivityAt: "2026-04-06T08:00:00.000Z",
          userText: "",
          emptyShellOnly: true,
        });
      },
    });

    // Dead ephemeral temp dir session (must be skipped)
    await writePiJsonlSession({
      agentDir: h.agentDir,
      sessionId: "pi-dead-temp",
      cwd: path.join(h.syntheticTempDir, "deleted-ephemeral-folder"),
      createdAt: "2026-04-03T10:00:00.000Z",
      lastActivityAt: "2026-04-03T10:01:00.000Z",
      userText: "Temp scratch",
      assistantText: "Scratch reply",
    });

    // Deleted non-temp project dir session (must surface gracefully with primaryRootStatus="missing")
    const missingNonTempDir = path.join(h.sandbox, "repos", "DeletedHistoricRepo");
    await writePiJsonlSession({
      agentDir: h.agentDir,
      sessionId: "pi-missing-dir-1",
      cwd: missingNonTempDir,
      createdAt: "2026-04-01T08:00:00.000Z",
      lastActivityAt: "2026-04-01T08:05:00.000Z",
      userText: "Historical discussion",
      assistantText: "Archived answer",
    });

    // User manually adds a brand-new empty folder in Pi Zero
    await h.projectService.saveProject({ roots: [h.emptyAddedDir] });

    const tree = await h.projectService.readTree({
      includeDeleted: true,
      includeDeletedTasks: true,
    });
    const projectsOnly = await h.projectService.readProjects();

    // 1. Projects: Alpha Custom (reused, not duplicated), BetaProject (auto-discovered),
    //    DeletedHistoricRepo (missing status), FreshEmptyProject (user-added).
    //    LegacyZCodeOnly and deleted-ephemeral-folder MUST NOT appear!
    const activeProjects = tree.projects.filter((p) => !p.deleted);
    expect(activeProjects.map((p) => p.name).sort()).toEqual([
      "Alpha Custom",
      "BetaProject",
      "DeletedHistoricRepo",
      "FreshEmptyProject",
    ]);
    expect(projectsOnly.map((p) => p.name).sort()).toEqual([
      "Alpha Custom",
      "BetaProject",
      "DeletedHistoricRepo",
      "FreshEmptyProject",
    ]);

    const alphaProj = activeProjects.find((p) => p.name === "Alpha Custom")!;
    const betaProj = activeProjects.find((p) => p.name === "BetaProject")!;
    const missingProj = activeProjects.find((p) => p.name === "DeletedHistoricRepo")!;
    expect(alphaProj.pinned).toBe(true);
    expect(missingProj.primaryRootStatus).toBe("missing");
    expect(betaProj.primaryRootStatus).toBe("available");
    // BetaProject is newer than DeletedHistoricRepo so it sits higher (smaller position)
    expect(betaProj.position).toBeLessThan(missingProj.position);

    // 2. Tasks: ONLY real Pi sessions, zero legacy ZCode dead tasks, zero empty shells
    expect(tree.tasks.map((t) => t.taskId).sort()).toEqual([
      "pi-alpha-1",
      "pi-alpha-2",
      "pi-beta-1",
      "pi-missing-dir-1",
    ]);

    const alphaTasks = tree.tasks.filter((t) => t.projectId === alphaProj.id);
    expect(alphaTasks.map((t) => t.taskId).sort()).toEqual(["pi-alpha-1", "pi-alpha-2"]);
    // Both alpha tasks use canonical workspacePath matching alphaProj
    expect(alphaTasks.every((t) => t.workspacePath === alphaProj.roots[0]!.rootPath)).toBe(true);
    expect(alphaTasks.find((t) => t.taskId === "pi-alpha-2")?.title).toBe("Renamed Alpha Session");
    expect(alphaTasks.find((t) => t.taskId === "pi-alpha-2")?.titleOverridden).toBe(true);

    const betaTasks = tree.tasks.filter((t) => t.projectId === betaProj.id);
    expect(betaTasks.map((t) => t.taskId)).toEqual(["pi-beta-1"]);
    expect(betaTasks[0]?.title).toBe("Explore beta architecture");

    // Ungrouped local tasks must be empty -> hides empty 「任务: 暂无任务」 section in UI
    expect(tree.tasks.filter((t) => t.projectId === null)).toHaveLength(0);

    // 3. Hydrating & opening discovered Pi sessions works seamlessly (zero subprocesses!)
    const betaTask = betaTasks[0]!;
    const dirs = await h.projectService.resolveSessionDirectories(betaTask);
    expect(dirs.workspacePath).toBe(betaTask.workspacePath);
    expect(dirs.projectId).toBe(betaProj.id);

    const hydratedRange = await h.piAgentService.conversationRowsRangeV4({
      workspacePath: betaTask.workspacePath,
      sessionId: betaTask.taskId,
      limit: 50,
    });
    expect(hydratedRange.rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(hydratedRange.rows)).toContain("Explore beta architecture");
    expect(JSON.stringify(hydratedRange.rows)).toContain("Here is the overview.");
  });

  it("keeps internal draft sessions ungrouped (no fake draft-* projects) and respects soft-deleted projects + restore", async () => {
    const h = await createHarness();
    await writePiJsonlSession({
      agentDir: h.agentDir,
      sessionId: "pi-draft-1",
      cwd: h.internalDraftDir,
      createdAt: "2026-04-04T10:00:00.000Z",
      lastActivityAt: "2026-04-04T10:05:00.000Z",
      userText: "Quick ungrouped note",
      assistantText: "Noted.",
    });
    await writePiJsonlSession({
      agentDir: h.agentDir,
      sessionId: "pi-beta-softdel",
      cwd: h.betaDir,
      createdAt: "2026-04-04T11:00:00.000Z",
      lastActivityAt: "2026-04-04T11:05:00.000Z",
      userText: "Beta session before delete",
      assistantText: "Reply.",
    });

    const before = await h.projectService.readTree();
    expect(before.projects.map((p) => p.name)).toEqual(["BetaProject"]);
    const draftTask = before.tasks.find((t) => t.taskId === "pi-draft-1");
    expect(draftTask?.projectId).toBeNull();

    // Soft-delete BetaProject -> must not auto-resurrect on next readTree
    const betaId = before.projects[0]!.id;
    await h.projectService.deleteProject(betaId);
    const afterDelete = await h.projectService.readTree();
    expect(afterDelete.projects).toHaveLength(0);
    expect(afterDelete.tasks.map((t) => t.taskId)).toEqual(["pi-draft-1"]);

    // Restore BetaProject -> BetaProject and its Pi session reappear
    await h.projectService.restoreProject(betaId);
    const afterRestore = await h.projectService.readTree();
    expect(afterRestore.projects.map((p) => p.name)).toEqual(["BetaProject"]);
    expect(afterRestore.tasks.find((t) => t.taskId === "pi-beta-softdel")?.projectId).toBe(betaId);
  });

  it("creates a new Pi session in a discovered project as a standard Pi .jsonl file and reacts to external terminal pi sessions", async () => {
    let syncNotifications = 0;
    const h = await createHarness({
      onDidSync: () => {
        syncNotifications += 1;
      },
    });
    await writePiJsonlSession({
      agentDir: h.agentDir,
      sessionId: "pi-beta-seed",
      cwd: h.betaDir,
      createdAt: "2026-04-01T10:00:00.000Z",
      lastActivityAt: "2026-04-01T10:05:00.000Z",
      userText: "Seed beta session",
      assistantText: "Seeded.",
    });

    const initialTree = await h.projectService.readTree();
    const betaProj = initialTree.projects.find((p) => p.name === "BetaProject")!;
    const prepared = await h.projectService.prepareSession({ projectId: betaProj.id });
    expect(normalizeWorkspacePathKey(prepared.workspacePath)).toBe(
      normalizeWorkspacePathKey(h.betaDir),
    );

    const ack = await h.piAgentService.sendConversationCommandV4({
      workspacePath: prepared.workspacePath,
      projectId: betaProj.id,
      envelope: createHostCommandEnvelope({
        type: "createSession",
        sessionId: null,
        payload: {
          workspaceId: prepared.workspacePath,
          cwd: prepared.workspacePath,
          firstInput: {
            text: "Hello from Pi Zero desktop",
          },
        },
      }),
    });
    expect(ack.status).toBe("accepted");
    const createdSessionId =
      ack.result && "sessionId" in ack.result ? String(ack.result.sessionId) : "";
    expect(createdSessionId).toBeTruthy();

    // Verify new session appears immediately in unified tree under BetaProject
    const afterCreate = await h.projectService.readTree();
    const createdTask = afterCreate.tasks.find((t) => t.taskId === createdSessionId);
    expect(createdTask?.projectId).toBe(betaProj.id);

    // Wait briefly for fake-pi spawn to materialize the standard Pi v3 .jsonl header on disk
    const bucketDir = path.join(h.agentDir, "sessions", encodePiSessionBucketDir(h.betaDir));
    let createdFile: string | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const files = await readdir(bucketDir);
      createdFile = files.find(
        (name) => name.includes(createdSessionId) && name.endsWith(".jsonl"),
      );
      if (createdFile) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(createdFile).toBeTruthy();
    const rawHeaderLine = (await readFile(path.join(bucketDir, createdFile!), "utf8")).split(
      "\n",
    )[0]!;
    const header = JSON.parse(rawHeaderLine) as {
      type: string;
      version: number;
      id: string;
      cwd: string;
    };
    expect(header.type).toBe("session");
    expect(header.version).toBe(3);
    expect(header.id).toBe(createdSessionId);
    expect(normalizeWorkspacePathKey(header.cwd)).toBe(normalizeWorkspacePathKey(h.betaDir));

    // Simulate external terminal `pi` creating a session in a brand-new folder alphaDir
    const prevNotifications = syncNotifications;
    await writePiJsonlSession({
      agentDir: h.agentDir,
      sessionId: "pi-cli-external-1",
      cwd: h.alphaDir,
      createdAt: "2026-04-06T12:00:00.000Z",
      lastActivityAt: "2026-04-06T12:05:00.000Z",
      userText: "Started from terminal pi",
      assistantText: "Terminal reply",
    });

    for (let attempt = 0; attempt < 40 && syncNotifications === prevNotifications; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(syncNotifications).toBeGreaterThan(prevNotifications);

    const afterExternal = await h.projectService.readTree();
    expect(afterExternal.projects.some((p) => p.name === "AlphaProject")).toBe(true);
    expect(afterExternal.tasks.some((t) => t.taskId === "pi-cli-external-1")).toBe(true);
  });
});
