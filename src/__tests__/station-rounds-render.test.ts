import { test, expect, describe, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const dash = require("../dashboard-client.js") as {
  renderStationRounds: (rounds: unknown) => string;
};

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("renderStationRounds", () => {
  test("renders turns + tool list sorted by count desc", () => {
    const html = dash.renderStationRounds({
      turns: 8,
      tools: { Bash: 5, Read: 12, Grep: 3 },
    });
    expect(html).toContain('class="timeline-rounds"');
    expect(html).toContain("8 turns");
    expect(html.indexOf("Read\u00d712")).toBeLessThan(html.indexOf("Bash\u00d75"));
    expect(html.indexOf("Bash\u00d75")).toBeLessThan(html.indexOf("Grep\u00d73"));
  });

  test("uses singular 'turn' for a single turn", () => {
    const html = dash.renderStationRounds({ turns: 1, tools: { Read: 1 } });
    expect(html).toContain("1 turn</span>");
    expect(html).not.toContain("1 turns");
  });

  test("truncates tools past top 6 into '+K more (N)'", () => {
    const html = dash.renderStationRounds({
      turns: 20,
      tools: { A: 10, B: 9, C: 8, D: 7, E: 6, F: 5, G: 4, H: 3 },
    });
    expect(html).toContain("A\u00d710");
    expect(html).toContain("F\u00d75");
    expect(html).not.toContain("G\u00d74");
    expect(html).not.toContain("H\u00d73");
    expect(html).toContain("+2 more (7)");
  });

  test("returns '' for missing rounds", () => {
    expect(dash.renderStationRounds(undefined)).toBe("");
    expect(dash.renderStationRounds(null)).toBe("");
  });

  test("returns '' when turns is 0 and tools is empty", () => {
    expect(dash.renderStationRounds({ turns: 0, tools: {} })).toBe("");
  });

  test("escapes tool names with HTML-sensitive characters", () => {
    const html = dash.renderStationRounds({
      turns: 1,
      tools: { "<script>": 1 },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
