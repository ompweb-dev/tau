import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const { getFileIcon } = await import("./FileIcons.tsx");
const icon = (name) => renderToStaticMarkup(getFileIcon(name));

test("typed files carry their language's label and hue; others stay dim", () => {
  assert.match(icon("main.cpp"), />C\+\+</);
  assert.match(icon("main.cpp"), /var\(--file-blue\)/);
  assert.match(icon("stages.hpp"), /var\(--file-purple\)/);
  assert.match(icon("CMakeLists.txt"), /var\(--file-green\)/);
  assert.match(icon("utah-teapot.glb"), />3D</);
  assert.match(icon("index.ts"), /var\(--file-blue\)/);
  assert.match(icon("tool.mjs"), />JS</);
  assert.match(icon("Main.java"), /var\(--file-orange\)/);
  assert.match(icon("main.cpp"), /<text[^>]*fill="var\(--text-dim\)"/, "the label is dim text, readable on any row");
  assert.doesNotMatch(icon("Cargo.toml"), /--file-/, "TOML keeps a dim badge");
  assert.doesNotMatch(icon("notes.xyz"), /--file-/, "an unknown type keeps the generic, dim icon");
  assert.doesNotMatch(icon("a.constructor"), /<text/, "an inherited object key is no type");
  assert.doesNotMatch(icon("h"), /<text/, "a name without a dot has no extension");
  assert.doesNotMatch(icon("main.obj"), /3D/, "an object file is no 3D model");
});
