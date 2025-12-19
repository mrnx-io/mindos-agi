#!/usr/bin/env python3
import json
import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]

MAPPINGS = {
    "lf8_id": ("registry/biological/lf8.json", "lf8"),
    "awareness_id": ("registry/awareness/schwartz-awareness.json", "levels"),
    "lead_archetype_id": ("registry/awareness/lead-archetypes.json", "archetypes"),
    "brand_archetype_id": ("registry/awareness/brand-archetypes.json", "archetypes"),
    "dr_rule_id": ("registry/copywriting/dr-rules.json", "dr_rules"),
    "sugarman_element_id": ("registry/copywriting/sugarman-elements.json", "elements"),
    "headline_formula_id": ("registry/copywriting/headline-formulas.json", "formulas"),
    "enhancer_id": ("registry/choreography/enhancers.json", "enhancers"),
    "manana_antidote_id": ("registry/choreography/manana-antidotes.json", "antidotes"),
    "value_equation_factor_id": ("registry/value/value-equation.json", "factors"),
    "value_ladder_id": ("registry/value/value-ladder.json", "rungs"),
    "stack_id": ("registry/stack/headless-commerce-stack.json", "stacks"),
}


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def extract_ids(registry_path: Path, list_key: str):
    data = load_json(registry_path)
    items = data.get(list_key, [])
    ids = [item.get("id") for item in items if isinstance(item, dict) and item.get("id")]
    if not ids:
        raise ValueError(f"No IDs found in {registry_path} for key '{list_key}'")
    if len(ids) != len(set(ids)):
        duplicates = sorted({item for item in ids if ids.count(item) > 1})
        raise ValueError(f"Duplicate IDs in {registry_path}: {', '.join(duplicates)}")
    return ids


def main():
    os.chdir(ROOT_DIR)
    defs_path = ROOT_DIR / "schemas" / "_defs.json"
    defs = load_json(defs_path)
    definitions = defs.get("definitions", {})

    for def_name, (registry_file, list_key) in MAPPINGS.items():
        registry_path = ROOT_DIR / registry_file
        ids = extract_ids(registry_path, list_key)
        definition = definitions.get(def_name, {})
        definition["type"] = "string"
        definition["enum"] = ids
        definitions[def_name] = definition

    defs["definitions"] = definitions
    defs_path.write_text(json.dumps(defs, indent=2) + "\n")
    print("Synced schemas/_defs.json enums from registries.")


if __name__ == "__main__":
    main()
