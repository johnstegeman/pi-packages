# What an extension's `execute` receives

The contract for tool arguments in this repo, and what pi does and does not enforce.
Decision: `pi-packages-sw30` (2026-10-09). Enforcement in practice:
`packages/pi-beads/src/index.ts`'s `guardUnknownKeys`.

## The contract

**`execute` may receive undeclared top-level keys.** The JSON schema a tool declares is what the
model is *asked* to respect; pi does not enforce it. So a tool that cannot apply a key must
reject it by name rather than answer success — otherwise a typo silently drops the caller's
intent, which is the failure `pi-packages-5ov5` closed for `pi-beads`' write tools.

## What pi does, verified on pi 1.1.0

`validateToolArguments` (embedded-bundle offset `67915977`) clones the arguments, normalises
optional nulls for **declared** keys, validates, and then returns `args` **unchanged**:

```js
const args = structuredClone(toolCall.arguments);
normalizeOptionalNulls(args, tool.parameters);   // declared keys only
exports_value.Convert(tool.parameters, args);
const validator2 = getValidator(tool.parameters);
...
if (validator2.Check(args)) return args;          // returned UNCHANGED
```

Both call paths reach it — the direct one (`prepareToolCall`) and the codemode nested one
(`NestedToolCallRunner._executeNestedToolCall` → `runToolCall` → `prepareToolCall`) — so an
undeclared argument survives to `execute` on either path.

**New since `pi-packages-sw30` was written (that note is 0.99.2):** 1.1.0 adds a JSON-schema
coercion pass, `coerceWithJsonSchema` (offset `67912771`). It rewrites **declared** keys only —
`applySchemaObjectCoercion` (offset `67911007`) never deletes an undeclared one — but it does
mean `execute` can receive a *coerced* value for a declared key (a string `"5"` arriving as the
number `5`, say) and an untouched value for an undeclared one.

## `additionalProperties: false`

**Not enforced by pi.** It is forwarded to strict-capable providers only. On a provider without
strict sampling support the keyword is inert; on one with support, a model that emits an extra
key anyway trips pi's own `validator2.Check(args)` and pi throws
`Validation failed for tool "<name>"`. That is a loud side effect worth knowing about, not a
guarantee to rely on. pi's own strict-sampling request defaults **off**
(`convertResponsesTools`: `defaultStrict = options?.strict === undefined ? false :
options.strict`), so the default posture of the whole system is "undeclared keys pass through".

## History

This contract was decided on a wrong diagnosis once already: the original `pi-packages-sw30`
claimed "pi-core strips undeclared tool arguments". It does not. The errata are at
`docs/superpowers/specs/2026-10-01-pi-beads-packaging-and-update-surface-design.md:266`, and the
probe that produced the misreading is in `pi-packages-5ov5`'s comment thread. Read those before
re-deriving anything here.
