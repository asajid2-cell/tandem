import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readJson, writeJsonAtomic } from "./jobs.mjs";
import { sanitizeLabel } from "./groups.mjs";

const LANE_META = "lane.json";

export function laneMetadataFile(state) {
  return join(state, LANE_META);
}

export function readLaneMetadata(state) {
  return readJson(laneMetadataFile(state)) || {};
}

export function writeLaneMetadata(state, patch) {
  mkdirSync(state, { recursive: true });
  const current = readLaneMetadata(state);
  const next = {
    ...current,
    ...patch,
    worktree:
      current.worktree || patch.worktree
        ? {
            ...(current.worktree || {}),
            ...(patch.worktree || {}),
          }
        : undefined,
    updatedTs: Date.now(),
  };
  writeJsonAtomic(laneMetadataFile(state), next);
  return next;
}

function git(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function findGitRoot(cwd) {
  const result = git(["-C", resolve(cwd), "rev-parse", "--show-toplevel"]);
  return resolve(result.stdout.trim());
}

function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function branchExists(repo, branch) {
  return git(["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).status === 0;
}

function worktreeBranch(path) {
  return git(["-C", path, "branch", "--show-current"]).stdout.trim();
}

function worktreeCommonDir(path) {
  const raw = git(["-C", path, "rev-parse", "--git-common-dir"]).stdout.trim();
  return resolve(path, raw);
}

function repoCommonDir(repo) {
  const raw = git(["-C", repo, "rev-parse", "--git-common-dir"]).stdout.trim();
  return resolve(repo, raw);
}

export function defaultWorktreePath(repo, label) {
  return join(dirname(repo), `${basename(repo)}-tandem-worktrees`, sanitizeLabel(label));
}

export function defaultWorktreeBranch(label) {
  return `tandem/${sanitizeLabel(label).replace(/[^a-zA-Z0-9._/-]+/g, "-")}`;
}

export function ensureLaneWorktree({
  state,
  label,
  baseCwd,
  path,
  branch,
  startPoint = "HEAD",
}) {
  if (!state) throw new Error("lane state directory is required");
  if (!label) throw new Error("lane label is required");
  const repo = findGitRoot(baseCwd);
  const cleanLabel = sanitizeLabel(label);
  const target = resolve(path || defaultWorktreePath(repo, cleanLabel));
  const targetBranch = branch || defaultWorktreeBranch(cleanLabel);

  if (isInside(repo, target)) {
    throw new Error(`worktree path must be outside the main checkout: ${target}`);
  }

  let created = false;
  if (existsSync(target)) {
    const targetRoot = findGitRoot(target);
    if (!samePath(targetRoot, target)) throw new Error(`existing path is not a worktree root: ${target}`);
    if (!samePath(worktreeCommonDir(target), repoCommonDir(repo))) {
      throw new Error(`existing worktree belongs to a different repository: ${target}`);
    }
    const existingBranch = worktreeBranch(target);
    if (!existingBranch) {
      throw new Error(`existing worktree is detached; check out a dedicated branch before using it as an editing lane: ${target}`);
    }
    if (branch && existingBranch !== targetBranch) {
      throw new Error(`existing worktree uses branch ${existingBranch}, expected ${targetBranch}`);
    }
    branch = existingBranch;
  } else {
    mkdirSync(dirname(target), { recursive: true });
    if (branchExists(repo, targetBranch)) {
      git(["-C", repo, "worktree", "add", target, targetBranch]);
    } else {
      git(["-C", repo, "worktree", "add", "-b", targetBranch, target, startPoint]);
    }
    branch = targetBranch;
    created = true;
  }

  const metadata = writeLaneMetadata(state, {
    version: 1,
    label: cleanLabel,
    cwd: target,
    worktree: {
      repo,
      path: target,
      branch,
      startPoint,
      createdByTandem: created || readLaneMetadata(state).worktree?.createdByTandem || false,
      createdTs: readLaneMetadata(state).worktree?.createdTs || Date.now(),
    },
  });
  return { ...metadata.worktree, cwd: target, created };
}

export function attachLaneWorktree({ state, label, path }) {
  if (!path) throw new Error("worktree path is required");
  const target = findGitRoot(path);
  const branch = worktreeBranch(target);
  if (!branch) {
    throw new Error(`worktree is detached; check out a dedicated branch before attaching it as an editing lane: ${target}`);
  }
  return writeLaneMetadata(state, {
    version: 1,
    label: sanitizeLabel(label),
    cwd: target,
    worktree: {
      repo: dirname(worktreeCommonDir(target)),
      path: target,
      branch,
      createdByTandem: false,
    },
  });
}
