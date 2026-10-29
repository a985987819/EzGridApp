import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import type { Plugin } from 'vite'

export function buildVersion(base: string, mode: string) {
  const root = process.cwd()
  const files: string[] = []
  const collect = (directory: string) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) collect(path)
      else files.push(path)
    }
  }
  for (const directory of ['src', 'docs', 'public', 'scripts']) collect(directory)
  files.push('index.html', 'vite.config.ts', 'package.json', 'package-lock.json')
  const hash = createHash('sha256').update(`ezgrid-release-v1|${base}|${mode}`)
  for (const file of files.sort()) {
    const bytes = readFileSync(resolve(root, file))
    hash.update(relative(root, resolve(root, file)).replaceAll('\\', '/')).update('\0')
    hash.update(/\.(?:tsx?|m?js|json|md|css|html|svg)$/.test(file) ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes).update('\0')
  }
  let commit = 'local'
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* Source archives can build without Git. */ }
  // Release fixture builds exercise real A/B updates without editing application sources.
  const override = process.env.EZGRID_BUILD_ID
  if (override && !/^[a-zA-Z0-9-]{8,64}$/.test(override)) throw new Error('EZGRID_BUILD_ID 不合法')
  const buildId = override ?? hash.digest('hex').slice(0, 16)
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version as string
  const info = { schema: 1 as const, app: 'ezgrid' as const, buildId, version, commit, builtAt: new Date().toISOString(), base }
  const workerInfoFile = `release-${buildId}.js`
  const plugin: Plugin = {
    name: 'ezgrid-build-version',
    config: () => ({ define: { __APP_BUILD__: JSON.stringify(info) } }),
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'ezgrid-build', content: buildId }, injectTo: 'head' }],
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (new URL(req.url ?? '', 'http://localhost').pathname !== `${base}version.json`) return next()
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(info))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(info) })
      this.emitFile({ type: 'asset', fileName: workerInfoFile, source: `self.addEventListener('message',event=>{if(event.data?.type==='EZGRID_VERSION')event.ports[0]?.postMessage(${JSON.stringify(info)})});` })
    },
  }
  return { plugin, workerInfoFile }
}
