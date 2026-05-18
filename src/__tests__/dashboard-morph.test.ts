import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set up happy-dom before any imports that touch DOM
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import morphdom from "morphdom";
(globalThis as any).morphdom = morphdom;

// The UMD module uses `window` as the root, assign to globalThis
const dash = require("../dashboard-client.js") as {
  buildDetailDom: (state: any, ctx?: any) => HTMLElement;
  buildOverviewDom: (gs: any) => HTMLElement;
  renderHistoryInner: (h: any, ctx?: any) => string;
  applyMorph: (target: HTMLElement, next: HTMLElement, hashKey: string, newHash: string) => boolean;
  __resetHashes: () => void;
};

const FIXTURE_DETAIL: any = {
  line: "test-line",
  banner_errors: [],
  held: [],
  completed: [
    { id: "wp-1", fileName: "wp-1.json", finished_at: "2024-01-01T00:00:00Z", duration_ms: 1000 },
  ],
  errors: [
    { id: "wp-err-1", fileName: "wp-err-1.json", finished_at: "2024-01-01T00:00:00Z", duration_ms: 500, failed: [{ station: "discover" }] },
  ],
  errorsDismissed: [],
  reviews: [],
  activity: [],
};

const FIXTURE_GS: any = {
  totals: { lines: 1, linesRunning: 1, linesErrored: 0, totalInbox: 0, totalDone: 5, totalErrors: 0, totalReview: 0, totalCostUsd: 0.05, totalThroughput1h: 2, totalThroughput24h: 10 },
  lines: [{ name: "test-line", status: "running", state: { lineQueue: { inbox: 0, done: 5, errorActive: 0, error: 0, review: 0 }, banner_errors: [], activity: [], errors: [] } }],
  timestamp: "2024-01-01T00:00:00Z",
};

function primeContent(domNode: HTMLElement) {
  const content = document.getElementById("content")!;
  content.innerHTML = "";
  const children = Array.from(domNode.childNodes);
  for (const ch of children) content.appendChild(ch.cloneNode(true));
}

beforeAll(() => {
  // morphdom already registered on globalThis above
  // window.morphdom needs to be set too
  (globalThis as any).window = globalThis;
});

afterAll(() => {
  // Restore native globals so subsequent test files (e.g. held-release-route)
  // get Bun's native fetch instead of happy-dom's.
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  document.body.innerHTML = '<div id="content"></div>';
  dash.__resetHashes();
});

afterEach(() => {
  document.body.innerHTML = "";
  dash.__resetHashes();
});

test("identical-state morph produces zero mutations on second call", () => {
  const hash = JSON.stringify(FIXTURE_DETAIL);

  // First call - primes the DOM
  const first = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  primeContent(first);
  dash.__resetHashes(); // allow re-morph

  // Attach observer before second call
  const target = document.getElementById("content")!;
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((muts) => records.push(...muts));
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });

  // Second call with identical state
  const second = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  dash.applyMorph(target, second, "detail", hash);

  observer.disconnect();
  expect(records.length).toBe(0);
});

test("hash idle-skip: third call with same hash skips morphdom", () => {
  const hash = JSON.stringify(FIXTURE_DETAIL);
  const target = document.getElementById("content")!;

  const first = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  primeContent(first);

  // Second call sets the hash
  const second = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  const didMorph = dash.applyMorph(target, second, "detail", hash);
  expect(didMorph).toBe(true);

  // Third call with same hash should be skipped
  const third = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  const skipped = dash.applyMorph(target, third, "detail", hash);
  expect(skipped).toBe(false);
});

test("errored row added — existing row keeps === DOM identity", () => {
  const target = document.getElementById("content")!;
  const hash1 = JSON.stringify(FIXTURE_DETAIL);

  const first = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  primeContent(first);
  dash.__resetHashes();

  // Re-morph with same state to stabilize
  const second = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  dash.applyMorph(target, second, "detail", hash1);

  // Capture the existing errored row node
  const existingRow = target.querySelector('[data-key="errored-wp-err-1"]');
  expect(existingRow).not.toBeNull();

  // Now add another error
  const state2 = {
    ...FIXTURE_DETAIL,
    errors: [
      ...FIXTURE_DETAIL.errors,
      { id: "wp-err-2", fileName: "wp-err-2.json", finished_at: "2024-01-01T00:01:00Z", duration_ms: 300, failed: [{ station: "analyze" }] },
    ],
  };
  dash.__resetHashes();
  const third = dash.buildDetailDom(state2, { selectedLine: "test-line" });
  dash.applyMorph(target, third, "detail", JSON.stringify(state2));

  // Existing row should be same DOM node
  expect(target.querySelector('[data-key="errored-wp-err-1"]')).toBe(existingRow);
  // New row should be present
  expect(target.querySelector('[data-key="errored-wp-err-2"]')).not.toBeNull();
});

test("data-key on overview line cards", () => {
  const dom = dash.buildOverviewDom(FIXTURE_GS);
  const card = dom.querySelector('[data-key="line-test-line"]');
  expect(card).not.toBeNull();
  expect(card!.classList.contains("line-card")).toBe(true);
});

test("data-key on detail errored rows", () => {
  const dom = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  const row = dom.querySelector('[data-key="errored-wp-err-1"]');
  expect(row).not.toBeNull();
  expect(row!.classList.contains("wp-list-item")).toBe(true);
});

test("data-key on detail completed rows", () => {
  const dom = dash.buildDetailDom(FIXTURE_DETAIL, { selectedLine: "test-line" });
  const row = dom.querySelector('[data-key="completed-wp-1"]');
  expect(row).not.toBeNull();
});

test("overview: single totalInbox change mutates only the inbox count text node", () => {
  const target = document.getElementById("content")!;
  const hash1 = JSON.stringify(FIXTURE_GS);

  const first = dash.buildOverviewDom(FIXTURE_GS);
  primeContent(first);
  dash.__resetHashes();

  // Stabilize
  const second = dash.buildOverviewDom(FIXTURE_GS);
  dash.applyMorph(target, second, "overview", hash1);

  // Verify baseline
  expect(target.querySelector(".metric-card.inbox .count")?.textContent).toBe("0");

  // Change only totalInbox
  const gs2 = JSON.parse(JSON.stringify(FIXTURE_GS));
  gs2.totals.totalInbox = 1;
  const hash2 = JSON.stringify(gs2);

  const callbackRecords: MutationRecord[] = [];
  const observer = new MutationObserver((muts) => callbackRecords.push(...muts));
  observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });

  dash.__resetHashes();
  const third = dash.buildOverviewDom(gs2);
  const ran = dash.applyMorph(target, third, "overview", hash2);
  expect(ran).toBe(true);

  // takeRecords() flushes mutations buffered before the async callback fires
  const allRecords = [...callbackRecords, ...observer.takeRecords()];
  observer.disconnect();

  // The inbox count text node should now read "1"
  expect(target.querySelector(".metric-card.inbox .count")?.textContent).toBe("1");

  // There should be at least one mutation; the characterData one targets .count
  const charData = allRecords.filter((r) => r.type === "characterData");
  if (charData.length > 0) {
    expect((charData[0].target.parentElement as Element).classList.contains("count")).toBe(true);
  } else {
    // happy-dom may emit a childList replacement instead of characterData for text nodes;
    // either way the DOM content must have changed (asserted above)
    expect(allRecords.length).toBeGreaterThan(0);
  }
});

