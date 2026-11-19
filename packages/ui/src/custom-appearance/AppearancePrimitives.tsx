import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

export function AppearanceSectionHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-ui-lg font-semibold tracking-tight text-foreground">{title}</h3>
        {description ? (
          <p className="mt-0.5 text-ui-sm leading-5 text-foreground-subtle">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

export function AppearanceSettingRow({
  label,
  description,
  control,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-4 border-t border-border px-4 py-3 first:border-t-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-ui-sm leading-5 text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}

export function AppearanceSlider({
  label,
  valueLabel,
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  className,
}: {
  label?: ReactNode;
  valueLabel: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      {label ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-ui-sm font-medium text-foreground-subtle">{label}</span>
          <span className="font-mono text-ui-xs font-medium tabular-nums text-foreground">
            {valueLabel}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={ariaLabel}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          className="h-1.5 w-full min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
        />
        {!label ? (
          <span className="min-w-14 text-right font-mono text-ui-xs font-medium tabular-nums text-foreground">
            {valueLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
