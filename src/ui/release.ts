export interface AppRelease {
  schema: 1
  app: 'ezgrid'
  buildId: string
  version: string
  commit: string
  builtAt: string
  base: string
}

/** Only a valid network release for this exact app and deployment scope can be compared. */
export function parseRelease(value: unknown, base: string): AppRelease {
  if (!value || typeof value !== 'object') throw new Error('版本响应不是有效对象')
  const r = value as Partial<AppRelease>
  if (r.schema !== 1 || r.app !== 'ezgrid' || r.base !== base || typeof r.buildId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(r.buildId) ||
    typeof r.version !== 'string' || !r.version || typeof r.commit !== 'string' || typeof r.builtAt !== 'string' || !Number.isFinite(Date.parse(r.builtAt))) throw new Error('线上版本信息不完整或不属于当前站点')
  return r as AppRelease
}

export function releaseLabel(release: AppRelease): string {
  return `${release.version} · ${release.buildId.slice(0, 8)}`
}
