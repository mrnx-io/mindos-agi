#!/usr/bin/env python3
import os
import subprocess
import sys

from schema_validate import validate_file, load_json

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
PLACEHOLDER_VALUES = {
    "TODO",
    "TBD",
    "REPLACE_ME",
    "YYYY-MM-DD",
    "YYYY-MM-DDTHH:MM:SSZ",
}


def resolve_path(path):
    return os.path.join(ROOT_DIR, path)


def validate_manifest_entry(entry, errors):
    path = resolve_path(entry["path"])
    if not os.path.exists(path):
        errors.append(f"Missing required file: {entry['path']}")
        return

    schema_path = entry.get("schema")
    if schema_path and entry.get("validate", True):
        schema_full = resolve_path(schema_path)
        if not os.path.exists(schema_full):
            errors.append(f"Missing schema: {schema_path} (for {entry['path']})")
            return
        schema_errors = validate_file(schema_full, path)
        for err in schema_errors:
            errors.append(f"{entry['path']}: {err}")


def validate_optional_entry(entry, warnings, errors, required_key=False):
    path = resolve_path(entry["path"])
    exists = os.path.exists(path)
    if not exists:
        if required_key:
            errors.append(f"Missing expected output: {entry['path']}")
        else:
            warnings.append(f"Missing optional file: {entry['path']}")
        return

    schema_path = entry.get("schema")
    if schema_path:
        schema_full = resolve_path(schema_path)
        if not os.path.exists(schema_full):
            warnings.append(f"Missing schema: {schema_path} (for {entry['path']})")
            return
        schema_errors = validate_file(schema_full, path)
        for err in schema_errors:
            errors.append(f"{entry['path']}: {err}")


def load_section_ids(errors):
    registry_path = resolve_path("registry/sections.json")
    if not os.path.exists(registry_path):
        errors.append("Missing registry/sections.json for derivation validation")
        return set()
    registry = load_json(registry_path)
    return {entry.get("id") for entry in registry.get("sections", []) if entry.get("id")}


def extract_derivation_logs(value, path="$"):
    logs = []
    if isinstance(value, dict):
        if "derivation_log" in value and isinstance(value["derivation_log"], dict):
            logs.append((f"{path}.derivation_log", value["derivation_log"]))
        for key, item in value.items():
            logs.extend(extract_derivation_logs(item, f"{path}.{key}"))
        return logs
    if isinstance(value, list):
        for idx, item in enumerate(value):
            logs.extend(extract_derivation_logs(item, f"{path}[{idx}]"))
    return logs


def is_placeholder(value):
    if value is None:
        return True
    if isinstance(value, str):
        if not value.strip():
            return True
        return value.strip().upper() in PLACEHOLDER_VALUES
    return False


def collect_placeholders(value, path="$"):
    matches = []
    if isinstance(value, dict):
        for key, item in value.items():
            matches.extend(collect_placeholders(item, f"{path}.{key}"))
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            matches.extend(collect_placeholders(item, f"{path}[{idx}]"))
    else:
        if is_placeholder(value):
            matches.append(path)
    return matches


def validate_derivation_log_refs(data, section_ids, errors, file_label):
    logs = extract_derivation_logs(data)
    if not logs:
        errors.append(f"{file_label}: missing derivation_log")
        return
    for path, log in logs:
        source_sections = log.get("source_sections", [])
        for idx, section_id in enumerate(source_sections):
            if section_id not in section_ids:
                errors.append(f"{file_label}: {path}.source_sections[{idx}] unknown section {section_id}")
        chain = log.get("chain", [])
        for chain_idx, link in enumerate(chain):
            derived_from = link.get("derived_from", [])
            for ref_idx, section_id in enumerate(derived_from):
                if section_id not in section_ids:
                    errors.append(
                        f"{file_label}: {path}.chain[{chain_idx}].derived_from[{ref_idx}] unknown section {section_id}"
                    )


def run_section_validation(errors):
    result = subprocess.run(
        [sys.executable, os.path.join(os.path.dirname(__file__), "validate-sections.py")],
        capture_output=True,
        text=True,
        cwd=ROOT_DIR,
    )
    if result.returncode != 0:
        errors.append("Section validation failed")
        output = (result.stdout + result.stderr).strip()
        if output:
            errors.append(output)


def run_seed_sufficiency(errors):
    result = subprocess.run(
        [sys.executable, os.path.join(os.path.dirname(__file__), "seed-sufficiency.py")],
        capture_output=True,
        text=True,
        cwd=ROOT_DIR,
    )
    if result.returncode != 0:
        errors.append("Seed sufficiency check failed")
        output = (result.stdout + result.stderr).strip()
        if output:
            errors.append(output)


def main():
    os.chdir(ROOT_DIR)
    manifest_path = resolve_path("registry/system-manifest.json")
    if not os.path.exists(manifest_path):
        print("Missing registry/system-manifest.json")
        sys.exit(1)

    manifest = load_json(manifest_path)
    errors = []
    warnings = []

    for entry in manifest.get("required_files", []):
        validate_manifest_entry(entry, errors)

    for entry in manifest.get("optional_files", []):
        validate_optional_entry(entry, warnings, errors, required_key=False)

    for entry in manifest.get("expected_outputs", []):
        required = entry.get("required", False)
        validate_optional_entry(entry, warnings, errors, required_key=required)

    section_ids = load_section_ids(errors)
    for entry in manifest.get("expected_outputs", []):
        output_path = resolve_path(entry["path"])
        if not os.path.exists(output_path):
            continue
        data = load_json(output_path)
        validate_derivation_log_refs(data, section_ids, errors, entry["path"])
        placeholders = collect_placeholders(data)
        if placeholders:
            for placeholder_path in placeholders:
                errors.append(f"{entry['path']}: placeholder value at {placeholder_path}")

    run_section_validation(errors)
    run_seed_sufficiency(errors)

    if warnings:
        print("Warnings:")
        for warn in warnings:
            print(f"- {warn}")

    if errors:
        print("System validation failed:")
        for err in errors:
            print(f"- {err}")
        sys.exit(1)

    print("System validation passed.")


if __name__ == "__main__":
    main()
