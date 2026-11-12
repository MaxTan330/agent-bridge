/** 有界等待：超时以错误拒绝 Promise；不终止底层操作本身（取消由调用方的 AbortSignal 负责）。 */
export async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
