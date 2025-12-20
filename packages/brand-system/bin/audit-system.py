#!/usr/bin/env python3
import hashlib
import json
import os
import sys
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


def main():
    os.chdir(ROOT_DIR)
    errors = []

    manifest = load_json(ROOT_DIR / "registry/system-manifest.json")
    compiler_spec = load_json(ROOT_DIR / "registry/compiler-spec.json")
    compiler_version = compiler_spec.get("compiler_version", "1.0.0")
    compiler_spec_id = compiler_spec.get("id", "COMPILER_SPEC_V1")

    seed_hash = sha256_file(ROOT_DIR / "brand-seed.json")
    registry_hashes = collect_registry_hashes(manifest)

    for entry in manifest.get("expected_outputs", []):
        output_path = ROOT_DIR / entry["path"]
        if not output_path.exists():
            errors.append(f"Missing output for audit: {entry['path']}")
            continue
        data = load_json(output_path)
        metadata = data.get("metadata")
        if not metadata:
            errors.append(f"{entry['path']}: missing metadata")
            continue
        if metadata.get("seed_hash") != seed_hash:
            errors.append(f"{entry['path']}: seed_hash mismatch")
        if metadata.get("compiler_version") != compiler_version:
            errors.append(f"{entry['path']}: compiler_version mismatch")
        if metadata.get("compiler_spec_id") != compiler_spec_id:
            errors.append(f"{entry['path']}: compiler_spec_id mismatch")
        if metadata.get("registry_hashes") != registry_hashes:
            errors.append(f"{entry['path']}: registry_hashes mismatch")

        # Ensure source_sections aligns with derivation_log
        layer_key = [k for k in data.keys() if k not in {"metadata"}]
        if layer_key:
            layer = data[layer_key[0]]
            derivation = layer.get("derivation_log", {}) if isinstance(layer, dict) else {}
            source_sections = derivation.get("source_sections", [])
            meta_sections = metadata.get("source_sections", [])
            if source_sections and meta_sections and set(source_sections) != set(meta_sections):
                errors.append(f"{entry['path']}: source_sections mismatch")

    if errors:
        print("Audit failed:")
        for err in errors:
            print(f"- {err}")
        sys.exit(1)

    print("Audit passed.")


if __name__ == "__main__":
    main()
