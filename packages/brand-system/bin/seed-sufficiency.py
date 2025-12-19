#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

PLACEHOLDER_VALUES = {
    "TODO",
    "TBD",
    "REPLACE_ME",
    "YYYY-MM-DD",
    "YYYY-MM-DDTHH:MM:SSZ",
}

ROOT_DIR = Path(__file__).resolve().parents[1]

def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def get_value(data, path):
    current = data
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None, False
        current = current[part]
    return current, True


def is_placeholder(value):
    if value is None:
        return True
    if isinstance(value, str):
        if not value.strip():
            return True
        return value.strip().upper() in PLACEHOLDER_VALUES
    return False


def main():
    os.chdir(ROOT_DIR)
    seed_path = sys.argv[1] if len(sys.argv) > 1 else "brand-seed.json"
    map_path = sys.argv[2] if len(sys.argv) > 2 else "registry/seed-sufficiency-map.json"

    if not os.path.exists(seed_path):
        print(f"Missing seed file: {seed_path}")
        sys.exit(1)
    if not os.path.exists(map_path):
        print(f"Missing seed sufficiency map: {map_path}")
        sys.exit(1)

    seed = load_json(seed_path)
    mapping = load_json(map_path)

    errors = []
    for requirement in mapping.get("requirements", []):
        output = requirement.get("output", "(unknown output)")
        for path in requirement.get("required_seed_paths", []):
            value, found = get_value(seed, path)
            if not found:
                errors.append(f"{output}: missing seed field {path}")
                continue
            if is_placeholder(value):
                errors.append(f"{output}: seed field {path} is placeholder")

    if errors:
        print("Seed sufficiency check failed:")
        for err in errors:
            print(f"- {err}")
        sys.exit(1)

    print("Seed sufficiency check passed.")


if __name__ == "__main__":
    main()
