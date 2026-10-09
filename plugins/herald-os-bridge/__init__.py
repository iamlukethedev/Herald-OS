"""Herald OS system bridge.

Registers the ``herald_os`` toolset: a narrow set of explicit, permission-tiered tools that let
Hermes act on the computer it is running on. Execution goes through a per-platform
``HostAdapter`` (macOS and Linux implemented; Windows is a typed stub), permissions through
``bridge.permissions`` (tiers, protected paths, the upstream approval gate), and every call is
recorded by ``bridge.audit``. ``system_os`` (registered from the same ``TOOL_SPECS`` table) drives
Herald OS Linux's ``herald-os`` CLI and answers with a clear failure on other platforms. The tools
are offered and run only in Herald OS's own sessions (``bridge.scope``).

Out-of-tree by design: the plugin uses only public plugin APIs (``register``,
``ctx.register_tool``, ``ctx.register_skill``, ``tools.approval.request_tool_approval``) and the
session variables Hermes binds for tools (``gateway.session_context.get_session_env``) so Herald
OS never patches the Hermes core.
"""

from __future__ import annotations

from pathlib import Path

from .bridge import scope as _scope
from .bridge import tools as _tools
from .bridge.host import host_available

_SKILLS_DIR = Path(__file__).parent / "skills"
# Skill name -> one-line description for the skills index.
SKILLS: dict[str, str] = {
    "herald-os": "How Hermes acts as the operating environment on this computer.",
    "diagnose-crash": "Explain why a program crashed from its crash report or core dump, and whether it is worth reporting.",
    "file-documents": "Find documents such as invoices and receipts among badly named files, read them (OCR for scans), name them clearly and file them where the person keeps them, with a plan they approve and an undo.",
    "herald-os-tailor": "Change Herald OS itself: Herald OS widgets (menu bar, Overview, their own window), themes, fonts, the wallpaper, the menu bar, control-menu entries, branding, keybindings, settings and routines.",
    "herald-canvas": "Make and edit pictures in Herald Canvas: posters, banners, collages, photo fixes; the canvas tool, design habits, the .comp format and every adjustment setting.",
    "herald-docs": "Write and edit documents in Herald Docs: drafts from a brief, templates, rewriting marked text, formatting, tables, pictures, a sheet's figures in a report, saving and PDFs.",
    "herald-sheets": "Work in Herald Sheets: formulas from a description, explaining formulas, filling a column from examples, cleaning data, what stands out, building a workbook, sorting, filtering, saving.",
}


def _check_available() -> bool:
    """What the model sees: the host adapter must exist for this platform, the bridge must not be
    disabled in config, and the session must be Herald OS's own."""
    return host_available() and _tools.bridge_enabled() and _scope.offered()


def register(ctx) -> None:
    try:
        from tools.registry import no_cache_check_fn
    except ImportError:  # Older runtimes cache the verdict for 30 seconds, across sessions.
        pass
    else:
        no_cache_check_fn(_check_available)
    for spec in _tools.TOOL_SPECS:
        ctx.register_tool(
            name=spec.name,
            toolset="herald_os",
            schema=spec.schema,
            handler=_scope.herald_only(spec.name, spec.handler, _tools.bridge_enabled),
            check_fn=_check_available,
            emoji=spec.emoji,
            description=spec.schema["description"],
        )
    if not hasattr(ctx, "register_skill"):
        return
    for name, description in SKILLS.items():
        skill_md = _SKILLS_DIR / name / "SKILL.md"
        if skill_md.exists():
            ctx.register_skill(name, skill_md, description=description)
