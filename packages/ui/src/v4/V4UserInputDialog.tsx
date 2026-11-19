import { useCallback, useEffect, useState } from "react";
import {
  TID_V4_USER_INPUT_DIALOG,
  TID_V4_USER_INPUT_OPTION,
  TID_V4_USER_INPUT_TEXT,
  testId,
} from "@zcode/shared/test-ids";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { V4UserInputViewModel } from "@/v4/pendingInteractionAdapter.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export interface V4UserInputDialogProps {
  model: V4UserInputViewModel;
  onSubmit: (answer: {
    optionId?: string;
    freeText?: string;
    action?: "accept" | "decline" | "cancel";
  }) => void;
}

/** v4 userInput 交互卡片（承接 Pi extension_ui_request: select / confirm / input / editor）。 */
export function V4UserInputDialog({ model, onSubmit }: V4UserInputDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");
  const isEditorLike =
    model.freeText &&
    model.options.length === 0 &&
    !model.sensitive &&
    (model.prompt.includes("\n") ||
      model.prompt.length > 80 ||
      /editor|multiline|编辑/i.test(model.prompt));
  const initialMultiline = !model.sensitive && (model.multiline ?? isEditorLike);
  const initialFreeText = model.prefill ?? "";
  const [freeText, setFreeText] = useState(initialFreeText);
  const [multiline, setMultiline] = useState(initialMultiline);

  // 连续触发 extension_ui_request 时复用同一弹窗实例，必须按 interactionId 重置预填文本与多行模式，
  // 防止上一个请求的文本泄漏或把 sensitive 密码输入误渲染成明文 Textarea。
  useEffect(() => {
    setFreeText(initialFreeText);
    setMultiline(initialMultiline);
  }, [model.interactionId, initialFreeText, initialMultiline]);

  const handleOption = useCallback(
    (optionId: string) => {
      runUserAction({
        input: {
          featureId: "conversation.blocking.user_input",
          action: "select_option",
          trigger: "button",
        },
        operation: () => onSubmit({ optionId, action: "accept" }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "user_input_submit",
      });
    },
    [onSubmit],
  );

  const handleFreeTextSubmit = useCallback(() => {
    const trimmed = freeText.trim();
    if (!trimmed && model.freeText) return;
    onSubmit(
      model.freeText
        ? { freeText: trimmed, action: "accept" }
        : { optionId: model.options[0]?.optionId, action: "accept" },
    );
  }, [freeText, model.freeText, model.options, onSubmit]);

  const handleCancel = useCallback(() => {
    onSubmit({ action: "cancel" });
  }, [onSubmit]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      data-testid={TID_V4_USER_INPUT_DIALOG}
    >
      <div className="w-full max-w-lg rounded-2xl border border-popover-border bg-popover p-5 shadow-lg">
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="whitespace-pre-wrap text-ui-base font-medium leading-relaxed text-foreground">
            {model.prompt}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={isZh ? "取消" : "Cancel"}
            data-testid="v4-user-input-cancel"
            onClick={handleCancel}
          >
            <X className="size-4" />
          </Button>
        </div>
        {model.options.length > 0 ? (
          <div className="mb-3 flex flex-col gap-1.5">
            {model.options.map((option) => (
              <Button
                key={option.optionId}
                type="button"
                variant="outline"
                className="justify-start text-left"
                data-testid={testId(TID_V4_USER_INPUT_OPTION, option.optionId)}
                onClick={() => handleOption(option.optionId)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}
        {model.freeText ? (
          <div className="flex flex-col gap-2.5">
            {!model.sensitive && multiline ? (
              <Textarea
                rows={6}
                value={freeText}
                placeholder={model.placeholder}
                onChange={(event) => setFreeText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    handleFreeTextSubmit();
                  } else if (event.key === "Escape") {
                    handleCancel();
                  }
                }}
                className="font-mono text-ui-sm"
                data-testid={TID_V4_USER_INPUT_TEXT}
              />
            ) : (
              <Input
                type={model.sensitive ? "password" : "text"}
                value={freeText}
                placeholder={model.placeholder}
                onChange={(event) => setFreeText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleFreeTextSubmit();
                  } else if (event.key === "Escape") {
                    handleCancel();
                  }
                }}
                data-testid={TID_V4_USER_INPUT_TEXT}
              />
            )}
            <div className="flex items-center justify-between gap-2">
              {!model.sensitive ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setMultiline((prev) => !prev)}
                >
                  {multiline
                    ? isZh
                      ? "切换单行"
                      : "Single line"
                    : isZh
                      ? "多行编辑"
                      : "Multiline"}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
                  {isZh ? "取消" : "Cancel"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!freeText.trim()}
                  onClick={handleFreeTextSubmit}
                >
                  {intl.formatMessage({ id: "chat.elicitation.submit" })}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
              {isZh ? "取消" : "Cancel"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
