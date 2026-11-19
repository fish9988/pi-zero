import { useCallback, useEffect, useState } from "react";
import type { PiBtwResult } from "@zcode/shared/pi-config";
import { Check, Copy, LoaderCircle, MessageSquareQuote, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PiBtwPopoverProps } from "./contract.js";

export function PiBtwPopover({
  open,
  workspacePath,
  sessionId,
  initialQuestion,
  onClose,
}: PiBtwPopoverProps) {
  const services = useOptionalServices();
  const piService = services?.piConfigService;
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const tr = useCallback((zh: string, en: string) => (isZh ? zh : en), [isZh]);

  const [question, setQuestion] = useState(initialQuestion ?? "");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PiBtwResult | null>(null);
  const [copied, setCopied] = useState(false);

  const runQuestion = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !piService) return;
      setRunning(true);
      setResult(null);
      try {
        const res = await piService.runSessionAction({
          op: "btw",
          request: {
            workspacePath,
            ...(sessionId ? { sessionId } : {}),
            question: trimmed,
          },
        });
        if (res.op === "btw") {
          setResult(res.result);
        }
      } catch (err) {
        setResult({
          id: `err-${Date.now()}`,
          question: trimmed,
          answer: "",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
          createdAt: Date.now(),
        });
      } finally {
        setRunning(false);
      }
    },
    [piService, sessionId, workspacePath],
  );

  useEffect(() => {
    if (!open) return;
    if (initialQuestion?.trim()) {
      setQuestion(initialQuestion.trim());
      void runQuestion(initialQuestion.trim());
    }
  }, [initialQuestion, open, runQuestion]);

  if (!open) return null;

  const handleCopy = async () => {
    if (!result?.answer) return;
    try {
      await navigator.clipboard.writeText(result.answer);
      setCopied(true);
      toast(tr("已复制回答", "Answer copied"));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast(tr("复制失败", "Copy failed"));
    }
  };

  return (
    <div
      data-testid="pi-btw-popover"
      className="mx-auto mb-2 w-full max-w-2xl rounded-xl border border-popover-border bg-popover p-3.5 shadow-lg"
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-ui-sm font-medium text-foreground">
          <MessageSquareQuote className="size-4 text-foreground-subtle" />
          <span>{tr("/btw 侧边问答", "/btw Side Q&A")}</span>
          <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-xs font-normal text-foreground-subtle">
            {tr("不写入当前会话", "Ephemeral")}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={tr("关闭侧边问答", "Close side Q&A")}
          onClick={onClose}
          data-testid="pi-btw-close"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={question}
          disabled={running}
          onChange={(e) => setQuestion(e.currentTarget.value)}
          placeholder={tr("输入临时问题，不打断当前对话上下文…", "Ask a quick side question…")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && question.trim()) {
              e.preventDefault();
              void runQuestion(question);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          data-testid="pi-btw-input"
        />
        <Button
          type="button"
          size="sm"
          disabled={running || !question.trim() || !piService}
          onClick={() => void runQuestion(question)}
          data-testid="pi-btw-send"
        >
          {running ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          {tr("提问", "Ask")}
        </Button>
      </div>

      {running ? (
        <div
          data-testid="pi-btw-loading"
          className="mt-3 flex items-center gap-2 rounded-lg bg-surface px-3 py-2.5 text-ui-sm text-foreground-subtle"
        >
          <LoaderCircle className="size-3.5 animate-spin" />
          {tr("正在通过 pi -p --no-session --no-tools 回答…", "Querying Pi side Q&A…")}
        </div>
      ) : null}

      {result ? (
        <div
          data-testid="pi-btw-result"
          className="mt-3 rounded-lg border border-border bg-surface p-3"
        >
          {result.status === "error" ? (
            <p className="text-ui-sm text-destructive-surface-foreground">
              {result.error ?? tr("侧边问答执行失败", "Side Q&A failed")}
            </p>
          ) : (
            <>
              <div className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-ui-base leading-relaxed text-foreground">
                {result.answer}
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-ui-xs text-foreground-subtle">
                <span className="font-mono tabular-nums">
                  {(result.durationMs / 1000).toFixed(1)}s
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleCopy()}
                  data-testid="pi-btw-copy"
                >
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? tr("已复制", "Copied") : tr("复制", "Copy")}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
