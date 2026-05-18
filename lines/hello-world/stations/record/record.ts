#!/usr/bin/env bun
/**
 * Record station — appends a greeting line to greetings.md.
 *
 * Script-provider contract:
 *   argv[2] — workpiece JSON path
 *   stdout  — one-line envelope JSON
 *   exit 0  — success; non-zero = fail
 */
import { readFileSync, appendFileSync, existsSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const wpPath = process.argv[2];
if (!wpPath || !existsSync(wpPath)) {
  process.stderr.write(`workpiece path missing: argv[2]=${wpPath}\n`);
  process.exit(1);
}

const wp = JSON.parse(readFileSync(wpPath, "utf-8"));
const greeting = wp.stations?.greet?.data?.greeting;
const recipient = wp.stations?.greet?.data?.recipient ?? "unknown";

if (!greeting || typeof greeting !== "string") {
  process.stderr.write("greet.data.greeting missing or not a string\n");
  process.exit(1);
}

// Resolve greetings.md relative to the line root (two dirs up from this script).
const logPath = resolve(import.meta.dir, "..", "..", "greetings.md");

if (!existsSync(logPath)) {
  writeFileSync(logPath, "# Greetings\n\n");
}

const ts = new Date().toISOString();
const entry = `- **${ts}** — to \`${recipient}\`: ${greeting}\n`;
appendFileSync(logPath, entry);

const envelope = {
  summary: `Logged greeting for ${recipient}`,
  content: `Appended entry to \`${logPath}\`.\n\n${entry}`,
  data: {
    log_path: logPath,
    appended: true,
  },
};

process.stdout.write(JSON.stringify(envelope) + "\n");
