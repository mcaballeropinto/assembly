import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  DEFAULT_DASHBOARD_JS_GZIP_BUDGET,
  DEFAULT_TTI_BUDGET_MS,
  assertTtiBudget,
  measureJsAssets,
  parseInteractiveMs,
} from "../src/lib/performance-budget"

const distAssetsDir = new URL("../dist/assets/", import.meta.url)
const files = readdirSync(distAssetsDir)
  .filter((file) => file.endsWith(".js"))
  .sort()
  .map((file) => {
    const path = join(distAssetsDir.pathname, file)
    return { path: `web/dist/assets/${file}`, content: readFileSync(path) }
  })

const budget = measureJsAssets(files, DEFAULT_DASHBOARD_JS_GZIP_BUDGET)

for (const asset of budget.assets) {
  console.log(`${asset.path}: ${asset.gzipBytes} gzip bytes`)
}
console.log(
  `Total JS gzip: ${budget.totalGzipBytes} / ${budget.maxGzipBytes} bytes`,
)

let failed = !budget.pass

if (process.env.DASHBOARD_LIGHTHOUSE_JSON) {
  const lighthouse = readFileSync(process.env.DASHBOARD_LIGHTHOUSE_JSON, "utf8")
  const tti = assertTtiBudget(
    parseInteractiveMs(lighthouse),
    DEFAULT_TTI_BUDGET_MS,
  )
  console.log(`TTI: ${tti.interactiveMs ?? "missing"} / ${tti.maxMs} ms`)
  if (!tti.pass) failed = true
} else {
  console.log(
    "TTI not measured in this sandbox. Run Lighthouse against a populated line and set DASHBOARD_LIGHTHOUSE_JSON to enforce the 2000ms budget.",
  )
}

if (failed) {
  process.exitCode = 1
}
