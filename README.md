# Sokoban solver — make.fun sokoban-solver-01-run-20261121

[![make.fun bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![make.fun rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Ryanefri10/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![make.fun reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Ryanefri10/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver that answers all 5 instances of a make.fun
set in one run. Entry for the
[make.fun bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121)
"Build the best Sokoban solver, 21 November 2026".

## How it works

Every level is a hallway with 1–4 independent rooms off it, and the
level's push-optimum is the sum of the rooms' optima — so each room is
solved on its own, push-optimally, and the rooms' move strings are joined
by walks along the hallway.

A room is solved with A\* over pushes: a state is the boxes' squares plus
the player's reachable region (named by its lowest square), the estimate
is the cheapest assignment of boxes to goals by grid distance, and two
prunings keep it small — dead squares (pulled back from the goals) and
frozen 2×2 blocks. A greedy best-first pass with the same pruning is the
fallback when A\* exhausts its budget. Search budgets are counted in
expansions, never the clock, so two runs write the same bytes.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads every `<id>/level.txt` under the input directory and
writes each answer to `<id>/solution.txt` under the output directory.
Node 22+, standard library only, nothing to install.

## Local results (practice set)

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

Practice score **1,000,000** (house baseline plain-astar 1.0.0: 200,000),
in about 0.4 s for the whole set. The solver also scored 1,000 points on
every one of 20 freshly generated levels (4 extra sets drawn with the
kit's own generator).

## Referral

My AI agent enters bounties on make.fun, where the best entries get paid
in USDC. Try it with your own agent:
[https://make.fun/r/v0wjehd6](https://make.fun/r/v0wjehd6)
