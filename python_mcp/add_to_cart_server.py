from __future__ import annotations

import re
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("ecwid-cart-decision")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())).strip()


def _is_add_intent(text: str) -> bool:
    t = (text or "").lower()
    return bool(re.search(r"\b(add|put|place|throw|toss)\b", t) and re.search(r"\b(cart|bag)\b", t))


def _qty(text: str) -> int:
    m = re.search(r"\b(\d{1,2})\s*(x|qty|quantity)?\b", (text or "").lower())
    if not m:
        return 1
    q = int(m.group(1))
    return max(1, min(20, q))


def _score(user_text: str, product_name: str) -> int:
    u = _norm(user_text)
    p = _norm(product_name)
    if not u or not p:
        return 0
    if p in u:
        return 100 + len(p)
    ut = set(u.split())
    pt = set(p.split())
    return sum(1 for t in pt if t in ut)


def _ordinal_index(text: str, total: int) -> int | None:
    t = (text or "").lower()
    if "first" in t:
        return 0 if total > 0 else None
    if "second" in t:
        return 1 if total > 1 else None
    if "third" in t:
        return 2 if total > 2 else None
    if "last" in t:
        return total - 1 if total > 0 else None
    m = re.search(r"\b(\d+)\b", t)
    if m:
        i = int(m.group(1)) - 1
        if 0 <= i < total:
            return i
    return None


def _option_types(product: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for opt in product.get("options", []) or []:
        if isinstance(opt, dict):
            name = opt.get("name") or opt.get("title") or opt.get("optionName")
            if name:
                names.append(str(name))
    return names


def _user_specified_type(user_text: str, product: dict[str, Any]) -> bool:
    t = _norm(user_text)
    return any(_norm(n) and _norm(n) in t for n in _option_types(product))


def _pending_payload(candidates: list[dict[str, Any]], quantity: int, reason: str) -> dict[str, Any]:
    return {
        "type": "choose_for_cart",
        "reason": reason,
        "quantity": quantity,
        "options": [
            {
                "index": i + 1,
                "id": p.get("id"),
                "name": p.get("name"),
                "sku": p.get("sku"),
                "price": p.get("price"),
                "optionTypes": _option_types(p),
            }
            for i, p in enumerate(candidates)
        ],
    }


def _action(product: dict[str, Any], quantity: int) -> dict[str, Any] | None:
    product_id = product.get("id")
    if product_id is None:
        return None
    return {
        "type": "cart.add",
        "product": {
            "id": int(product_id),
            "quantity": quantity,
            "options": {},
            "sku": product.get("sku"),
            "name": product.get("name"),
        },
    }


@mcp.tool(
    name="add_to_cart",
    description=(
        "Resolve add-to-cart intent into structured frontend cart actions. "
        "Never mutates cart server-side. Returns cart_actions or pending chooser payload."
    ),
)
def add_to_cart(
    user_message: str,
    catalog_products: list[dict[str, Any]],
    pending: dict[str, Any] | None = None,
    message_history: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    products = [p for p in (catalog_products or []) if p.get("enabled", True)]

    if pending and pending.get("type") == "choose_for_cart":
        opts = pending.get("options") or []
        idx = _ordinal_index(user_message, len(opts))
        if idx is not None:
            picked = opts[idx]
            act = _action(picked, _qty(user_message))
            if act:
                return {
                    "message": f"Added {picked.get('name', 'item')} to your cart.",
                    "cart_actions": [act],
                    "pending": None,
                }

    if not _is_add_intent(user_message):
        return {
            "message": "No add-to-cart intent detected.",
            "cart_actions": [],
            "pending": None,
        }

    scored = []
    for p in products:
        name = str(p.get("name") or "")
        s = _score(user_message, name)
        if s > 0:
            scored.append((s, p))
    scored.sort(key=lambda x: x[0], reverse=True)
    candidates = [p for _, p in scored[:5]]

    if not candidates:
        return {
            "message": "Tell me the product type or exact product name to add to cart.",
            "cart_actions": [],
            "pending": None,
        }

    quantity = _qty(user_message)
    best = candidates[0]
    ambiguous = len(candidates) > 1
    requires_type = bool(_option_types(best)) and not _user_specified_type(user_message, best)

    if ambiguous or requires_type or best.get("id") is None:
        reason = (
            "Please choose the product type/options before adding to cart."
            if requires_type
            else "Please choose which product to add to cart."
        )
        pending_payload = _pending_payload(candidates, quantity, reason)
        lines = [reason]
        for o in pending_payload["options"][:4]:
            price = o.get("price")
            price_txt = f" - ${float(price):.2f}" if isinstance(price, (int, float)) else ""
            types = o.get("optionTypes") or []
            type_txt = f" | types: {', '.join(types)}" if types else ""
            lines.append(f"{o['index']}. {o.get('name','Product')}{price_txt}{type_txt}")
        lines.append("Reply with a number (for example, 1 or 2).")
        return {
            "message": "\n".join(lines),
            "cart_actions": [],
            "pending": pending_payload,
        }

    act = _action(best, quantity)
    if not act:
        pending_payload = _pending_payload([best], quantity, "Please confirm the exact product type.")
        return {
            "message": "Please confirm the product type before I add it to cart.",
            "cart_actions": [],
            "pending": pending_payload,
        }

    return {
        "message": f"Added {best.get('name', 'item')} to your cart.",
        "cart_actions": [act],
        "pending": None,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
