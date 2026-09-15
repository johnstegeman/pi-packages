# Evidence Gathering in Multi-Component Systems

For each component boundary: log what enters, what exits, verify config
propagation. Run once to see WHERE it breaks, then investigate that component.

**Example (multi-layer system):**
```bash
# Layer 1: Workflow
echo "=== Secrets available: ==="
echo "IDENTITY: ${IDENTITY:+SET}${IDENTITY:-UNSET}"

# Layer 2: Build script
echo "=== Env vars in build script: ==="
env | grep IDENTITY || echo "IDENTITY not in environment"

# Layer 3: Signing
echo "=== Keychain state: ==="
security list-keychains
security find-identity -v
```
**This reveals:** Which layer fails (e.g., secrets → workflow ✓, workflow → build ✗)
