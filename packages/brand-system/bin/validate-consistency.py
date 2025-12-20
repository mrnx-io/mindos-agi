#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def main():
    os.chdir(ROOT_DIR)
    errors = []

    manifesto = load_json(Path("outputs/manifesto.json"))
    covenant = load_json(Path("outputs/covenant.json"))
    canon = load_json(Path("outputs/canon.json"))
    choreography = load_json(Path("outputs/choreography.json"))
    storefront = load_json(Path("outputs/storefront.json"))
    tradeoff = load_json(Path("outputs/tradeoff-ladder.json"))

    # LF8 grounding alignment
    man = manifesto["manifesto"]["lf8_grounding"]
    cov = covenant["covenant"]["starving_crowd"]["lf8_configuration"]
    if set([man["primary"], man["secondary"]]) != set([cov["primary"], cov["secondary"]]):
        errors.append("Manifesto LF8 grounding does not match Covenant LF8 configuration")

    # Value ladder alignment
    ladder_map = {
        "LADDER_BAIT": "bait",
        "LADDER_FRONTEND": "frontend",
        "LADDER_MIDDLE": "middle",
        "LADDER_BACKEND": "backend",
        "LADDER_CONTINUITY": "continuity",
    }
    cov_ladder = {item["rung_id"]: item for item in covenant["covenant"]["value_ladder"]}
    sf_ladder = storefront["storefront"]["value_ladder_build"]
    for rung_id, key in ladder_map.items():
        if rung_id not in cov_ladder:
            errors.append(f"Covenant value_ladder missing {rung_id}")
            continue
        if key not in sf_ladder:
            errors.append(f"Storefront value_ladder_build missing {key}")
            continue
        if sf_ladder[key].get("offer") != cov_ladder[rung_id].get("offer"):
            errors.append(f"Offer mismatch for {rung_id} vs storefront {key}")

    # Voice modes alignment
    canon_voice_ids = {item.get("mode_id") for item in canon["canon_of_expression"]["six_voice_modes"]}
    used_voice_ids = set()
    for item in storefront["storefront"]["artifact_architecture"]["page_section_inventory"]:
        used_voice_ids.add(item.get("voice_mode"))
    for item in storefront["storefront"]["funnel_implementation"]:
        used_voice_ids.add(item.get("voice_mode"))
    missing = used_voice_ids - canon_voice_ids
    if missing:
        errors.append(f"Storefront uses voice modes not defined in Canon: {sorted(missing)}")

    # Funnel phase alignment
    funnel_registry = load_json(Path("registry/funnel/funnel-phases.json"))
    funnel_name_to_id = {item["name"]: item["id"] for item in funnel_registry["phases"]}
    cov_phase_ids = set()
    for phase in covenant["covenant"]["funnel_architecture"]["phases"]:
        name = phase.get("name")
        if name in funnel_name_to_id:
            cov_phase_ids.add(funnel_name_to_id[name])
        else:
            errors.append(f"Covenant funnel phase name not in registry: {name}")
    sf_phase_ids = {item.get("stage") for item in storefront["storefront"]["funnel_implementation"]}
    if not sf_phase_ids.issubset(cov_phase_ids):
        errors.append("Storefront funnel stages not aligned with Covenant funnel phases")

    # Moments alignment
    choreo_moments = {item.get("moment") for item in choreography["experience_choreography"]["moments_of_truth"]}
    sf_moments = {item.get("moment") for item in storefront["storefront"]["moment_implementation"]}
    missing_moments = sf_moments - choreo_moments
    if missing_moments:
        errors.append(f"Storefront moments not present in Choreography: {sorted(missing_moments)}")

    # Stack alignment
    stack = load_json(Path("registry/stack/headless-commerce-stack.json"))
    stack_id = stack["stacks"][0]["id"]
    sf_stack_id = storefront["storefront"]["artifact_architecture"]["type_specification"].get("technical_stack_id")
    if sf_stack_id != stack_id:
        errors.append("Storefront technical_stack_id does not match canonical stack registry")

    if errors:
        print("Consistency validation failed:")
        for err in errors:
            print(f"- {err}")
        sys.exit(1)

    print("Consistency validation passed.")


if __name__ == "__main__":
    main()
