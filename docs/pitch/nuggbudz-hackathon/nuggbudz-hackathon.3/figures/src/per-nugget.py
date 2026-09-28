#!/usr/bin/env python3
"""Cost per nugget, bulk box against solo box, for every deal in the catalogue.

The data is NOT typed here: `per-nugget.csv` is generated from `shared/deals.ts`
by `renderPerPieceCsv()` in `scripts/deck-ledger.ts`, and `test/deck.test.ts`
fails if the committed CSV and the catalogue disagree. This script only draws it.

Changed at `.3`: the chart is drawn in the NuggBudz palette rather than anvil's
shipped navy-on-white, because the deck moved to the `nuggbudz` theme and a
figure authored for a white slide is a white hole punched in a dark one. The
hexes below are the app's own tokens from `src/styles/globals.css`, the same
ones the theme's `:root` carries — the figure and the chrome cannot drift
without both being edited. `savefig(transparent=True)` is what lets the chart
sit on the slide rather than on a card.

Run from the version dir:

    python3 figures/src/per-nugget.py
"""

import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

# NuggBudz palette — src/styles/globals.css, verbatim.
CHROME = "#e8ecf7"  # display and body type
STEEL = "#8e9ac0"  # secondary type; the solo (expensive) series
RULE = "#453a86"  # hairlines and gridlines
NUGGET = "#ffb02e"  # the product; the bulk (cheap) series
VOID = "#0c0726"  # the slide ground, used for in-bar labels on amber

SRC = Path(__file__).parent
OUT = SRC.parent / "per-nugget.png"

plt.rcParams.update(
    {
        "font.family": ["Archivo", "Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
        "figure.figsize": (12, 7),
        "figure.dpi": 120,
        "savefig.dpi": 200,
        "savefig.transparent": True,
        "savefig.bbox": "tight",
        "axes.edgecolor": RULE,
        "axes.labelcolor": CHROME,
        "axes.titlecolor": CHROME,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "text.color": CHROME,
        "axes.grid": False,
        "grid.color": RULE,
        "grid.linewidth": 0.8,
        "xtick.color": STEEL,
        "ytick.color": STEEL,
        "xtick.labelcolor": CHROME,
        "ytick.labelcolor": STEEL,
        "legend.frameon": False,
    }
)

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
    color=STEEL,
)
bulk_bars = ax.bar(
    [p + width / 2 for p in positions],
    by_basket["bulk"],
    width,
    label="20-piece box, split two ways",
    color=NUGGET,
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
            color=NUGGET if basket == "bulk" else CHROME,
        )
        ax.annotate(
            labels[basket][index].split(" ")[0].replace("$", r"\$"),
            (bar.get_x() + bar.get_width() / 2, 1.5),
            rotation=90,
            ha="center",
            va="bottom",
            fontsize=14,
            # Inside an amber bar the label has to be the slide ground, not
            # chrome — the only place in the deck where that inversion happens.
            color=VOID if basket == "bulk" else VOID,
        )

ax.set_xticks(list(positions))
ax.set_xticklabels([m.replace("$", r"\$") for m in merchants], fontsize=17)
ax.set_ylabel("Cost per nugget (cents)", fontsize=15)
ax.set_ylim(0, max(by_basket["solo"]) * 1.22)
ax.legend(loc="upper right", fontsize=14, frameon=False, labelcolor=CHROME)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
ax.spines["left"].set_color(RULE)
ax.spines["bottom"].set_color(RULE)
ax.grid(axis="y", color=RULE, linewidth=0.8, alpha=0.9)
ax.set_axisbelow(True)

fig.tight_layout()
fig.savefig(OUT, dpi=200, bbox_inches="tight", transparent=True)
print(f"wrote {OUT}")
