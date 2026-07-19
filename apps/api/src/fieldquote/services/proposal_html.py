"""Render a ProposalDocument to a self-contained HTML snapshot.

This is the archival + PDF source. The hosted web page renders the same
document object with its own interactive components (option selection, sign,
pay); this static HTML is what gets frozen to storage and turned into the PDF,
so the two must stay visually aligned (shared design tokens below)."""

import html

from fieldquote.services.proposal_render import ProposalDocument

_STYLE = """
:root { --ink:#0F172A; --orange:#EA580C; --line:#E2E8F0; --muted:#64748B; }
* { box-sizing: border-box; }
body { font-family: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
  color: var(--ink); margin: 0; background: #fff; }
.wrap { max-width: 720px; margin: 0 auto; padding: 32px 28px 64px; }
.band { background: var(--ink); color: #fff; padding: 28px; border-radius: 12px;
  border-left: 6px solid var(--orange); }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-size: 11px;
  color: var(--orange); font-weight: 700; }
h1 { font-size: 24px; margin: 6px 0 0; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); margin: 32px 0 8px; }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.row { display: flex; justify-content: space-between; padding: 10px 0;
  border-bottom: 1px solid var(--line); gap: 12px; }
.row .desc { flex: 1; }
.badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 6px;
  border-radius: 4px; text-transform: uppercase; letter-spacing: .05em; }
.badge.allow { background: #FEF3C7; color: #92400E; }
.badge.verify { background: #FFEDD5; color: #9A3412; }
.note { color: var(--muted); font-size: 13px; margin-top: 2px; }
.total { display: flex; justify-content: space-between; padding: 8px 0; }
.total.grand { font-size: 20px; font-weight: 700; border-top: 2px solid var(--ink);
  margin-top: 6px; padding-top: 12px; }
.deposit { background: #FFF7ED; border: 1px solid var(--orange); border-radius: 10px;
  padding: 16px; margin-top: 20px; display: flex; justify-content: space-between; }
.terms { font-size: 12px; color: var(--muted); border-top: 1px solid var(--line);
  margin-top: 40px; padding-top: 16px; line-height: 1.5; }
.disclaimer { font-style: italic; }
.tier { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 8px 0; }
.tier.sel { border-color: var(--orange); background: #FFF7ED; }
ul { margin: 6px 0; padding-left: 18px; }
"""


def _e(text: str) -> str:
    return html.escape(text or "")


def _line_row(description: str, meta: str, total: str, badge: str = "", note: str = "") -> str:
    badge_html = f'<span class="badge {badge}">{badge}</span> ' if badge else ""
    note_html = f'<div class="note">{_e(note)}</div>' if note else ""
    return (
        f'<div class="row"><div class="desc">{badge_html}{_e(description)}'
        f'<span class="note"> {_e(meta)}</span>{note_html}</div>'
        f'<div class="mono">${_e(total)}</div></div>'
    )


def render_html(doc: ProposalDocument) -> str:
    company = doc.company
    parts: list[str] = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width, initial-scale=1'>",
        f"<title>{_e(doc.title)} — {_e(company.name)}</title>",
        f"<style>{_STYLE}</style></head><body><div class='wrap'>",
        "<div class='band'>",
        f"<div class='eyebrow'>Proposal</div><h1>{_e(doc.title)}</h1>",
        f"<div style='margin-top:8px'>{_e(company.name)}",
    ]
    if company.license_number:
        parts.append(f" &middot; Lic. {_e(company.license_number)}")
    parts.append("</div></div>")

    if doc.client.name:
        parts.append(f"<h2>Prepared for</h2><div>{_e(doc.client.name)}")
        if doc.client.address:
            parts.append(f"<div class='note'>{_e(doc.client.address)}</div>")
        parts.append("</div>")

    if doc.intro_message:
        parts.append(f"<h2>Overview</h2><p>{_e(doc.intro_message)}</p>")
    if doc.scope_prose:
        prose = _e(doc.scope_prose).replace("\n", "<br>")
        parts.append(f"<h2>Scope of work</h2><p>{prose}</p>")

    parts.append("<h2>Line items</h2>")
    for line in doc.lines:
        badge = "allow" if line.line_type == "allowance" else (
            "verify" if line.line_type == "verify" else ""
        )
        meta = f"{line.qty} {line.unit or ''}".strip()
        parts.append(
            _line_row(line.description, meta, line.total, badge, line.note or "")
        )

    for group in doc.option_groups:
        parts.append(f"<h2>Options — {_e(group.base_description)}</h2>")
        for tier in group.tiers:
            sel = "sel" if tier.selected else ""
            parts.append(
                f"<div class='tier {sel}'><div class='row' style='border:0'>"
                f"<div class='desc'>{_e(tier.description)}</div>"
                f"<div class='mono'>${_e(tier.total)}</div></div></div>"
            )

    if doc.inclusions:
        parts.append("<h2>Included</h2><ul>")
        parts += [f"<li>{_e(item)}</li>" for item in doc.inclusions]
        parts.append("</ul>")
    if doc.exclusions:
        parts.append("<h2>Not included</h2><ul>")
        parts += [f"<li>{_e(item)}</li>" for item in doc.exclusions]
        parts.append("</ul>")

    parts.append("<h2>Totals</h2>")
    parts.append(
        f"<div class='total'><span>Subtotal</span>"
        f"<span class='mono'>${_e(doc.subtotal)}</span></div>"
    )
    parts.append(
        f"<div class='total'><span>Tax</span><span class='mono'>${_e(doc.tax)}</span></div>"
    )
    parts.append(
        f"<div class='total grand'><span>Total</span>"
        f"<span class='mono'>${_e(doc.total)}</span></div>"
    )
    parts.append(
        f"<div class='deposit'><span>{_e(doc.deposit_label)}</span>"
        f"<span class='mono'>${_e(doc.deposit_amount)}</span></div>"
    )

    parts.append("<div class='terms'>")
    if doc.company_terms:
        parts.append(f"<p>{_e(doc.company_terms)}</p>")
    parts.append(f"<p>Valid for {doc.validity_days} days.</p>")
    parts.append(f"<p class='disclaimer'>{_e(doc.platform_disclaimer)}</p>")
    parts.append("</div>")

    parts.append("</div></body></html>")
    return "".join(parts)
