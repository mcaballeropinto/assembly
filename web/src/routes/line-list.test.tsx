import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

const root = resolve(import.meta.dir, "../../..")
const source = () =>
  readFileSync(resolve(root, "web/src/routes/line.$name.tsx"), "utf-8")

describe("line list route mutation wiring", () => {
  test("renders live state sections and shared mutation actions", () => {
    const code = source()

    expect(code).toContain("apiStateQueryOptions")
    expect(code).toContain('title="Held"')
    expect(code).toContain('title="Active Errors"')
    expect(code).toContain('title="Dismissed Errors"')
    expect(code).toContain('title="Review"')
    expect(code).toContain("useReleaseHeld(name)")
    expect(code).toContain("useReleaseAllHeld(name)")
    expect(code).toContain("useRetryWorkpiece(name)")
    expect(code).toContain("useDismissErrors(name)")
    expect(code).toContain("useUndismissErrors(name)")
    expect(code).toContain("wpline: name")
  })
})
