#!/usr/bin/env python3
"""Cost per nugget, bulk box against solo box, for every deal in the catalogue.

The data is NOT typed here: `per-nugget.csv` is generated from `shared/deals.ts`
by `renderPerPieceCsv()` in `scripts/deck-ledger.ts`, and `test/deck.test.ts`
fails if the committed CSV and the catalogue disagree. This script only draws it.

Run from the version dir:

    uv run --project ../../../../.anvil --with matplotlib python figures/src/per-nugget.py
"""

import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from anvil.lib.figures.palette import (  # noqa: E402
    ANVIL_INK,
    ANVIL_MUTED,
    ANVIL_NAVY,
    ANVIL_RULE,
    apply,
)

SRC = Path(__file__).parent
OUT = SRC.parent / "per-nugget.png"

apply()

with (SRC / "per-nugget.csv").open(newline="") as handle:
    rows = list(csv.DictReader(handle))

merchants = []
for row in rows:
    if row["merchant"] not in merchants:
        merchants.append(row["merchant"])

by_basket = {
    basket: [
        next(
            float(row["cents_per_piece"])
            for row in rows
            if row["merchant"] == merchant and row["basket"] == basket
        )
        for merchant in merchants
    ]
    for basket in ("solo", "bulk")
}

labels = {
    basket: [
        next(
            row["label"]
            for row in rows
            if row["merchant"] == merchant and row["basket"] == basket
        )
        for merchant in merchants
    ]
    for basket in ("solo", "bulk")
}

fig, ax = plt.subplots(figsize=(12, 7), dpi=120)
width = 0.36
positions = range(len(merchants))

solo_bars = ax.bar(
    [p - width / 2 for p in positions],
    by_basket["solo"],
    width,
    label="Solo box, one buyer",
    color=ANVIL_MUTED,
)
bulk_bars = ax.bar(
    [p + width / 2 for p in positions],
    by_basket["bulk"],
    width,
    label="20-piece box, split two ways",
    color=ANVIL_NAVY,
)

for basket, bars in (("solo", solo_bars), ("bulk", bulk_bars)):
    for index, bar in enumerate(bars):
        # Any literal $ in a matplotlib string needs escaping (\$) — a bare one
        # opens mathtext and the glyph is swallowed. Cents avoid the problem.
        ax.annotate(
            f"{bar.get_height():.1f}¢",
            (bar.get_x() + bar.get_width() / 2, bar.get_height()),
            textcoords="offset points",
            xytext=(0, 6),
            ha="center",
            fontsize=15,
            color=ANVIL_INK,
        )
        ax.annotate(
            labels[basket][index].replace("$", r"\$"),
            (bar.get_x() + bar.get_width() / 2, 1.5),
            rotation=90,
            ha="center",
            va="bottom",
            fontsize=11,
            color=ANVIL_RULE if basket == "bulk" else ANVIL_INK,
        )

ax.set_xticks(list(positions))
ax.set_xticklabels([m.replace("$", r"\$") for m in merchants], fontsize=17)
ax.set_ylabel("Cost per nugget (cents)", fontsize=15)
ax.set_ylim(0, max(by_basket["solo"]) * 1.22)
ax.legend(loc="upper right", fontsize=14, frameon=False)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.grid(axis="y", color=ANVIL_RULE, linewidth=0.8, alpha=0.7)
ax.set_axisbelow(True)

fig.tight_layout()
fig.savefig(OUT, dpi=200, bbox_inches="tight", transparent=True)
print(f"wrote {OUT}")
