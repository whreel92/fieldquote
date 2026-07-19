"""Validate a ScopingOutput against the catalog snapshot.

Returns human/model-readable error strings; an empty list means the output is
safe to hand to the pricing engine. These strings are exactly what the repair
retry feeds back to the model.
"""

from fieldquote.ai.types import ScopingOutput
from fieldquote.pricing import Catalog


def validate_scoping(
    output: ScopingOutput, catalog: Catalog, job_type_codes: list[str]
) -> list[str]:
    errors: list[str] = []

    if output.outside_supported_scope:
        if output.assemblies:
            errors.append("outside_supported_scope is true but assemblies is not empty.")
        return errors

    if output.job_type_code not in job_type_codes:
        errors.append(
            f"job_type_code '{output.job_type_code}' is not one of: "
            f"{', '.join(job_type_codes)}"
        )

    for index, scoped in enumerate(output.assemblies):
        assembly = catalog.assemblies.get(scoped.code)
        if assembly is None:
            errors.append(f"assemblies[{index}]: code '{scoped.code}' is not in the catalog.")
            continue
        for modifier in scoped.modifiers:
            if modifier not in assembly.modifiers_allowed:
                errors.append(
                    f"assemblies[{index}]: modifier '{modifier}' is not allowed on "
                    f"'{scoped.code}' (allowed: {', '.join(assembly.modifiers_allowed) or 'none'})."
                )
        if scoped.selected_tier is not None:
            tiers = {tier.tier for tier in assembly.option_tiers}
            if not tiers:
                errors.append(
                    f"assemblies[{index}]: '{scoped.code}' has no option tiers but "
                    f"selected_tier was set."
                )
            elif scoped.selected_tier not in tiers:
                errors.append(
                    f"assemblies[{index}]: tier '{scoped.selected_tier}' not available on "
                    f"'{scoped.code}' (available: {', '.join(sorted(tiers))})."
                )

    if not output.scope_prose.strip():
        errors.append("scope_prose must not be empty.")

    return errors
