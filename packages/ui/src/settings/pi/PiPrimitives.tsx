import type { ReactNode } from "react";
import type { PiConfigScope } from "@zcode/shared/pi-config";
import { cn } from "@/components/lib/utils.js";
import { usePiText } from "./usePiConfig.js";

export function PiSectionHeader({
  title,
  count,
  actions,
}: {
  title: string;
  count?: string | number;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="text-ui-base font-semibold text-foreground">{title}</h3>
        {count !== undefined ? (
          <span className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle tabular-nums">
            {count}
          </span>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function PiCard({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("overflow-hidden rounded-xl border border-border bg-card", className)}
    >
      {children}
    </div>
  );
}

export function PiRow({
  label,
  hint,
  control,
  detail,
  testId,
}: {
  label: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
  detail?: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="border-t border-border px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-ui-base font-medium text-foreground">{label}</div>
          {hint ? <div className="mt-0.5 text-ui-sm text-foreground-subtle">{hint}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">{control}</div>
      </div>
      {detail ? <div className="mt-2.5">{detail}</div> : null}
    </div>
  );
}

export function PiStatusPill({
  tone,
  children,
  testId,
}: {
  tone: "success" | "warning" | "destructive" | "neutral";
  children: ReactNode;
  testId?: string;
}) {
  const toneClass =
    tone === "success"
      ? "bg-success-surface text-success-surface-foreground"
      : tone === "warning"
        ? "bg-warning-surface text-warning-surface-foreground"
        : tone === "destructive"
          ? "bg-destructive-surface text-destructive-surface-foreground"
          : "bg-surface text-foreground-subtle";
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-ui-xs font-medium",
        toneClass,
      )}
    >
      {children}
    </span>
  );
}

export function PiScopeSwitch({
  scope,
  onScopeChange,
  hasWorkspace,
  testId,
}: {
  scope: PiConfigScope;
  onScopeChange: (next: PiConfigScope) => void;
  hasWorkspace: boolean;
  testId?: string;
}) {
  const { tr } = usePiText();
  return (
    <div
      role="tablist"
      data-testid={testId}
      className="inline-flex items-center rounded-lg border border-border bg-surface p-0.5"
    >
      <button
        type="button"
        role="tab"
        aria-selected={scope === "global"}
        onClick={() => onScopeChange("global")}
        className={cn(
          "rounded-md px-2.5 py-1 text-ui-sm font-medium transition-colors",
          scope === "global"
            ? "bg-card text-foreground shadow-xs"
            : "text-foreground-subtle hover:text-foreground",
        )}
      >
        {tr("全局 (~/.pi)", "Global (~/.pi)")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={scope === "project"}
        disabled={!hasWorkspace}
        onClick={() => onScopeChange("project")}
        className={cn(
          "rounded-md px-2.5 py-1 text-ui-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
          scope === "project"
            ? "bg-card text-foreground shadow-xs"
            : "text-foreground-subtle hover:text-foreground",
        )}
      >
        {tr("当前项目 (.pi)", "Project (.pi)")}
      </button>
    </div>
  );
}

export function PiSegmented<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  onChange: (next: T) => void;
  testId?: string;
}) {
  return (
    <div
      role="radiogroup"
      data-testid={testId}
      className="inline-flex flex-wrap items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-md px-2.5 py-1 text-ui-sm font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-xs"
                : "text-foreground-subtle hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function PiServiceUnavailable() {
  const { tr } = usePiText();
  return (
    <PiCard className="p-4">
      <p className="text-ui-base text-foreground-subtle">
        {tr("Pi 配置服务当前不可用，请确认桌面宿主已启动。", "Pi config service is unavailable.")}
      </p>
    </PiCard>
  );
}
