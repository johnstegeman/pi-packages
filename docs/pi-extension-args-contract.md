# What an extension's `execute` receives

The contract for tool arguments in this repo, and what pi does and does not enforce.
Decision: `pi-packages-sw30` (2026-10-09). Enforcement in practice:
`packages/pi-beads/src/index.ts`'s `guardUnknownKeys`.

## The contract

**`execute` may receive undeclared top-level keys** unless the schema itself declares
`additionalProperties: false` (see below). The JSON schema a tool declares is what the model is
*asked* to respect; pi adds no *local* enforcement the schema does not ask for, though it does
add the keyword to the request it sends **upstream** — see below. So a tool that cannot
apply a key must reject it by name rather than answer success — otherwise a typo silently drops
the caller's intent, which is the failure `pi-packages-5ov5` closed for `pi-beads`' write tools.

## What pi does, verified on pi 1.1.0

Provenance: the pi 1.1.0 binary
`/Users/jstegeman/.local/share/mise/installs/pi/1.1.0/pi/pi`, sha256
`daea10db90f7806cd0ae5be89fcf819d47b5ed3df99b7c79c31186a1cd6a6501`. Every offset below is the
byte offset of `function <name>` in that binary's embedded JS bundle
(`grep -aob "function <name>"`), recorded the way
`docs/superpowers/specs/2026-09-30-codemode-adoption-design.md:534` records its own.

`validateToolArguments` (embedded-bundle offset `67915977`) clones the arguments, normalises
optional nulls for **declared** keys, validates, and then returns `args` **unchanged**:

```js
const args = structuredClone(toolCall.arguments);
normalizeOptionalNulls(args, tool.parameters);   // declared keys only
exports_value.Convert(tool.parameters, args);
const validator2 = getValidator(tool.parameters);
...
// Elided: the 1.1.0-only JSON-schema coercion block added in this region — see below.
if (validator2.Check(args)) return args;          // returned UNCHANGED
```

Both call paths reach it — the direct one (`prepareToolCall`) and the codemode nested one
(`NestedToolCallRunner._executeNestedToolCall` → `runToolCall` → `prepareToolCall`) — so an
undeclared argument survives to `execute` on either path.

**New since `pi-packages-sw30` was written (that note is 0.99.2):** 1.1.0 adds a JSON-schema
coercion pass, `coerceWithJsonSchema` (embedded-bundle offset `67912771`). It rewrites **declared**
keys only — `applySchemaObjectCoercion` (embedded-bundle offset `67911007`) never deletes an
undeclared one — but it does mean `execute` can receive a *coerced* value for a declared key (a
string `"5"` arriving as the number `5`, say) and an untouched value for an undeclared one.

## `additionalProperties: false`

What the keyword does depends on whether **your tool declares it**, and the two cases are not
symmetric.

**Your tool declares the keyword.** pi compiles its validator from that same schema —
`validateToolArguments` calls `getValidator(tool.parameters)` — so pi's own check is
provider-independent: *where the key reaches it*, a stray key fails `Check` and pi throws
`Validation failed for tool "<name>"`. Whether the key reaches it is a separate question — a
provider that honours strict sampling can drop it upstream, and then the author sees a silent
drop rather than the error. This repo's probe records exactly that outcome with the keyword
declared (`packages/pi-beads/src/index.ts:138-140`). So the keyword is a real rejection at the
local layer — it turns a stray key into a hard tool error instead of letting your `execute`
decide what to do with it — but only where the key survives the provider.

**Your tool does not declare it** (TypeBox's default). pi passes the key through, and only
provider-side strict sampling might have discouraged it upstream. pi adds the keyword to the
schema it sends **upstream** — `makeStrictJsonSchema` clones the schema for that request, and
the local validator never sees that copy — and that request defaults **off**
(`convertResponsesTools`: `defaultStrict = options?.strict === undefined ? false :
options.strict`). So on a provider without strict support the keyword is inert, and on one with
support a model that emits an extra key anyway still has it reach your `execute`.

That is why this repo's answer is the guard rather than the keyword: `pi-beads`' write tools
declare no `additionalProperties: false`, so `execute` rejects an undeclared key by name
(`packages/pi-beads/src/index.ts:781`) and the failure names the field the caller passed
instead of surfacing as a validator error.

## History

This contract was decided on a wrong diagnosis once already: the original `pi-packages-sw30`
claimed "pi-core strips undeclared tool arguments". It does not. The errata are at
`docs/superpowers/specs/2026-10-01-pi-beads-packaging-and-update-surface-design.md:266`, and the
probe that produced the misreading is in `pi-packages-5ov5`'s comment thread. Read those before
re-deriving anything here.
