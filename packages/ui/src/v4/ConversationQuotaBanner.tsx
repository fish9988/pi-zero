import type { CodingPlanBillingDiscountConfig } from "@zcode/shared";
import type { SessionQuotaBannerState } from "@/v4/sessionQuotaBannerState.js";

/** 本地 Pi 工作台不展示 Zhipu Coding Plan / Start Plan 商业额度提醒横幅。 */
export function ConversationQuotaBanner(_props: {
  state: SessionQuotaBannerState;
  billingDiscountActive?: boolean;
  billingDiscountConfig?: CodingPlanBillingDiscountConfig;
  upgradeActionLabelId?: string;
  onUpgrade?: () => void;
  onDismiss: () => void;
  onShown?: () => void;
}) {
  return null;
}
