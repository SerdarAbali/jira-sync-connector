// Verification reads never retry or sleep inside a Forge invocation.
export class CommentVerificationDeferred extends Error {
  constructor(retryAfterMs = 60000) {
    super('Comment verification temporarily unavailable');
    this.code = 'COMMENT_VERIFICATION_DEFERRED';
    this.retryAfterMs = retryAfterMs;
  }
}

export function commentReadBudget() {
  return { deadline: Date.now() + 10000, cache: new Map() };
}

export async function readCommentJson(request, budget = commentReadBudget()) {
  const remaining = Math.min(4000, budget.deadline - Date.now());
  if (remaining <= 0) throw new CommentVerificationDeferred();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await request();
        if (!response?.ok) {
          const raw = response?.headers?.get?.('retry-after');
          const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : null;
          const delay = seconds !== null ? seconds * 1000 : Date.parse(raw) - Date.now();
          // 401/403/404 also cannot prove comment confidentiality. Bounded
          // recovery may resolve permissions or eventual consistency later.
          throw new CommentVerificationDeferred(Number.isFinite(delay) ? Math.max(60000, delay) : 60000);
        }
        return await response.json();
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new CommentVerificationDeferred()), remaining);
      })
    ]);
  } catch (error) {
    if (error?.code === 'COMMENT_VERIFICATION_DEFERRED') throw error;
    throw new CommentVerificationDeferred();
  } finally {
    clearTimeout(timer);
  }
}
