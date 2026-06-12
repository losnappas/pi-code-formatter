/**
 * pi-code-formatter — auto-format files after every Edit tool call
 *
 * For documentation, see README.md
 */

import type { ExtensionAPI, EditToolDetails } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import * as Diff from "diff";

// ── Config types ──────────────────────────────────────────────────────

interface AutoformatConfig {
  commands: Record<string, string[]>;
  filetypes: Record<string, string>;
}

interface ResolvedFormatter {
  name: string;
  command: string[];
  /** Optional regex pattern. Absence means wildcard ("*"). */
  pattern?: RegExp;
}

// ── State ─────────────────────────────────────────────────────────────

/** Maps absolute file paths to their content before the edit tool ran. */
const originalContents = new Map<string, string>();

/** Resolved formatter config (loaded once at startup). */
let resolvedFormatters: ResolvedFormatter[] = [];

// ── Config loading ────────────────────────────────────────────────────

function getGlobalConfigPath(): string {
  return resolve(homedir(), ".pi", "agent", "extensions", "pi-code-formatter", "config.json");
}

function getProjectConfigPath(cwd: string): string {
  return resolve(cwd, ".pi", "extensions", "pi-code-formatter", "config.json");
}

async function loadJson(path: string): Promise<AutoformatConfig | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as AutoformatConfig;
  } catch {
    return null;
  }
}

function mergeConfigs(
  globalCfg: AutoformatConfig | null,
  projectCfg: AutoformatConfig | null,
): AutoformatConfig | null {
  if (!globalCfg && !projectCfg) return null;

  const commands: Record<string, string[]> = {
    ...(globalCfg?.commands ?? {}),
    ...(projectCfg?.commands ?? {}),
  };
  const filetypes: Record<string, string> = {
    ...(globalCfg?.filetypes ?? {}),
    ...(projectCfg?.filetypes ?? {}),
  };
  return { commands, filetypes };
}

async function loadConfig(cwd: string): Promise<AutoformatConfig | null> {
  const globalPath = getGlobalConfigPath();
  const projectPath = getProjectConfigPath(cwd);

  const [globalCfg, projectCfg] = await Promise.all([
    loadJson(globalPath),
    loadJson(projectPath),
  ]);

  return mergeConfigs(globalCfg, projectCfg);
}

function compilePattern(pattern: string): RegExp {
  // If it's a simple "*.ext" glob, convert to regex
  if (pattern.startsWith("*.")) {
    const ext = pattern.slice(1); // ".ext"
    return new RegExp(`\\${ext}$`);
  }
  // If it's already a regex string, use it as-is
  if (pattern.startsWith("/") && pattern.endsWith("/")) {
    return new RegExp(pattern.slice(1, -1));
  }
  // Otherwise treat as literal suffix match
  return new RegExp(`${pattern}$`);
}

function resolveFormatters(config: AutoformatConfig): ResolvedFormatter[] {
  const result: ResolvedFormatter[] = [];

  for (const [pattern, cmdName] of Object.entries(config.filetypes)) {
    const command = config.commands[cmdName];
    if (!command) {
      console.warn(`[code-formatter] Unknown command "${cmdName}" referenced for pattern "${pattern}"`);
      continue;
    }

    if (pattern === "*") {
      // Wildcard: add to end as fallback
      result.push({ name: cmdName, command });
    } else {
      // Pattern: add to front (more specific matches first)
      const regex = compilePattern(pattern);
      result.unshift({ name: cmdName, command, pattern: regex });
    }
  }

  return result;
}

// ── Finding a formatter ───────────────────────────────────────────────

/** Find the first matching formatter for a file path. */
function findFormatter(filePath: string): ResolvedFormatter | null {
  // First: pattern-based formatters
  for (const f of resolvedFormatters) {
    if (f.pattern && f.pattern.test(filePath)) return f;
  }
  // Last: wildcard fallback (entries from "*" with no pattern)
  for (const f of resolvedFormatters) {
    if (!f.pattern) return f;
  }
  return null;
}

// ── Patch / diff helpers ──────────────────────────────────────────────

/**
 * Generate a standard unified patch string.
 * Mirrors what pi's built-in edit tool does internally.
 */
function generateUnifiedPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  return Diff.createTwoFilesPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    undefined,
    undefined,
    { context: 4, headerOptions: Diff.FILE_HEADERS_ONLY },
  );
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      for (const line of raw) {
        if (part.added) {
          const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
          output.push(`+${lineNum} ${line}`);
          newLineNum++;
        } else {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(`-${lineNum} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextPartIsChange =
        i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const hasLeadingChange = lastWasChange;
      const hasTrailingChange = nextPartIsChange;

      if (hasLeadingChange && hasTrailingChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          const leadingLines = raw.slice(0, contextLines);
          const trailingLines = raw.slice(raw.length - contextLines);
          const skippedLines = raw.length - leadingLines.length - trailingLines.length;

          for (const line of leadingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
          for (const line of trailingLines) {
            const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
            output.push(` ${lineNum} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (hasLeadingChange) {
        const shownLines = raw.slice(0, contextLines);
        const skippedLines = raw.length - shownLines.length;
        for (const line of shownLines) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
      } else if (hasTrailingChange) {
        const skippedLines = Math.max(0, raw.length - contextLines);
        if (skippedLines > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skippedLines;
          newLineNum += skippedLines;
        }
        for (const line of raw.slice(skippedLines)) {
          const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
          output.push(` ${lineNum} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

// ── Formatter runner ──────────────────────────────────────────────────

/**
 * Run a formatter on the given file.
 * Returns true if the file was modified (content changed).
 */
async function runFormatter(
  absolutePath: string,
  formatter: ResolvedFormatter,
  pi: ExtensionAPI,
): Promise<boolean> {
  const before = await readFile(absolutePath, "utf-8");

  const result = await pi.exec(
    formatter.command[0],
    [...formatter.command.slice(1), "--", absolutePath],
    { timeout: 5_000 },
  );

  if (result.code !== 0) {
    return false;
  }

  const after = await readFile(absolutePath, "utf-8");
  return before !== after;
}

// ── Extension entry point ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Load config on startup ──────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig(ctx.cwd);
    if (!config) return;
    resolvedFormatters = resolveFormatters(config);
    if (resolvedFormatters.length > 0) {
      ctx.ui.notify(
        `[code-formatter] Loaded ${resolvedFormatters.length} formatter(s)`,
        "info",
      );
    }
  });

  // ── Step 1: Capture original content before edit ────────────────────
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit") return;

    const path = event.input.path as string | undefined;
    if (!path) return;

    const absolutePath = resolve(ctx.cwd, path);

    // Verify we have a formatter for this file type
    const formatter = findFormatter(path);
    if (!formatter) return;

    try {
      const content = await readFile(absolutePath, "utf-8");
      originalContents.set(absolutePath, content);
    } catch {
      // File doesn't exist yet (new file) — treat original as empty
      originalContents.set(absolutePath, "");
    }
  });

  // ── Step 2: After edit, format and update the patch/diff ────────────
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit") return;
    if (event.isError) return;

    const path = event.input.path as string | undefined;
    if (!path) return;

    const absolutePath = resolve(ctx.cwd, path);
    const originalContent = originalContents.get(absolutePath);
    if (originalContent === undefined) return;

    originalContents.delete(absolutePath);

    // Find and verify formatter
    const formatter = findFormatter(path);
    if (!formatter) return;

    // Run the formatter
    let formattedContent: string;
    try {
      const wasModified = await runFormatter(absolutePath, formatter, pi);
      formattedContent = await readFile(absolutePath, "utf-8");
      if (!wasModified) return; // Formatting didn't change anything
    } catch {
      return; // Formatter unavailable or failed — keep the original patch
    }

    // Compute new patch/diff from original (pre-edit) to formatted content
    const patch = generateUnifiedPatch(path, originalContent, formattedContent);
    const diffResult = generateDiffString(originalContent, formattedContent);

    // Update the tool result with the new patch/diff
    return {
      details: {
        ...event.details,
        patch,
        diff: diffResult.diff,
        firstChangedLine: diffResult.firstChangedLine,
      } as EditToolDetails,
    };
  });
}
