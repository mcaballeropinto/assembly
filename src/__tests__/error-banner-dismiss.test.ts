import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";

// Set up happy-dom before any imports that touch DOM
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Extract the inline <script> body from global-dashboard.ts and evaluate the
 * declarations (without the bootstrap IIFE) inside a Function harness so the
 * test can reach into _locallyDismissedFiles + updateErrorBanner directly.
 *
 * The .ts source is a template literal that the runtime un-escapes when assembling
 * GLOBAL_DASHBOARD_HTML; for the test, we replicate just the `\\` → `\` step so
 * `new Function()` parses the embedded JS the same way the browser would.
 */
function loadHarness() {
  const src = readFileSync(resolve(import.meta.dir, "..", "global-dashboard.ts"), "utf-8");
  const after = src.indexOf("${DASHBOARD_CLIENT_JS}");
  const openTag = src.indexOf("<script>", after);
  const bodyStart = src.indexOf(">", openTag) + 1;
  const bodyEnd = src.indexOf("</script>", bodyStart);
  let body = src.slice(bodyStart, bodyEnd);

  // Drop the bootstrap IIFE — it kicks off polling and is irrelevant here.
  const iifeStart = body.indexOf("// Initial load — restore view from URL");
  if (iifeStart > 0) body = body.slice(0, iifeStart);

  // Match the template-literal pass: `\\` → `\`.  No `${...}` interpolations
  // exist in this script body, so this single substitution suffices.
  body = body.replace(/\\\\/g, "\\");

  // Stub external client deps the function declarations close over.
  (globalThis as any).AssemblyDashboard = {
    buildOverviewDom: () => document.createElement("div"),
    buildDetailDom: () => document.createElement("div"),
    applyMorph: () => true,
    __resetHashes: () => {},
    renderHistoryInner: () => "",
  };
  (globalThis as any).morphdom = (a: any) => a;
  (globalThis as any).fetch = (..._args: any[]) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

  return new Function(
    body +
      "\nreturn { " +
      "get _locallyDismissedFiles() { return _locallyDismissedFiles; }, " +
      "updateErrorBanner: updateErrorBanner, " +
      "dismissErrors: dismissErrors " +
      "};"
  )();
}

let harness: {
  _locallyDismissedFiles: Set<string>;
  updateErrorBanner: (errs: any[], lineName: string | null) => void;
  dismissErrors: (lineName: string | null, fileNames: string[]) => Promise<void>;
};

beforeAll(() => {
  harness = loadHarness();
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="error-banner-mount"></div>';
  harness._locallyDismissedFiles.clear();
});

describe("updateErrorBanner respects _locallyDismissedFiles", () => {
  test("filters out fileNames present in _locallyDismissedFiles", () => {
    harness._locallyDismissedFiles.add("wp-err-1.json");

    harness.updateErrorBanner(
      [
        { fileName: "wp-err-1.json", id: "wp-err-1", failed: [{ station: "s1" }], task: "task1" },
        { fileName: "wp-err-2.json", id: "wp-err-2", failed: [{ station: "s2" }], task: "task2" },
      ],
      "test-line"
    );

    const mount = document.getElementById("error-banner-mount")!;
    expect(mount.innerHTML).toContain("wp-err-2");
    expect(mount.innerHTML).not.toContain("wp-err-1");
    expect(mount.innerHTML).toMatch(/1 error\b/);
  });

  test("hides the banner when every input fileName is locally dismissed", () => {
    // Prime the mount as if it were currently displaying the error.
    const mount = document.getElementById("error-banner-mount")!;
    mount.innerHTML = '<div class="error-banner">wp-err-1</div>';
    mount.setAttribute("data-banner-key", ":wp-err-1.json");

    harness._locallyDismissedFiles.add("wp-err-1.json");

    harness.updateErrorBanner(
      [{ fileName: "wp-err-1.json", id: "wp-err-1", failed: [{ station: "s" }], task: "t" }],
      "test-line"
    );

    // hideMountWithTransition adds .hiding immediately and clears
    // data-banner-key once the (stubbed) timeout fires; either way the banner
    // must not be re-rendered with the dismissed item.
    expect(mount.classList.contains("hiding")).toBe(true);
    expect(mount.innerHTML).not.toMatch(/error-banner-content/);
  });

  test("reconcile drops local entries the server's active list no longer contains", () => {
    harness._locallyDismissedFiles.add("wp-gone.json");
    harness._locallyDismissedFiles.add("wp-still-active.json");

    harness.updateErrorBanner(
      [
        {
          fileName: "wp-still-active.json",
          id: "wp-still-active",
          failed: [{ station: "s" }],
          task: "t",
        },
      ],
      "test-line"
    );

    expect(harness._locallyDismissedFiles.has("wp-gone.json")).toBe(false);
    // Still in server's active list → kept (so the banner stays suppressed).
    expect(harness._locallyDismissedFiles.has("wp-still-active.json")).toBe(true);
  });
});
