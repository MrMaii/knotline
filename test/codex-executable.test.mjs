import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCodexExecutable } from "../shared/codex-executable.mjs";
import { executableCommand } from "../shared/executable-command.mjs";

test("Windows PATH resolves the npm Codex shim to its Node entry", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-executable-test-"));
  try {
    const npmEntry = path.join(
      directory,
      "node_modules",
      "@openai",
      "codex",
      "bin",
      "codex.js",
    );
    await mkdir(path.dirname(npmEntry), { recursive: true });
    await Promise.all([
      writeFile(path.join(directory, "codex"), "#!/bin/sh\n"),
      writeFile(path.join(directory, "codex.cmd"), "@echo off\r\n"),
      writeFile(npmEntry, ""),
    ]);

    const executable = resolveCodexExecutable({
      explicit: "",
      env: { PATH: directory },
      platform: "win32",
    });
    assert.equal(executable, npmEntry);
    assert.deepEqual(executableCommand(executable, ["debug", "models"]), {
      executable: process.execPath,
      args: [npmEntry, "debug", "models"],
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
