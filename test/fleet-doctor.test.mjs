import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { afterEach } from "node:test";

import { registerSession, updateStatus } from "../bin/fleet-registry.mjs";
import { diagnose, diagnoseSession, heal, pidAlive } from "../bin/fleet-doctor.mjs";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-doctor-"));
  tempDirs.push(dir);
  return dir;
}

function addSession(dir, id, extra = {}) {
  return registerSession(dir, {
    id,
    kind: "junior",
    ...extra,
  });
}

function writeJob(state, name, job) {
  fs.mkdirSync(state, { recursive: true });
  const file = path.join(state, name);
  fs.writeFileSync(file, JSON.stringify(job));
  return file;
}

function findSession(result, id) {
  return result.sessions.find((session) => session.id === id);
}

test("pidAlive recognizes the current process", () => {
  assert.equal(pidAlive(process.pid), true);
});

test("pidAlive rejects a missing process", () => {
  assert.equal(pidAlive(999999999), false);
});

test("settled records have a settled verdict", () => {
  const dir = makeDir();
  const rec = addSession(dir, "settled", {
    state: path.join(dir, "settled-state"),
  });
  updateStatus(dir, rec.id, "done");

  assert.deepEqual(findSession(diagnose(dir), rec.id), {
    id: "settled",
    kind: "junior",
    label: "",
    status: "done",
    verdict: "settled",
    jobStatus: null,
    pid: null,
    pidAlive: false,
    resume: "",
  });
});

test("a live record without a state directory is untracked", () => {
  const dir = makeDir();
  const state = path.join(dir, "missing-state");
  const rec = addSession(dir, "no-state", { state });

  assert.equal(diagnose(dir).sessions[0].verdict, "untracked");
  assert.equal(diagnose(dir).sessions[0].jobStatus, null);
  assert.equal(rec.status, "live");
});

test("a live record with no job file is untracked", () => {
  const dir = makeDir();
  const state = path.join(dir, "empty-state");
  fs.mkdirSync(state);
  addSession(dir, "empty-state", { state });

  const session = diagnose(dir).sessions[0];
  assert.equal(session.verdict, "untracked");
  assert.equal(session.pid, null);
});

test("a done job is finished-ok", () => {
  const dir = makeDir();
  const state = path.join(dir, "ok-state");
  addSession(dir, "finished-ok", { state });
  writeJob(state, "job-ok.json", { status: "done" });

  const session = diagnose(dir).sessions[0];
  assert.equal(session.verdict, "finished-ok");
  assert.equal(session.jobStatus, "done");
});

test("an error job is finished-error", () => {
  const dir = makeDir();
  const state = path.join(dir, "error-state");
  addSession(dir, "finished-error", { state });
  writeJob(state, "job-error.json", { status: "error" });

  const session = diagnose(dir).sessions[0];
  assert.equal(session.verdict, "finished-error");
  assert.equal(session.jobStatus, "error");
});

test("a running job with a live worker is live", () => {
  const dir = makeDir();
  const state = path.join(dir, "live-state");
  addSession(dir, "live", { state });
  writeJob(state, "job-live.json", {
    status: "running",
    workerPid: process.pid,
  });

  const session = diagnose(dir).sessions[0];
  assert.equal(session.verdict, "live");
  assert.equal(session.pid, process.pid);
  assert.equal(session.pidAlive, true);
});

test("a running job with a dead worker is dead", () => {
  const dir = makeDir();
  const state = path.join(dir, "dead-state");
  addSession(dir, "dead", { state });
  writeJob(state, "job-dead.json", {
    status: "running",
    workerPid: 999999999,
  });

  const session = diagnose(dir).sessions[0];
  assert.equal(session.verdict, "dead");
  assert.equal(session.pidAlive, false);
});

test("the newest job file determines the diagnosis", () => {
  const dir = makeDir();
  const state = path.join(dir, "newest-state");
  addSession(dir, "newest", { state });
  const oldFile = writeJob(state, "job-old.json", { status: "done" });
  const newFile = writeJob(state, "job-new.json", {
    status: "running",
    workerPid: process.pid,
  });
  const base = Math.floor(Date.now() / 1000);
  fs.utimesSync(oldFile, base, base);
  fs.utimesSync(newFile, base + 2, base + 2);

  const session = diagnose(dir).sessions[0];
  assert.equal(session.jobStatus, "running");
  assert.equal(session.verdict, "live");
});

test("resume is emitted only for swarm/lane ids", () => {
  assert.equal(
    diagnoseSession({
      id: "swarm/lane",
      kind: "junior",
      status: "live",
      state: "",
    }).resume,
    "peer.mjs swarm continue swarm lane",
  );
  for (const id of ["swarm", "swarm/lane/extra", "/lane", "swarm/"]) {
    assert.equal(
      diagnoseSession({
        id,
        kind: "junior",
        status: "live",
        state: "",
      }).resume,
      "",
    );
  }
});

test("heal dry-run reports transitions without mutating the registry", () => {
  const dir = makeDir();
  const okState = path.join(dir, "heal-ok-state");
  const deadState = path.join(dir, "heal-dead-state");
  addSession(dir, "heal-ok", { state: okState });
  addSession(dir, "heal-dead", { state: deadState });
  writeJob(okState, "job-ok.json", { status: "done" });
  writeJob(deadState, "job-dead.json", {
    status: "running",
    workerPid: 999999999,
  });
  const registryPath = path.join(dir, "registry.json");
  const before = fs.readFileSync(registryPath, "utf8");

  const result = heal(dir);

  assert.equal(result.applied, false);
  assert.deepEqual(
    result.transitions.map(({ id, from, to, verdict }) => ({
      id,
      from,
      to,
      verdict,
    })),
    [
      { id: "heal-ok", from: "live", to: "done", verdict: "finished-ok" },
      { id: "heal-dead", from: "live", to: "gone", verdict: "dead" },
    ],
  );
  assert.equal(fs.readFileSync(registryPath, "utf8"), before);
});

test("heal apply settles finished and dead sessions", () => {
  const dir = makeDir();
  const okState = path.join(dir, "apply-ok-state");
  const deadState = path.join(dir, "apply-dead-state");
  addSession(dir, "apply-ok", { state: okState });
  addSession(dir, "apply-dead", { state: deadState });
  writeJob(okState, "job-ok.json", { status: "done" });
  writeJob(deadState, "job-dead.json", {
    status: "running",
    workerPid: 999999999,
  });

  const result = heal(dir, { apply: true });

  assert.equal(result.applied, true);
  assert.equal(result.transitions.every((transition) => !transition.error), true);
  const diagnosed = diagnose(dir).sessions;
  assert.equal(findSession({ sessions: diagnosed }, "apply-ok").status, "done");
  assert.equal(findSession({ sessions: diagnosed }, "apply-ok").verdict, "settled");
  assert.equal(findSession({ sessions: diagnosed }, "apply-dead").status, "gone");
  assert.equal(findSession({ sessions: diagnosed }, "apply-dead").verdict, "settled");
});

test("a missing registry directory diagnoses as empty", () => {
  const root = makeDir();
  assert.deepEqual(diagnose(path.join(root, "missing")), { sessions: [] });
});

test("corrupt registry JSON reports its path", () => {
  const dir = makeDir();
  const registryPath = path.join(dir, "registry.json");
  fs.writeFileSync(registryPath, "{");

  assert.throws(
    () => diagnose(dir),
    (error) => error.message === `registry corrupt: ${registryPath}`,
  );
});
