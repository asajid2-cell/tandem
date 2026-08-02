import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const RULES = [
  { id: "R1-contract", desc: "has a contract block" },
  { id: "R2-deliverable", desc: "names an exact deliverable path" },
  { id: "R3-verify", desc: "has a self-check command" },
  { id: "R4-ambiguity", desc: "instructs ambiguity reporting" },
  { id: "R5-no-explore", desc: "no repo-exploration phrasing" },
  { id: "R6-size", desc: "within size bounds" },
  { id: "R7-self-contradiction", desc: "does not contradict its own no-read clause" },
];

const REPO_EXPLORATION =
  /\b(search|explore|scan|grep|browse|walk|crawl)\b[^.\n]{0,60}\b(repo|repository|codebase|source tree|project files)\b/i;

// R7 — the live wave-0 finding: a brief passed R1–R6 while contradicting itself (header forbade
// reading any other file; an appended block invited reading the acceptance tests). The junior
// caught it; the gate did not. General contradiction detection is out of reach, but THIS class
// is mechanical: a no-other-files clause plus an instruction to read a concrete file.
const NO_OTHER_FILES =
  /\b(?:do\s*not|don't|never)\b[^.\n]{0,80}\b(?:open|read|modify|access|consult)\b[^.\n]{0,80}\b(?:any\s+)?other\s+file/i;
// "read <path-like>" / "consult <path-like>" — a concrete file reference, not prose
const READ_A_FILE =
  /\b(?:read|open|consult|inspect|refer to|look at)\b[^.\n]{0,60}?([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,6})\b/i;

export function lintBrief(text) {
  const value = typeof text === "string" && text.length > 0 ? text : "";
  const violations = [];

  if (!/^#{1,4}\s*.*\bcontract\b/im.test(value) && !/frozen contract/i.test(value)) {
    violations.push({ rule: "R1-contract", detail: "no contract block" });
  }

  const deliverableMatch = /^\s*DELIVERABLE(?:-TEST)?\s*:\s*(\S+)/im.exec(value);
  if (!deliverableMatch || !/[/.\\]/.test(deliverableMatch[1])) {
    violations.push({ rule: "R2-deliverable", detail: "no DELIVERABLE: <path> line" });
  }

  if (!/^\s*VERIFY\s*:\s*\S+/im.test(value)) {
    violations.push({ rule: "R3-verify", detail: "no VERIFY: <command> line" });
  }

  if (!/ambiguit/i.test(value)) {
    violations.push({ rule: "R4-ambiguity", detail: "no ambiguity reporting instruction" });
  }

  const explorationMatch = REPO_EXPLORATION.exec(value);
  const lowerValue = value.toLowerCase();
  const phraseMatches = [
    ["read the codebase", lowerValue.indexOf("read the codebase")],
    ["look around the repo", lowerValue.indexOf("look around the repo")],
  ].filter(([, index]) => index >= 0);
  if (explorationMatch || phraseMatches.length > 0) {
    const candidates = [
      ...(explorationMatch ? [{ index: explorationMatch.index, text: explorationMatch[0] }] : []),
      ...phraseMatches.map(([phrase, index]) => ({ index, text: value.slice(index, index + phrase.length) })),
    ];
    candidates.sort((left, right) => left.index - right.index);
    const snippet = candidates[0].text;
    violations.push({
      rule: "R5-no-explore",
      detail: snippet.slice(0, 80),
    });
  }

  if (value.length < 400) {
    violations.push({ rule: "R6-size", detail: "too short (<400 chars)" });
  } else if (value.length > 32768) {
    violations.push({ rule: "R6-size", detail: "too long" });
  }

  // R7 — only meaningful when the brief actually HAS a no-other-files clause; a brief without
  // one may reference files freely, so this can never fire on the open shape.
  const noOther = NO_OTHER_FILES.exec(value);
  if (noOther) {
    for (const line of value.split(/\r?\n/)) {
      if (NO_OTHER_FILES.test(line)) continue; // the clause itself
      // the DELIVERABLE/VERIFY lines legitimately name the lane's OWN files
      if (/^\s*(?:DELIVERABLE(?:-TEST)?|VERIFY)\s*:/i.test(line)) continue;
      const read = READ_A_FILE.exec(line);
      if (read) {
        violations.push({
          rule: "R7-self-contradiction",
          detail: `"${noOther[0].trim().slice(0, 50)}" contradicts "${line.trim().slice(0, 70)}"`,
        });
        break;
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];

  if (!input) {
    console.error("unreadable input");
    process.exitCode = 2;
  } else {
    try {
      const text = input === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(input, "utf8");
      const result = lintBrief(text);
      console.log(JSON.stringify(result));
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      console.error("unreadable input");
      process.exitCode = 2;
    }
  }
}
