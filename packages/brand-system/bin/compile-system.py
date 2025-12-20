#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_file(path: Path):
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def collect_registry_hashes(manifest):
    hashes = {}
    for entry in manifest.get("required_files", []):
        rel = entry.get("path")
        if not rel or not rel.startswith("registry/"):
            continue
        p = ROOT_DIR / rel
        if p.exists() and p.is_file():
            hashes[rel] = sha256_file(p)
    return hashes


def find_existing_generated_at(manifest):
    for entry in manifest.get("expected_outputs", []):
        output_path = ROOT_DIR / entry.get("path", "")
        if not output_path.exists():
            continue
        try:
            data = load_json(output_path)
        except Exception:
            continue
        metadata = data.get("metadata") if isinstance(data, dict) else None
        if isinstance(metadata, dict):
            generated_at = metadata.get("generated_at")
            if generated_at:
                return generated_at
    return None


def run_script(script_path):
    subprocess.run(["python3", str(ROOT_DIR / script_path)], check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--generated-at", dest="generated_at", default=None)
    args = parser.parse_args()

    os.chdir(ROOT_DIR)

    compiler_spec = load_json(ROOT_DIR / "registry/compiler-spec.json")
    compiler_version = compiler_spec.get("compiler_version", "1.0.0")
    compiler_spec_id = compiler_spec.get("id", "COMPILER_SPEC_V1")

    manifest = load_json(ROOT_DIR / "registry/system-manifest.json")
    existing_generated_at = find_existing_generated_at(manifest)

    generated_at = args.generated_at
    if not generated_at:
        generated_at = existing_generated_at or datetime.now(timezone.utc).isoformat()

    # pipeline: sync defs + generate sections + generate outputs
    run_script("bin/sync-defs.py")
    run_script("bin/generate-sections.py")
    run_script("bin/generate-outputs.py")

    # compute hashes
    seed_hash = sha256_file(ROOT_DIR / "brand-seed.json")
    registry_hashes = collect_registry_hashes(manifest)

    # apply metadata to outputs
    for entry in manifest.get("expected_outputs", []):
        output_path = ROOT_DIR / entry["path"]
        if not output_path.exists():
            raise FileNotFoundError(f"Missing expected output: {entry['path']}")
        data = load_json(output_path)

        # find top-level layer object key
        layer_keys = [k for k in data.keys() if k != "metadata"]
        if not layer_keys:
            raise ValueError(f"Output missing layer object: {entry['path']}")
        layer_key = layer_keys[0]
        layer = data[layer_key]
        source_sections = []
        if isinstance(layer, dict):
            derivation_log = layer.get("derivation_log", {})
            source_sections = derivation_log.get("source_sections", [])

        data["metadata"] = {
            "seed_hash": seed_hash,
            "registry_hashes": registry_hashes,
            "compiler_version": compiler_version,
            "compiler_spec_id": compiler_spec_id,
            "generated_at": generated_at,
            "source_sections": source_sections or ["SECTION_ORCH_THEPERSUASIONOPERATINGSYSTEM"],
        }

        output_path.write_text(json.dumps(data, indent=2) + "\n")

    # validate system + consistency + audit
    run_script("bin/validate-system.py")
    run_script("bin/validate-consistency.py")
    run_script("bin/audit-system.py")

    print("Compilation complete.")


if __name__ == "__main__":
    main()
