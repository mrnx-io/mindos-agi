#!/usr/bin/env python3
import json
import os
import re
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = ROOT_DIR / "templates" / "outputs"
OUTPUT_DIR = ROOT_DIR / "outputs"


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def save_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


def words_from(text):
    return [w.lower() for w in re.findall(r"[A-Za-z]+", text)]


def lf8_from_pain(pain_statement):
    tokens = set(words_from(pain_statement or ""))
    if tokens & {"pain", "hurt", "ache", "burn", "injury", "injured", "sore"}:
        return "LF8_PAIN_FREEDOM", "LF8_COMFORT", "LF8_PROTECTION"
    if tokens & {"safe", "safety", "protect", "protection"}:
        return "LF8_PROTECTION", "LF8_SURVIVAL", None
    return "LF8_COMFORT", "LF8_PROTECTION", None


def format_price(value, currency, fallback="Custom"):
    if value:
        return f"{value} {currency}".strip()
    return fallback


def build_value_ladder(seed):
    econ = seed.get("economic_constraints", {})
    product = seed.get("product_service", {})
    price = econ.get("price_corridor", {})
    min_price = price.get("min", 0)
    max_price = price.get("max", 0)
    currency = price.get("currency", "")
    core = product.get("core_offering", "the core offering")
    return [
        {"rung_id": "LADDER_BAIT", "rung_label": "Bait", "offer": "Assessment", "price": "Free", "purpose": "Qualify and build trust"},
        {"rung_id": "LADDER_FRONTEND", "rung_label": "Frontend", "offer": core, "price": format_price(min_price, currency, fallback="Custom"), "purpose": "First purchase"},
        {"rung_id": "LADDER_MIDDLE", "rung_label": "Middle", "offer": f"{core} + guidance", "price": format_price(max_price, currency, fallback="Custom"), "purpose": "Deeper support"},
        {"rung_id": "LADDER_BACKEND", "rung_label": "Backend", "offer": "Premium consult", "price": "By invitation", "purpose": "High-touch support"},
        {"rung_id": "LADDER_CONTINUITY", "rung_label": "Continuity", "offer": "Subscription", "price": "Monthly subscription", "purpose": "Ongoing value"}
    ]


def generate_manifesto(template, seed):
    pain = seed.get("market_evidence", {}).get("pain_statement", "")
    primary, secondary, tertiary = lf8_from_pain(pain)
    manifesto = template.get("manifesto", {})
    lf8 = manifesto.get("lf8_grounding", {})
    lf8["primary"] = primary
    lf8["secondary"] = secondary
    if tertiary is not None:
        lf8["tertiary"] = tertiary
    else:
        lf8.pop("tertiary", None)
    manifesto["lf8_grounding"] = lf8
    template["manifesto"] = manifesto
    return template


def generate_covenant(template, seed):
    cov = template["covenant"]
    market = seed.get("market_evidence", {})
    founder = seed.get("founder_assets", {})
    product = seed.get("product_service", {})
    econ = seed.get("economic_constraints", {})
    ops = seed.get("operational_constraints", {})

    pain = market.get("pain_statement", "")
    core = product.get("core_offering", "the core offering")
    geo = ops.get("geographic_focus", "the primary market")
    primary, secondary, tertiary = lf8_from_pain(pain)

    starving = cov.get("starving_crowd", {})
    starving["pain_statement"] = pain or starving.get("pain_statement")
    starving["who_they_are"] = f"Prospects in {geo} seeking {core}."
    starving["what_they_suffer"] = pain or "Persistent pain and frustration with current options."
    starving["when_pain_peaks"] = "When the problem interrupts daily life and work."
    starving["failed_alternatives"] = market.get("failed_alternatives", starving.get("failed_alternatives", []))
    starving["why_still_searching"] = f"They want relief and reliability from {core}."
    lf8_config = {
        "primary": primary,
        "secondary": secondary,
        "hierarchy_rationale": "Primary pain relief governs; comfort and protection reinforce commitment."
    }
    if tertiary is not None:
        lf8_config["tertiary"] = tertiary
    starving["lf8_configuration"] = lf8_config
    starving["awareness_level"] = "AWARE_PROBLEM"
    starving["watering_holes"] = market.get("watering_holes", starving.get("watering_holes", []))
    starving["wallet_evidence"] = market.get("wallet_evidence", starving.get("wallet_evidence", []))
    starving["exclusion_boundary"] = "Exclude anyone unwilling to follow the protocol."
    cov["starving_crowd"] = starving

    offer = cov.get("grand_slam_offer", {})
    offer["core_promise"] = core
    offer["vehicle"] = product.get("delivery_model", "Primary delivery mechanism")
    ve = offer.get("value_equation", {})
    ve["dream_outcome"] = f"Relief and confidence from {core}."
    ve["perceived_likelihood"] = "Mechanism + proof + protocol."
    ve["time_delay"] = "Within a reasonable adaptation window."
    ve["effort_sacrifice"] = "Follow a simple daily protocol."
    offer["value_equation"] = ve
    offer["proof_stack"] = {
        "mechanism": founder.get("backstory", "Mechanism grounded in founder experience."),
        "results": (market.get("pain_statement", "Results evidence")),
        "risk_reversal": "Simple return or reversal policy."
    }
    offer["bonuses"] = ["Quick-start guide", "Protocol checklist"]
    offer["psychological_enhancers"] = offer.get("psychological_enhancers", {})
    cov["grand_slam_offer"] = offer

    # value ladder
    cov["value_ladder"] = build_value_ladder(seed)

    # attractive character
    cov["attractive_character"] = {
        "archetype": "ARCHETYPE_REPORTER",
        "backstory_elements": [founder.get("backstory", "Founder origin")],
        "parables": ["The first turning point"],
        "character_flaws": founder.get("character_flaws", [])
    }

    # unit economics
    unit = econ.get("unit_economics_inputs", {})
    cov["unit_economics"] = {
        "customer_acquisition_cost": econ.get("cac_budget", 0),
        "lifetime_value": unit.get("target_lifetime_value", 0) or 0,
        "ltv_cac_ratio": unit.get("target_ltv_cac_ratio", 0),
        "payback_period": f"{unit.get('target_payback_period_months', 0)} months",
        "contribution_margin": unit.get("contribution_margin_percent", 0)
    }

    cov["traffic_architecture"] = cov.get("traffic_architecture", {})
    cov["traffic_architecture"]["primary_channels"] = market.get("watering_holes", [])
    cov["traffic_architecture"]["content_strategy"] = "Educate, then diagnose, then offer."

    cov["funnel_architecture"] = {
        "phases": [
            {"name": "Diagnose", "purpose": "Identify pain type and build relevance"},
            {"name": "Explain", "purpose": "Teach mechanism and establish authority"},
            {"name": "Offer", "purpose": "Present the offer and guarantee"},
            {"name": "Ascend", "purpose": "Retention and renewal"}
        ],
        "entry_points": ["Assessment", "Explainer", "Offer"],
        "conversion_events": ["Assessment completed", "Add to cart", "Purchase"]
    }

    template["covenant"] = cov
    return template


def generate_canon(template, seed):
    canon = template["canon_of_expression"]
    core = seed.get("product_service", {}).get("core_offering", "")
    brand = seed.get("metadata", {}).get("brand_name", "")
    tokens = [t for t in words_from(core) if len(t) > 4]
    key_terms = list(dict.fromkeys(tokens))[:5]
    if brand:
        key_terms = [brand.lower()] + key_terms
    canon["lexicon"]["key_terms"] = key_terms or canon["lexicon"].get("key_terms", [])
    template["canon_of_expression"] = canon
    return template


def generate_choreography(template, seed):
    choreo = template["experience_choreography"]
    pain = seed.get("market_evidence", {}).get("pain_statement", "")
    if pain:
        choreo["golden_thread"]["validation"] = f"Every moment should move the customer from '{pain}' to calm certainty."
    template["experience_choreography"] = choreo
    return template


def generate_storefront(template, seed):
    store = template["storefront"]
    stack = load_json(ROOT_DIR / "registry/stack/headless-commerce-stack.json")
    stack_id = stack["stacks"][0]["id"]
    store["artifact_architecture"]["type_specification"]["technical_stack_id"] = stack_id
    store["artifact_architecture"]["type_specification"]["technical_stack"] = (
        "Next.js 16.x (App Router) + React 19 + TypeScript + Tailwind CSS 4.1.18 + "
        "Whop Embedded Checkout + Resend + Shopify Admin API (fulfillment only)"
    )

    ladder = build_value_ladder(seed)
    offer_map = {item["rung_id"]: item["offer"] for item in ladder}
    price_map = {item["rung_id"]: item["price"] for item in ladder}
    ladder_map = {
        "LADDER_BAIT": "bait",
        "LADDER_FRONTEND": "frontend",
        "LADDER_MIDDLE": "middle",
        "LADDER_BACKEND": "backend",
        "LADDER_CONTINUITY": "continuity",
    }
    value_build = store.get("value_ladder_build", {})
    for rung_id, key in ladder_map.items():
        if key not in value_build:
            continue
        if rung_id in offer_map:
            value_build[key]["offer"] = offer_map[rung_id]
        if rung_id in price_map and "price_point" in value_build[key]:
            value_build[key]["price_point"] = price_map[rung_id]
    store["value_ladder_build"] = value_build

    template["storefront"] = store
    return template


def generate_outputs():
    seed = load_json(ROOT_DIR / "brand-seed.json")

    generators = {
        "manifesto.template.json": generate_manifesto,
        "covenant.template.json": generate_covenant,
        "sumi-breath.template.json": lambda t, s: t,
        "tradeoff-ladder.template.json": lambda t, s: t,
        "canon.template.json": generate_canon,
        "choreography.template.json": generate_choreography,
        "storefront.template.json": generate_storefront,
    }

    for template_file, fn in generators.items():
        template_path = TEMPLATE_DIR / template_file
        if not template_path.exists():
            raise FileNotFoundError(f"Missing template: {template_path}")
        template = load_json(template_path)
        data = fn(template, seed)
        output_name = template_file.replace('.template', '')
        save_json(OUTPUT_DIR / output_name, data)


def main():
    os.chdir(ROOT_DIR)
    generate_outputs()
    print("Outputs generated from templates.")


if __name__ == "__main__":
    main()
