import { gzipSync } from "node:zlib"

export interface JsAssetBudget {
  path: string
  bytes: number
  gzipBytes: number
}

export interface BudgetResult {
  assets: JsAssetBudget[]
  totalGzipBytes: number
  maxGzipBytes: number
  pass: boolean
}

export const DEFAULT_DASHBOARD_JS_GZIP_BUDGET = 409600
export const DEFAULT_TTI_BUDGET_MS = 2000

export function measureJsAssets(
  files: Array<{ path: string; content: string | Uint8Array }>,
  maxGzipBytes = DEFAULT_DASHBOARD_JS_GZIP_BUDGET,
): BudgetResult {
  const assets = files.map((file) => {
    const bytes =
      typeof file.content === "string"
        ? Buffer.byteLength(file.content)
        : file.content.byteLength
    return {
      path: file.path,
      bytes,
      gzipBytes: gzipSync(file.content).byteLength,
    }
  })
  const totalGzipBytes = assets.reduce((sum, asset) => sum + asset.gzipBytes, 0)
  return {
    assets,
    totalGzipBytes,
    maxGzipBytes,
    pass: totalGzipBytes <= maxGzipBytes,
  }
}

export function parseInteractiveMs(lighthouseJson: string): number | null {
  const parsed = JSON.parse(lighthouseJson) as {
    audits?: Record<string, { numericValue?: unknown }>
  }
  const audit =
    parsed.audits?.interactive ??
    parsed.audits?.["interactive"]
  const value = audit?.numericValue
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function assertTtiBudget(
  interactiveMs: number | null,
  maxMs = DEFAULT_TTI_BUDGET_MS,
): { pass: boolean; interactiveMs: number | null; maxMs: number } {
  return {
    pass: interactiveMs !== null && interactiveMs <= maxMs,
    interactiveMs,
    maxMs,
  }
}
