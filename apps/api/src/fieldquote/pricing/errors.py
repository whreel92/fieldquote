"""Typed pricing errors. The service layer maps these onto the API error
envelope with user-safe messages; raw codes also feed the AI repair loop
(Phase 3) so the scoping model can retry with valid catalog codes."""

from decimal import Decimal


class PricingError(Exception):
    code = "pricing_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class UnknownAssemblyError(PricingError):
    code = "unknown_assembly"

    def __init__(self, assembly_code: str) -> None:
        super().__init__(f"Assembly '{assembly_code}' is not in the catalog.")
        self.assembly_code = assembly_code


class UnknownModifierError(PricingError):
    code = "unknown_modifier"

    def __init__(self, modifier_code: str) -> None:
        super().__init__(f"Modifier '{modifier_code}' is not in the catalog.")
        self.modifier_code = modifier_code


class ModifierNotAllowedError(PricingError):
    code = "modifier_not_allowed"

    def __init__(self, modifier_code: str, assembly_code: str) -> None:
        super().__init__(
            f"Modifier '{modifier_code}' is not allowed on assembly '{assembly_code}'."
        )
        self.modifier_code = modifier_code
        self.assembly_code = assembly_code


class UnknownSkuError(PricingError):
    code = "unknown_sku"

    def __init__(self, sku: str, assembly_code: str) -> None:
        super().__init__(f"SKU '{sku}' (assembly '{assembly_code}') is not in the catalog.")
        self.sku = sku
        self.assembly_code = assembly_code


class TierNotAvailableError(PricingError):
    code = "tier_not_available"

    def __init__(self, tier: str, assembly_code: str) -> None:
        super().__init__(f"Tier '{tier}' is not available on assembly '{assembly_code}'.")
        self.tier = tier
        self.assembly_code = assembly_code


class InvalidMarginError(PricingError):
    code = "invalid_margin"

    def __init__(self, pct: Decimal) -> None:
        super().__init__(f"Margin of {pct}% is not possible; margin must be below 100%.")
        self.pct = pct
