# Spec-Kit Cost & Effectiveness Report

Runs analyzed: **1**
- /home/max/git/kanix/specs/admin/run-log.jsonl

## Grand total

- **Events processed**: 782
- **Agent completions**: 300
- **Total tokens**: 811.93M (in: 807.66M, out: 4.27M)
- **Estimated cost**: **$2,674**
- **Total agent wall-clock**: 39h34m

## Cost & tokens by model

| Model | Events | Input (fresh) | Cache read | Cache create | Output | Total tok | Cost | % of $ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| opus | 292 | 469.28M (468.67M legacy) | 319.11M | 9.32M | 4.19M | 801.91M | $2,669 | 99.8% |
| sonnet | 8 | 8.1k | 9.59M | 347.2k | 76.1k | 10.02M | $5.35 | 0.2% |

## Cost & tokens by phase

Grouped by task-id prefix so you can see where the money goes.

| Phase | Events | Tokens | Cost | Cost % | Avg tok/event | Avg $/event |
|---|---:|---:|---:|---:|---:|---:|
| task | 216 | 688.17M | $2,131 | 79.7% | 3.19M | $9.87 |
| validate-review | 28 | 54.02M | $258 | 9.7% | 1.93M | $9.22 |
| e2e-explore (legacy) | 10 | 34.17M | $173 | 6.5% | 3.42M | $17.34 |
| e2e-research | 19 | 9.31M | $48.78 | 1.8% | 490.1k | $2.57 |
| e2e-fix | 8 | 12.20M | $38.50 | 1.4% | 1.53M | $4.81 |
| e2e-verify | 7 | 3.82M | $14.80 | 0.6% | 545.5k | $2.11 |
| e2e-executor | 7 | 8.94M | $4.73 | 0.2% | 1.28M | $0.68 |
| e2e-other | 1 | 484.3k | $2.52 | 0.1% | 484.3k | $2.52 |
| e2e-planner | 4 | 807.3k | $2.16 | 0.1% | 201.8k | $0.54 |

## Phase × model matrix (cost)

Shows where each model is actually being spent. Useful for checking
whether model-choice changes (e.g. verify → Sonnet) landed correctly.

| Phase | Opus | Sonnet | Haiku | Total |
|---|---:|---:|---:|---:|
| task | $2,131 | — | — | $2,131 |
| validate-review | $258 | — | — | $258 |
| e2e-explore (legacy) | $173 | — | — | $173 |
| e2e-research | $48.78 | — | — | $48.78 |
| e2e-fix | $38.50 | — | — | $38.50 |
| e2e-verify | $14.19 | $0.61 | — | $14.80 |
| e2e-executor | — | $4.73 | — | $4.73 |
| e2e-other | $2.52 | — | — | $2.52 |
| e2e-planner | $2.16 | — | — | $2.16 |

## Effectiveness signals

- **E2E loop spend**: $285 (69.73M tok) across 7 phases
- **Planner/executor split**: planner $2.16, executor $4.73 (combined $6.89)
- **Legacy explore baseline**: $173 — compare against combined planner+executor
- **Fix vs verify**: fix $38.50, verify $14.80
- **Executor Opus%**: 0% (target: 0% — executor should be Sonnet)
- **Verify Opus%**: 96% (target: 0% after 2026-04-19 change)

> **Legacy data note**: 468.67M input tokens (58%) predate the cache breakdown. Priced as fresh input (no cache discount) — may overestimate cost for agents with high cache hit rates.

> **Assumed-Opus note**: 198 of 300 completions (66%) have no `model` field and were assumed Opus (legacy default before 2026-04-19).