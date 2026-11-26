{
  lib,
  buildNpmPackage,
  bun,
  ...
}:
let
  productionLib = lib.fileset.difference ../lib (
    lib.fileset.fileFilter (file: lib.hasInfix ".test." file.name) ../lib
  );

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../app
      ../bin
      ../components
      ../hooks
      productionLib
      ../public
      ../scripts

      ../bunfig.toml
      ../instrumentation.node.ts
      ../package.json
      ../package-lock.json
      ../server
      ../tailwind.config.ts
      ../tsconfig.json
      ../proxy.ts
    ];
  };
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
in
buildNpmPackage (finalAttrs: {
  pname = "tau";
  inherit src version;

  # Unverified: written without nix. Refresh npmDepsHash on a machine with nix (`nix build .#default` prints it).
  npmDepsHash = "sha256-HxT+m6bI0I3t9sqsSgHun6oXve3WtIEmkFpCoBplrC4=";

  # tau runs on Bun: the bins' `#!/usr/bin/env bun` lines are patched to this bun, and the build bundles with it.
  # npm still installs the dependencies (package-lock.json). The npm `bun` package (a dev peer of bun-plugin-tailwind)
  # has a postinstall that downloads a binary: skip install scripts.
  npmRebuildFlags = [ "--ignore-scripts" ];
  # Its node_modules/.bin/bun is the postinstall's placeholder, which `npm run build` would find first on PATH.
  preBuild = ''
    rm -f node_modules/.bin/bun node_modules/.bin/bunx
  '';
  nativeBuildInputs = [ bun ];
  buildInputs = [ bun ];

  meta = {
    description = "Local web UI for the oh-my-pi (omp) coding agent";
    license = lib.licenses.mit;
  };
})
