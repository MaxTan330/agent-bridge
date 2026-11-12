/** 脱敏日志字段：仅输出白名单内的错误类别与代码，不输出异常消息、请求头或环境变量。 */
import type { Logger } from 'pino';
import { DeliveryError } from './delivery-error.ts';
export type DiagnosticLogger = Pick<Logger, 'info' | 'warn' | 'error'>;
export function errorFacts(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const names = ['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'DeliveryError'];
  const codes = ['ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR', 'EACCES', 'EPERM', 'ENOENT'];
  const delivery = error instanceof DeliveryError ? error : undefined;
  return {
    errorKind: typeof value.name === 'string' && names.includes(value.name) ? value.name : 'UnknownError',
    errorCode: typeof value.code === 'string' && codes.includes(value.code) ? value.code : undefined,
    sqliteCode: typeof value.errcode === 'number' ? value.errcode : undefined,
    deliveryCategory: delivery && ['api', 'transient', 'permanent'].includes(delivery.category) ? delivery.category : undefined,
    apiCode: typeof delivery?.code === 'number' ? delivery.code : undefined,
    retryable: delivery?.retryable,
  };
}
