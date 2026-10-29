/** 刷新后重试同一份输入复用命令编号；取消或成功后下一次录入生成新编号。 */
export function bookingDraft(scope: string, payload: string): string {
  const key = `grid-booking:${scope}`
  try {
    const old = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { id: string; payload: string } | null
    if (old?.payload === payload) return old.id
    const id = crypto.randomUUID()
    sessionStorage.setItem(key, JSON.stringify({ id, payload }))
    return id
  } catch { return crypto.randomUUID() }
}
export function clearBookingDraft(scope: string): void {
  try { sessionStorage.removeItem(`grid-booking:${scope}`) } catch { /* private mode */ }
}
