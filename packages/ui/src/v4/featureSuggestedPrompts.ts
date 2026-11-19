import finderIcon from "@/onboarding/assets/finder.png";
import terminalIcon from "@/onboarding/assets/terminal.png";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

type FeatureRecommendedPrompt = DraftSuggestedPromptItem & {
  mode: "office" | "coding";
};

export const LOCAL_PI_CODING_SUGGESTED_PROMPTS: DraftSuggestedPromptItem[] = [
  {
    id: "pi-local-explain-repo",
    iconName: "Code2",
    label: {
      cn: "梳理当前代码库",
      en: "Explain codebase",
    },
    prompt: {
      cn: "帮我梳理当前项目的目录结构、核心模块职责与主要入口调用链，并指出最值得关注的关键文件。",
      en: "Map this repository's directory structure, core module responsibilities, and main entry points.",
    },
  },
  {
    id: "pi-local-debug-fix",
    iconName: "Bug",
    label: {
      cn: "排查并修复问题",
      en: "Debug & fix",
    },
    prompt: {
      cn: "帮我排查当前仓库中的报错或异常行为，定位根本原因，给出最小改动修复方案并验证测试通过。",
      en: "Investigate the current error or bug in this repository, identify the root cause, apply a minimal fix, and verify with tests.",
    },
  },
  {
    id: "pi-local-review-changes",
    iconName: "GitCompareArrows",
    label: {
      cn: "评审未提交改动",
      en: "Review changes",
    },
    prompt: {
      cn: "帮我审查当前 Git 分支的未提交改动，重点检查边界条件、类型安全、潜在回归和测试缺口。",
      en: "Review the uncommitted Git changes on this branch for edge cases, type safety, potential regressions, and test coverage.",
    },
  },
  {
    id: "pi-local-write-tests",
    iconName: "FlaskConical",
    label: {
      cn: "补充单元测试",
      en: "Write tests",
    },
    prompt: {
      cn: "帮我为核心业务逻辑补充高价值的单元测试，覆盖主要边界情况，并运行测试套件确认全部通过。",
      en: "Add high-value unit tests for the core logic covering key edge cases, and run the test suite to verify everything passes.",
    },
  },
];

export const featureSuggestedPrompts: FeatureRecommendedPrompt[] = [
  {
    id: "pi-coding-explain-repo",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "梳理当前仓库的架构与核心数据流",
      en: "Map this repository's architecture and core data flows",
    },
    prompt: {
      cn: "帮我梳理当前打开仓库的目录结构、核心模块职责和关键数据流，列出一份附带文件路径的简明导览。",
      en: "Map the directory structure, core module responsibilities, and key data flows of the open repository with file references.",
    },
  },
  {
    id: "pi-coding-review-diff",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "审查当前分支改动并找出潜在风险",
      en: "Review current branch changes for potential risks",
    },
    prompt: {
      cn: "帮我检查当前 Git 分支的改动，重点关注边界条件、错误处理、并发竞态与缺失的回归测试。",
      en: "Review the current Git branch changes focusing on edge cases, error handling, race conditions, and missing regression tests.",
    },
  },
  {
    id: "pi-coding-improve-tests",
    mode: "coding",
    iconUrl: terminalIcon,
    label: {
      cn: "检查关键模块测试覆盖并补齐缺口",
      en: "Audit test coverage for key modules and fill gaps",
    },
    prompt: {
      cn: "帮我检查当前仓库核心模块的测试覆盖情况，补齐关键路径与异常分支的单元测试并运行验证。",
      en: "Check test coverage for core modules in this repository, add tests for critical paths and error branches, and run the test suite.",
    },
  },
  {
    id: "pi-office-disk-usage",
    mode: "office",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我看看电脑空间主要被什么占满了",
      en: "Show what is using up space on my computer",
    },
    prompt: {
      cn: "帮我分析这台电脑的磁盘占用情况，找出占空间最多的目录和大文件，区分系统文件、应用数据与个人文件。告诉我哪些可以考虑清理、预计能释放多少空间；先不要删除任何文件。",
      en: "Analyze disk usage on this computer. Identify the largest directories and files, distinguish system files, application data, and personal files, and estimate what I could safely clean up. Do not delete any files.",
    },
  },
  {
    id: "pi-office-downloads",
    mode: "office",
    iconUrl: finderIcon,
    label: {
      cn: "帮我看看下载文件夹有哪些可清理的重复文件",
      en: "Find duplicates and clutter to clean up in Downloads",
    },
    prompt: {
      cn: "帮我检查这台电脑下载文件夹里有哪些重复文件、旧安装包和临时文件，按预计可释放空间排序，并给出整理建议。先不要移动或删除任何文件。",
      en: "Inspect this computer's Downloads folder for duplicates, old installers, and temporary files. Rank by space they could free and suggest an organization plan without moving or deleting files.",
    },
  },
  {
    id: "pi-office-slow-computer",
    mode: "office",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我检查当前系统资源占用情况",
      en: "Inspect current system resource usage",
    },
    prompt: {
      cn: "帮我检查这台电脑当前的 CPU、内存和磁盘占用，找出资源消耗最高的进程并给出排查建议。不要结束进程或修改系统设置。",
      en: "Inspect current CPU, memory, and disk usage on this computer, highlight the top consumers, and suggest safe next steps without terminating processes or changing system settings.",
    },
  },
];

export function getRecommendedPromptPool(isOfficeMode: boolean): DraftSuggestedPromptItem[] {
  const mode = isOfficeMode ? "office" : "coding";
  return featureSuggestedPrompts.filter((item) => item.mode === mode);
}
