# Source of truth — the derived figure ledger

Snapshot of every figure the deck is allowed to print, as of `05b9799`
(2026-09-27). The Google sign-in merge did not touch `shared/deals.ts` or
`shared/economics.ts`, so these values are unchanged from `32dad69`.

**Regenerate rather than edit**: this is the output of
`formatLedger(buildLedger())` from `scripts/deck-ledger.ts`, which derives every
value from `shared/deals.ts` and `shared/economics.ts`.

Columns: ledger key · literal · `slide` when the deck is required to carry it ·
derivation.

```
mcd-nuggets-20.merchant                   McDonald's   slide  shared/deals.ts:mcd-nuggets-20 merchant
mcd-nuggets-20.bulk.price                 $7.99        slide  shared/deals.ts:mcd-nuggets-20 bulk.priceCents
mcd-nuggets-20.solo.price                 $6.99        slide  shared/deals.ts:mcd-nuggets-20 solo.priceCents
mcd-nuggets-20.solo.total                 $13.98       slide  analyzeSpread(mcd-nuggets-20).soloTotalCents — 2 solo boxes
mcd-nuggets-20.fee                        $0.99        slide  shared/deals.ts:mcd-nuggets-20 platformFeeCents
mcd-nuggets-20.collected                  $8.98        slide  settle(mcd-nuggets-20).totalCollectedCents — box + fee
mcd-nuggets-20.each.pay                   $4.49        slide  settle(mcd-nuggets-20).shares[0].payCents
mcd-nuggets-20.each.save                  $2.50        slide  settle(mcd-nuggets-20).shares[0].savingsCents
mcd-nuggets-20.each.save.pct              36%          slide  settle(mcd-nuggets-20).shares[0].savingsPct
mcd-nuggets-20.spread                     $5.99        slide  analyzeSpread(mcd-nuggets-20).grossSpreadCents
mcd-nuggets-20.spread.pct                 43%          slide  analyzeSpread(mcd-nuggets-20).grossMarginPct
mcd-nuggets-20.take.pct                   11%          slide  shared/deals.ts:mcd-nuggets-20 platformFeeCents / settle(mcd-nuggets-20).totalCollectedCents
mcd-nuggets-20.per.piece.bulk             $0.40        slide  shared/deals.ts:mcd-nuggets-20 bulk.priceCents / bulk.pieces, to the cent
mcd-nuggets-20.per.piece.solo             $0.70        slide  shared/deals.ts:mcd-nuggets-20 solo.priceCents / solo.pieces, to the cent
mcd-nuggets-20.per.piece.ratio            1.75×        slide  shared/deals.ts:mcd-nuggets-20 solo cost per piece / bulk cost per piece
mcd-nuggets-20.party.savings              $5.00        slide  settle(mcd-nuggets-20) — savingsCents summed across the party
mcd-nuggets-20.solo.vs.bulk.pct           87%          slide  shared/deals.ts:mcd-nuggets-20 solo.priceCents / bulk.priceCents — the inversion, as a share of the bigger box
mcd-nuggets-20.spread.to.buyers.pct       83%          slide  settle(mcd-nuggets-20) party savings / analyzeSpread(mcd-nuggets-20).grossSpreadCents
mcd-nuggets-20.spread.to.platform.pct     17%          slide  shared/deals.ts:mcd-nuggets-20 platformFeeCents / analyzeSpread(mcd-nuggets-20).grossSpreadCents
wendys-nuggets-20.merchant                Wendy's      slide  shared/deals.ts:wendys-nuggets-20 merchant
wendys-nuggets-20.bulk.price              $8.49        slide  shared/deals.ts:wendys-nuggets-20 bulk.priceCents
wendys-nuggets-20.solo.price              $7.29        slide  shared/deals.ts:wendys-nuggets-20 solo.priceCents
wendys-nuggets-20.solo.total              $14.58              analyzeSpread(wendys-nuggets-20).soloTotalCents — 2 solo boxes
wendys-nuggets-20.fee                     $0.99               shared/deals.ts:wendys-nuggets-20 platformFeeCents
wendys-nuggets-20.collected               $9.48               settle(wendys-nuggets-20).totalCollectedCents — box + fee
wendys-nuggets-20.each.pay                $4.74        slide  settle(wendys-nuggets-20).shares[0].payCents
wendys-nuggets-20.each.save               $2.55        slide  settle(wendys-nuggets-20).shares[0].savingsCents
wendys-nuggets-20.each.save.pct           35%                 settle(wendys-nuggets-20).shares[0].savingsPct
wendys-nuggets-20.spread                  $6.09        slide  analyzeSpread(wendys-nuggets-20).grossSpreadCents
wendys-nuggets-20.spread.pct              42%                 analyzeSpread(wendys-nuggets-20).grossMarginPct
wendys-nuggets-20.take.pct                10%                 shared/deals.ts:wendys-nuggets-20 platformFeeCents / settle(wendys-nuggets-20).totalCollectedCents
wendys-nuggets-20.per.piece.bulk          $0.42               shared/deals.ts:wendys-nuggets-20 bulk.priceCents / bulk.pieces, to the cent
wendys-nuggets-20.per.piece.solo          $0.73               shared/deals.ts:wendys-nuggets-20 solo.priceCents / solo.pieces, to the cent
wendys-nuggets-20.per.piece.ratio         1.72×               shared/deals.ts:wendys-nuggets-20 solo cost per piece / bulk cost per piece
wendys-nuggets-20.party.savings           $5.10               settle(wendys-nuggets-20) — savingsCents summed across the party
wendys-nuggets-20.solo.vs.bulk.pct        86%                 shared/deals.ts:wendys-nuggets-20 solo.priceCents / bulk.priceCents — the inversion, as a share of the bigger box
wendys-nuggets-20.spread.to.buyers.pct    84%                 settle(wendys-nuggets-20) party savings / analyzeSpread(wendys-nuggets-20).grossSpreadCents
wendys-nuggets-20.spread.to.platform.pct  16%                 shared/deals.ts:wendys-nuggets-20 platformFeeCents / analyzeSpread(wendys-nuggets-20).grossSpreadCents
bk-nuggets-20.merchant                    Burger King  slide  shared/deals.ts:bk-nuggets-20 merchant
bk-nuggets-20.bulk.price                  $5.99        slide  shared/deals.ts:bk-nuggets-20 bulk.priceCents
bk-nuggets-20.solo.price                  $4.49        slide  shared/deals.ts:bk-nuggets-20 solo.priceCents
bk-nuggets-20.solo.total                  $8.98               analyzeSpread(bk-nuggets-20).soloTotalCents — 2 solo boxes
bk-nuggets-20.fee                         $0.99               shared/deals.ts:bk-nuggets-20 platformFeeCents
bk-nuggets-20.collected                   $6.98               settle(bk-nuggets-20).totalCollectedCents — box + fee
bk-nuggets-20.each.pay                    $3.49        slide  settle(bk-nuggets-20).shares[0].payCents
bk-nuggets-20.each.save                   $1.00        slide  settle(bk-nuggets-20).shares[0].savingsCents
bk-nuggets-20.each.save.pct               22%                 settle(bk-nuggets-20).shares[0].savingsPct
bk-nuggets-20.spread                      $2.99        slide  analyzeSpread(bk-nuggets-20).grossSpreadCents
bk-nuggets-20.spread.pct                  33%                 analyzeSpread(bk-nuggets-20).grossMarginPct
bk-nuggets-20.take.pct                    14%                 shared/deals.ts:bk-nuggets-20 platformFeeCents / settle(bk-nuggets-20).totalCollectedCents
bk-nuggets-20.per.piece.bulk              $0.30               shared/deals.ts:bk-nuggets-20 bulk.priceCents / bulk.pieces, to the cent
bk-nuggets-20.per.piece.solo              $0.56               shared/deals.ts:bk-nuggets-20 solo.priceCents / solo.pieces, to the cent
bk-nuggets-20.per.piece.ratio             1.87×               shared/deals.ts:bk-nuggets-20 solo cost per piece / bulk cost per piece
bk-nuggets-20.party.savings               $2.00               settle(bk-nuggets-20) — savingsCents summed across the party
bk-nuggets-20.solo.vs.bulk.pct            75%                 shared/deals.ts:bk-nuggets-20 solo.priceCents / bulk.priceCents — the inversion, as a share of the bigger box
bk-nuggets-20.spread.to.buyers.pct        67%                 settle(bk-nuggets-20) party savings / analyzeSpread(bk-nuggets-20).grossSpreadCents
bk-nuggets-20.spread.to.platform.pct      33%                 shared/deals.ts:bk-nuggets-20 platformFeeCents / analyzeSpread(bk-nuggets-20).grossSpreadCents
volume.10.take                            $9.90        slide  shared/deals.ts:mcd-nuggets-20 platformFeeCents x 10 pairings
volume.10.savings                         $50.00       slide  settle(mcd-nuggets-20) party savings x 10 pairings
volume.25.take                            $24.75       slide  shared/deals.ts:mcd-nuggets-20 platformFeeCents x 25 pairings
volume.25.savings                         $125.00      slide  settle(mcd-nuggets-20) party savings x 25 pairings
volume.100.take                           $99.00       slide  shared/deals.ts:mcd-nuggets-20 platformFeeCents x 100 pairings
volume.100.savings                        $500.00      slide  settle(mcd-nuggets-20) party savings x 100 pairings
```

The auditor's cross-check: every money amount, percentage and ratio in
`deck.md` and `speaker-notes.md` must appear in the middle column above, and
every row marked `slide` must appear in `deck.md`. That check is mechanical —
`pnpm test` runs it (`test/deck.test.ts`), so this file is substrate for a human
reader rather than the enforcement itself.
