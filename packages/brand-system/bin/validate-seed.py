#!/usr/bin/env python3
import os
import sys
from pathlib import Path

from schema_validate import load_json, validate_file

PLACEHOLDER_VALUES = {
    "TODO",
    "TBD",
    "REPLACE_ME",
    "YYYY-MM-DD",
    "YYYY-MM-DDTHH:MM:SSZ",
}

ROOT_DIR = Path(__file__).resolve().parents[1]

def find_placeholders(value, path):
    issues = []
    if isinstance(value, dict):
        for key, item in value.items():
            issues.extend(find_placeholders(item, f"{path}.{key}"))
        return issues
    if isinstance(value, list):
        for idx, item in enumerate(value):
            issues.extend(find_placeholders(item, f"{path}[{idx}]"))
        return issues
    if isinstance(value, str):
        normalized = value.strip().upper()
        if normalized in PLACEHOLDER_VALUES:
            issues.append(f"{path}: placeholder '{value}'")
    return issues


def main():
    os.chdir(ROOT_DIR)
    seed_path = sys.argv[1] if len(sys.argv) > 1 else "brand-seed.json"
    schema_path = sys.argv[2] if len(sys.argv) > 2 else "schemas/brand-seed.schema.json"

    if not os.path.exists(seed_path):
        print(f"Missing seed file: {seed_path}")
        sys.exit(1)
    if not os.path.exists(schema_path):
        print(f"Missing schema file: {schema_path}")
        sys.exit(1)

    errors = validate_file(schema_path, seed_path)
    if errors:
        print("Schema validation failed:")
        for err in errors:
            print(f"- {err}")
        sys.exit(1)

    data = load_json(seed_path)
    placeholders = find_placeholders(data, "$")
    if placeholders:
        print("Placeholder values detected:")
        for entry in placeholders:
            print(f"- {entry}")
        sys.exit(1)

    print("Brand seed validation passed.")


if __name__ == "__main__":
    main()
