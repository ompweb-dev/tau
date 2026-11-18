#!/usr/bin/env node
"use strict";

// `tau host`: link this machine to a main tau so sessions can run here (lib/hosts/host-cli.ts).
//   tau host login --url <url>   reads the host token from stdin
//   tau host [--allow-http]      dials the saved server and keeps the link up (http:// is accepted without the flag for loopback)

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./node-version").exitIfUnsupportedNode();

// The daemon finds its runner from here (lib/omp/omp-cli.ts), not from whatever cwd it was started in.
process.env.TAU_PACKAGE_DIR ??= module.require("node:path").join(__dirname, "..");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jiti = require("jiti").createJiti(__filename);
jiti.import("../lib/hosts/host-cli.ts").then(
  ({ runHostCli }) => runHostCli(process.argv.slice(2)).then((code) => process.exit(code)),
  (error) => {
    console.error(`tau host: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
