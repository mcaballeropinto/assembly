import { test, expect, describe } from "bun:test";
import { parseTaskTitle } from "../dashboard-data";

describe("parseTaskTitle", () => {
  test("extracts H1 as title and strips # marks", () => {
    const result = parseTaskTitle("# Build feature X");
    expect(result.title).toBe("Build feature X");
    expect(result.preview).toBeUndefined();
  });

  test("extracts H1 as title with preview from body text", () => {
    const result = parseTaskTitle("# Title\n\nFirst paragraph of detail.");
    expect(result.title).toBe("Title");
    expect(result.preview).toBe("First paragraph of detail.");
  });

  test("handles plain text without headings as title", () => {
    const result = parseTaskTitle("Plain task description with no heading");
    expect(result.title).toBe("Plain task description with no heading");
    expect(result.preview).toBeUndefined();
  });

  test("strips heading marks from H2 when no H1 present", () => {
    const result = parseTaskTitle("## Sub only\n\nBody");
    expect(result.title).toBe("Sub only");
    expect(result.preview).toBe("Body");
  });

  test("handles empty string gracefully", () => {
    const result = parseTaskTitle("");
    expect(result.title).toBe("");
    expect(result.preview).toBeUndefined();
  });

  test("handles whitespace-only string", () => {
    const result = parseTaskTitle("   \n\n   \n");
    expect(result.title).toBe("");
    expect(result.preview).toBeUndefined();
  });

  test("truncates long title at 80 chars with ellipsis", () => {
    const longTitle = "# " + "A".repeat(100);
    const result = parseTaskTitle(longTitle);
    expect(result.title.length).toBe(81); // 80 chars + 1 ellipsis
    expect(result.title.endsWith("…")).toBe(true);
  });

  test("truncates long preview at 120 chars with ellipsis", () => {
    const content = "# Short title\n\n" + "B".repeat(150);
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Short title");
    expect(result.preview?.length).toBe(121); // 120 chars + 1 ellipsis
    expect(result.preview?.endsWith("…")).toBe(true);
  });

  test("handles markdown with multiple headings, uses first H1", () => {
    const content = `# Main Title
## Sub heading
Body text here
### Another heading`;
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Main Title");
    expect(result.preview).toBe("Body text here");
  });

  test("skips headings in preview search", () => {
    const content = `# Title
## Subheading
### Another
First body text`;
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Title");
    expect(result.preview).toBe("First body text");
  });

  test("handles real-world markdown with mixed content", () => {
    const content = `# Feature: AI activity heartbeats in the task drawer
## Problem
When a task run is in progress, the drawer shows static start time.

## Fix
Add live heartbeat indicators.`;
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Feature: AI activity heartbeats in the task drawer");
    expect(result.preview).toBe("When a task run is in progress, the drawer shows static start time.");
  });

  test("does not leak # characters in title", () => {
    const content = "# Build #123 feature";
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Build #123 feature");
    expect(result.title.startsWith("#")).toBe(false);
    expect(result.title.startsWith("Build")).toBe(true);
  });

  test("does not leak # characters in preview", () => {
    const content = `# Title
Fix #456 in the codebase`;
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Title");
    expect(result.preview).toBe("Fix #456 in the codebase");
  });

  test("handles tasks with code fences and lists", () => {
    const content = `# Deploy to production
\`\`\`bash
npm run deploy
\`\`\`

- Check logs
- Verify endpoints`;
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Deploy to production");
    // First non-heading line after title is the code fence opening
    expect(result.preview).toBe("```bash");
  });

  test("handles multiline H1 spacing variations", () => {
    const content = "#    Title with extra spaces   \n\nBody text";
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Title with extra spaces");
    expect(result.preview).toBe("Body text");
  });

  test("handles single line task with no newlines", () => {
    const result = parseTaskTitle("Single line task");
    expect(result.title).toBe("Single line task");
    expect(result.preview).toBeUndefined();
  });

  test("handles task starting with non-H1 heading", () => {
    const content = `### Small heading
Body content here`;
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Small heading");
    expect(result.preview).toBe("Body content here");
  });

  test("does not include literal markdown syntax in output", () => {
    const content = `# Title
**Bold text** and *italic* content`;
    const result = parseTaskTitle(content);
    expect(result.title).toBe("Title");
    expect(result.preview).toBe("**Bold text** and *italic* content");
    // The preview contains markdown syntax, but no heading marks
    expect(result.preview?.includes("**")).toBe(true);
    expect(result.preview?.startsWith("#")).toBe(false);
  });
});
