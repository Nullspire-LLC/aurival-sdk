"""The README's pairing block is pinned to what `auth.pair` actually prints.

It was not. The README showed

    Pair this machine at aurival.com → Settings → Bots

      code         K7QP-2M4X
      fingerprint  018R-6WAC

    Waiting for approval…

and the SDK printed three entirely different lines. Nobody noticed because
nothing compared them: the block was prose, and prose does not run.

The direction of the check matters. It asserts README ⊆ OUTPUT — every line the
README promises really appears — and NOT the reverse, because the SDK may
legitimately print more (a `using <host>` line, an expiry restart) without the
quick-start needing to grow.
"""

from __future__ import annotations

import pathlib
import re
from typing import Any

import pytest

from aurival import auth

README = pathlib.Path(__file__).resolve().parents[1] / "README.md"

# The two lines that carry a generated value. The README shows an example code
# and fingerprint, so they are matched by their LABEL and shape rather than
# their literal text — pinning the example values would force both sides to
# normalise for no gain, and the label is the part the e2e regex depends on.
_VALUE_LINE = re.compile(r"^(aurival: (?:pairing code|fingerprint))\s+([0-9A-Z]{4}-[0-9A-Z]{4})$")


def _readme_pairing_block() -> list[str]:
    """The fenced block under `## First run`."""
    text = README.read_text(encoding="utf-8")
    start = text.index("## First run")
    fence = text.index("```", start)
    end = text.index("```", fence + 3)
    lines = [ln for ln in text[fence + 3 : end].splitlines() if ln.strip()]
    assert lines, "the README's First run section has an empty fenced block"
    return lines


class _PairHttp:
    """Answers `/v1/pair/start` then one approved `/v1/pair/poll`."""

    async def request(self, method: str, path: str, **kwargs: Any) -> dict:
        if path == "/v1/pair/start":
            return {
                "user_code": "K7QP-2M4X",
                "fingerprint": "018R-6WAC",
                "poll_token": "pt_1",
                "interval_ms": 1,
            }
        if path == "/v1/pair/poll":
            return {"state": "approved", "bot": "bot_1", "machine": "machine_1"}
        raise AssertionError(f"unexpected {method} {path}")


async def test_the_readme_pairing_block_is_what_the_sdk_prints() -> None:
    printed: list[str] = []
    await auth.pair(
        _PairHttp(),  # type: ignore[arg-type]
        machine_label="host",
        host="https://x",
        out=printed.append,
    )
    assert printed, "pair() printed nothing at all"

    for want in _readme_pairing_block():
        match = _VALUE_LINE.match(want)
        if match:
            label = match.group(1)
            # The label must appear followed by a code of the documented shape.
            assert any(
                _VALUE_LINE.match(line) and _VALUE_LINE.match(line).group(1) == label  # type: ignore[union-attr]
                for line in printed
            ), (
                f"the README promises a line beginning {label!r} and the SDK never printed one. "
                f"It printed: {printed}"
            )
            continue
        assert want in printed, (
            f"the README's pairing block promises the line {want!r}, which the SDK never prints. "
            f"It printed: {printed}. The block is a transcript, not prose — copy it from "
            f"aurival/auth.py's `out(...)` calls"
        )


def test_the_readme_block_carries_the_label_the_e2e_matches_on() -> None:
    """`test_e2e.py` finds the pairing code with `r"pairing code\\s+(…)"`, matched
    on the LABEL rather than the shape because the code and the fingerprint have
    the same XXXX-XXXX form. If the README and the printout are ever reworded
    together, that regex breaks and the e2e times out with no explanation — so
    the label is pinned here too, where the failure names the cause."""
    block = "\n".join(_readme_pairing_block())
    assert re.search(r"pairing code\s+[0-9A-Z]{4}-[0-9A-Z]{4}", block), block
    assert re.search(r"fingerprint\s+[0-9A-Z]{4}-[0-9A-Z]{4}", block), block


def test_the_starter_bot_init_writes_is_the_readme_quick_start() -> None:
    """`aurival init` scaffolds `bot.py`, and the developer who read the README
    must get the file the README showed them.

    Compared ignoring blank lines: the template is spaced for PEP 8 and the
    README block for prose, which is a real difference and the only permitted
    one. Anything else — a renamed command, a changed reply, a dropped decorator
    argument — is the docs and the tool disagreeing about the first thing a new
    developer ever runs.
    """
    from aurival.cli import BOT_TEMPLATE

    text = README.read_text(encoding="utf-8")
    fence = text.index("```python")
    end = text.index("```", fence + len("```python"))
    quick_start = text[fence + len("```python") : end]

    def significant(block: str) -> list[str]:
        return [ln.rstrip() for ln in block.splitlines() if ln.strip()]

    assert significant(BOT_TEMPLATE) == significant(quick_start), (
        "aurival init writes a bot.py that is not the README's quick-start bot.\n"
        f"init:   {significant(BOT_TEMPLATE)}\n"
        f"README: {significant(quick_start)}"
    )


def test_the_readme_documents_no_skip_path_for_the_fingerprint() -> None:
    # BA-R7: the owner compares the fingerprint and there is no way around it.
    # A README that offered one would be documenting a bypass we do not have.
    text = README.read_text(encoding="utf-8").lower()
    assert "compare the fingerprint" in text


@pytest.mark.parametrize("promised", ["AURIVAL_API", "AURIVAL_KEY_PATH"])
def test_the_readme_env_table_names_variables_that_exist(promised: str) -> None:
    assert promised in README.read_text(encoding="utf-8")
    source = (pathlib.Path(auth.__file__)).read_text(encoding="utf-8")
    bot_source = (pathlib.Path(auth.__file__).parent / "bot.py").read_text(encoding="utf-8")
    assert promised in source or promised in bot_source, (
        f"the README documents {promised} and no module reads it"
    )
