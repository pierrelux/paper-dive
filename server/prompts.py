"""Prompt construction for explanation requests."""

from __future__ import annotations

SYSTEM_INSTRUCTIONS = """\
You explain one specific part of a research paper to someone who is reading that \
paper right now.

The reader has selected a single thing — a passage, an equation, or a figure — and \
wants that one thing explained. Everything else you are given is context, not the \
subject of the answer.

How to answer:

- Lead with the answer. The first sentence says what the selected thing is or does, \
in plain language. No preamble, no restating the selection back at the reader.
- Then unpack it.
  - For math: say what each symbol denotes, using the paper's own notation; what the \
expression computes; and why it has this particular form. Walk any non-obvious step.
  - For a figure or table: what is on each axis, what the visual encoding means, and \
what the reader is supposed to conclude from it. Name the specific features that carry \
the claim.
  - For prose: what claim is being made, what it rests on, and what it rules out.
- Give the intuition explicitly — the one sentence that says what this is really doing, \
stripped of formalism.
- Flag what a careful reader would stumble on: unstated assumptions, notation defined \
elsewhere in the paper, a step that looks like it skips something, a claim that is \
weaker or stronger than it first appears.
- If the selection is a standard object under a paper-specific name, say so ("this is \
a softmax over actions", "this is the ELBO with the entropy term written out").
- Write math in LaTeX, inline as $...$ and display as $$...$$.
- Do not summarize the paper, and do not recap surrounding sections beyond what the \
selection needs.
- If the provided context is not enough to explain the selection confidently, say what \
is missing instead of guessing. Distinguish what the paper states from what you are \
inferring.
"""

LEVELS = {
    "simple": (
        "Reader level: smart, but new to this subfield. Prefer plain language and one "
        "concrete example over formalism. Define jargon on first use. Aim for under "
        "200 words."
    ),
    "standard": (
        "Reader level: knows the field's fundamentals but not this paper. Assume "
        "standard background, explain what is specific to this work. Aim for 150-350 "
        "words."
    ),
    "deep": (
        "Reader level: expert. Go into derivation steps, edge cases, failure modes, and "
        "how this connects to standard results in the literature. Length as the content "
        "requires."
    ),
}


def system_blocks(level: str, paper_title: str, frontmatter: str) -> list[dict]:
    """System prompt: stable instructions, then the paper's front matter (cached)."""
    instructions = SYSTEM_INSTRUCTIONS + "\n" + LEVELS.get(level, LEVELS["standard"])

    paper = "<paper>\n"
    if paper_title:
        paper += f"Title: {paper_title}\n\n"
    if frontmatter:
        paper += "Opening pages (title, abstract, introduction as extracted):\n"
        paper += frontmatter.strip() + "\n"
    paper += "</paper>\n\nThis is the paper the reader is reading. Use it for context."

    return [
        {"type": "text", "text": instructions},
        {"type": "text", "text": paper, "cache_control": {"type": "ephemeral"}},
    ]


def _context_block(page: int, before: str, current: str, after: str) -> str:
    parts = [f'<context page="{page}">']
    if before.strip():
        parts.append(f"--- page {page - 1} (preceding) ---\n{before.strip()}")
    parts.append(f"--- page {page} (the page being read) ---\n{current.strip()}")
    if after.strip():
        parts.append(f"--- page {page + 1} (following) ---\n{after.strip()}")
    parts.append("</context>")
    return "\n\n".join(parts)


def first_user_content(target: dict, context: dict) -> list[dict]:
    """Build the opening user turn: page context, the selection, and the ask."""
    page = target.get("page", 1)
    blocks: list[dict] = []

    if target["kind"] == "region" and target.get("image"):
        blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": target["image"],
                },
            }
        )

    text = _context_block(
        page,
        context.get("before", ""),
        context.get("current", ""),
        context.get("after", ""),
    )

    if target["kind"] == "region":
        text += (
            f'\n\n<selection kind="region" page="{page}">\n'
            "The reader has selected a region of this page; it is attached as an image. "
            "It may be a figure, a table, a displayed equation, or a block of text. "
            "The page text above is the surrounding context — use it to find the "
            "caption and any definitions the region depends on.\n"
            "</selection>\n\n"
            "Explain what is in the selected region."
        )
    else:
        selection = (target.get("text") or "").strip()
        text += (
            f'\n\n<selection kind="text" page="{page}">\n{selection}\n</selection>\n\n'
            "Explain the selection. (It was extracted from the PDF text layer, so "
            "spacing, ligatures, and math may be mangled — read it against the page "
            "context above.)"
        )

    blocks.append({"type": "text", "text": text})
    return blocks


DIVE_TEMPLATE = """\
From your explanation above, explain this specifically:

"{phrase}"

Same rules as before, and:
- Explain it as it is used right here, in this paper's context — not in general terms \
that could apply anywhere.
- Take the rest of your explanation above as already understood. Do not restate it.
- If this is a standard concept, name it and give the general meaning in one line, then \
spend the rest on what it is doing in this particular place.
- Keep it shorter than the explanation above unless the reader asks for more."""


def compose_dive(phrase: str) -> str:
    return DIVE_TEMPLATE.format(phrase=phrase.strip())


def build_messages(target: dict, context: dict, turns: list[dict], question: str | None) -> list[dict]:
    messages: list[dict] = [{"role": "user", "content": first_user_content(target, context)}]
    for turn in turns:
        role = "assistant" if turn.get("role") == "assistant" else "user"
        content = (turn.get("text") or "").strip()
        if content:
            messages.append({"role": role, "content": content})
    if question and question.strip():
        messages.append({"role": "user", "content": question.strip()})
    return messages
