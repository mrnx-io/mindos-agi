# Brand System

A canonical, AGI-ready brand architecture system with strict registries, schemas, and validators.

## Canonical Sources
- `brand-seed.json`: single source of truth for inputs
- `registry/`: canonical frameworks and IDs
- `schemas/`: JSON Schemas (validation contract)
- `docs/`: human-readable doctrine

## Generated Artifacts
- `registry/sections.json`: generated section registry (use `sections:generate`)
- `outputs/`: published snapshots of layer outputs

## Commands
From this package:
- `python3 bin/validate-system.py`
- `python3 bin/generate-sections.py`
- `python3 bin/sync-defs.py`

From repo root:
- `bun run check --filter=@mindos/brand-system`
- `bun run defs:sync --filter=@mindos/brand-system`

## Notes
- Outputs are committed as published snapshots for auditability.
- Scripts are path-independent and can be run from any working directory.
