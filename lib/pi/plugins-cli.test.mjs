import assert from "node:assert/strict";
import test from "node:test";

const { parsePiListOutput } = await import("./plugins-cli.ts");

test("pi list: a configured package that is not installed is listed with no path, and a filter mark is not its source", async () => {
  const out = "\x1b[1mUser packages:\x1b[22m\n  npm:installed\n\x1b[2m    /home/u/.pi/agent/npm/node_modules/installed\x1b[22m\n  npm:missing\n  git:github.com/a/b (filtered)\n    /home/u/.pi/agent/git/b\n\n\x1b[1mProject packages:\x1b[22m\n  ./local\n";
  assert.deepEqual(parsePiListOutput(out), [
    { source: "npm:installed", path: "/home/u/.pi/agent/npm/node_modules/installed", scope: "global" },
    { source: "npm:missing", path: "", scope: "global" },
    { source: "git:github.com/a/b", path: "/home/u/.pi/agent/git/b", scope: "global" },
    { source: "./local", path: "", scope: "project" },
  ]);
});
