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
];

const REPO_EXPLORATION =
  /\b(search|explore|scan|grep|browse|walk|crawl)\b[^.\n]{0,60}\b(repo|repository|codebase|source tree|project files)\b/i;

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
