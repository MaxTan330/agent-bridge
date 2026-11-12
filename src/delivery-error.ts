/** 投递错误分类与重试判定；仅重试飞书文档明确列出的限流码与瞬时网络错误。 */
// Only these documented IM v1 / global frequency limits are retried.
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/guide/faq
const rateLimits = new Set([230020, 99991400]);
/** 投递错误类别的全集：api（平台业务码）、transient（可重试）、permanent（不重试），
 *  其余为具体协议缺陷场景（卡片/引用响应缺少 id）。 */
export const DeliveryCategories = ['api', 'transient', 'permanent',
  'missing_card_id', 'missing_card_message_id'] as const;
export type DeliveryCategory = typeof DeliveryCategories[number];
const transientNetwork = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);
export class DeliveryError extends Error {
  readonly category: DeliveryCategory;
  readonly retryable: boolean;
  readonly code?: number;
  constructor(category: DeliveryCategory, retryable: boolean, code?: number) {
    super(`Delivery failed: ${category}`);
    this.name = 'DeliveryError'; this.category = category; this.retryable = retryable; this.code = code;
  }
}
export function isRetryableDelivery(error: unknown): boolean {
  if (error instanceof DeliveryError) return error.retryable;
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; response?: { status?: number; data?: { code?: number } } };
  if (typeof e.code === 'string' && transientNetwork.has(e.code)) return true;
  return e.response?.status === 429 || (e.response?.status !== undefined && e.response.status >= 500 && e.response.status <= 599)
    || rateLimits.has(e.response?.data?.code ?? -1);
}
export function deliveryFailure(error: unknown): DeliveryError {
  if (error instanceof DeliveryError) return error;
  return new DeliveryError(isRetryableDelivery(error) ? 'transient' : 'permanent', isRetryableDelivery(error));
}
export function apiDeliveryFailure(code?: number): DeliveryError {
  return new DeliveryError('api', rateLimits.has(code ?? -1), code);
}
