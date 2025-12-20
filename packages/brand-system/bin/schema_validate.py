#!/usr/bin/env python3
import json
import os
import re
import sys
from pathlib import Path

try:
    import jsonschema
    from jsonschema import Draft7Validator, RefResolver
except Exception:
    jsonschema = None
    Draft7Validator = None

SCHEMA_CACHE = {}


def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def resolve_pointer(schema, pointer):
    if not pointer or pointer == "#":
        return schema
    if pointer.startswith("#"):
        pointer = pointer[1:]
    if pointer.startswith("/"):
        pointer = pointer[1:]
    if not pointer:
        return schema
    parts = pointer.split("/")
    current = schema
    for part in parts:
        part = part.replace("~1", "/").replace("~0", "~")
        current = current[part]
    return current


def resolve_ref(ref, base_dir, root_schema):
    if ref.startswith("#"):
        return resolve_pointer(root_schema, ref), base_dir, root_schema

    file_part, _, pointer = ref.partition("#")
    file_path = os.path.normpath(os.path.join(base_dir, file_part))
    if file_path not in SCHEMA_CACHE:
        SCHEMA_CACHE[file_path] = load_json(file_path)
    schema = SCHEMA_CACHE[file_path]
    target = resolve_pointer(schema, f"#{pointer}" if pointer else "#")
    return target, os.path.dirname(file_path), schema


def type_matches(instance, expected):
    if expected == "object":
        return isinstance(instance, dict)
    if expected == "array":
        return isinstance(instance, list)
    if expected == "string":
        return isinstance(instance, str)
    if expected == "number":
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
    if expected == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if expected == "boolean":
        return isinstance(instance, bool)
    if expected == "null":
        return instance is None
    return False


def validate(instance, schema, base_dir, root_schema, path="$"):
    errors = []

    if "$ref" in schema:
        ref_schema, ref_base, ref_root = resolve_ref(schema["$ref"], base_dir, root_schema)
        errors.extend(validate(instance, ref_schema, ref_base, ref_root, path))

    if "anyOf" in schema:
        anyof_errors = []
        for option in schema["anyOf"]:
            option_errors = validate(instance, option, base_dir, root_schema, path)
            if not option_errors:
                anyof_errors = []
                break
            anyof_errors.append(option_errors)
        if anyof_errors:
            errors.append(f"{path}: does not match anyOf options")

    expected_type = schema.get("type")
    if expected_type is not None:
        if isinstance(expected_type, list):
            if not any(type_matches(instance, item) for item in expected_type):
                errors.append(f"{path}: expected type {expected_type}")
                return errors
        else:
            if not type_matches(instance, expected_type):
                errors.append(f"{path}: expected type {expected_type}")
                return errors

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: value {instance!r} not in enum")

    if isinstance(instance, str):
        min_length = schema.get("minLength")
        if min_length is not None and len(instance) < min_length:
            errors.append(f"{path}: string length < {min_length}")
        pattern = schema.get("pattern")
        if pattern and re.search(pattern, instance) is None:
            errors.append(f"{path}: string does not match pattern {pattern!r}")

    if isinstance(instance, (int, float)) and not isinstance(instance, bool):
        minimum = schema.get("minimum")
        if minimum is not None and instance < minimum:
            errors.append(f"{path}: value {instance} < minimum {minimum}")
        maximum = schema.get("maximum")
        if maximum is not None and instance > maximum:
            errors.append(f"{path}: value {instance} > maximum {maximum}")

    if isinstance(instance, list):
        min_items = schema.get("minItems")
        if min_items is not None and len(instance) < min_items:
            errors.append(f"{path}: array has fewer than {min_items} items")
        max_items = schema.get("maxItems")
        if max_items is not None and len(instance) > max_items:
            errors.append(f"{path}: array has more than {max_items} items")
        if "items" in schema:
            item_schema = schema["items"]
            for idx, item in enumerate(instance):
                errors.extend(validate(item, item_schema, base_dir, root_schema, f"{path}[{idx}]") )

    if isinstance(instance, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in instance:
                errors.append(f"{path}: missing required property '{key}'")

        properties = schema.get("properties", {})
        for key, value in instance.items():
            if key in properties:
                errors.extend(validate(value, properties[key], base_dir, root_schema, f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: additional property '{key}' not allowed")

    return errors


def validate_file(schema_path, data_path):
    schema = load_json(schema_path)
    data = load_json(data_path)

    if Draft7Validator is not None:
        base_uri = Path(schema_path).resolve().as_uri()
        resolver = RefResolver(base_uri=base_uri, referrer=schema)
        validator = Draft7Validator(schema, resolver=resolver)
        errors = []
        for error in sorted(validator.iter_errors(data), key=str):
            path = "$"
            if error.path:
                path = "$" + "".join([f"[{repr(p)}]" if isinstance(p, int) else f".{p}" for p in error.path])
            errors.append(f"{path}: {error.message}")
        return errors

    base_dir = os.path.dirname(schema_path)
    errors = validate(data, schema, base_dir, schema)
    return errors


def main():
    if len(sys.argv) != 3:
        print("Usage: schema_validate.py <schema.json> <data.json>")
        sys.exit(1)
    schema_path, data_path = sys.argv[1:3]
    errors = validate_file(schema_path, data_path)
    if errors:
        print("Schema validation failed:")
        for err in errors:
            print(f"- {err}")
        sys.exit(1)
    print("Schema validation passed.")


if __name__ == "__main__":
    main()
