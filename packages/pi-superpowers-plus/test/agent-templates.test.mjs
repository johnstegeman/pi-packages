import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../agent-templates/explore.md", import.meta.url), "utf8");
assert.ok(text.startsWith("---\n"), "frontmatter opens at line 1");
const end = text.indexOf("\n---", 4);
assert.ok(end > 0, "frontmatter closes");
const frontmatter = text.slice(4, end);
assert.match(frontmatter, /^name:\s*Explore\s*$/m, "declares name: Explore to override the built-in");
assert.match(frontmatter, /^tools:\s*read,\s*bash,\s*find,\s*grep,\s*ls\s*$/m, "keeps the read-only toolset");
assert.doesNotMatch(frontmatter, /^model:/m, "no model pin — inherits the session model");
console.log("agent-templates: all assertions passed");
