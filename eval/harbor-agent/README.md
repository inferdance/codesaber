# Harbor Agent Adapter for saber

This directory contains the Harbor `BaseAgent` adapter that wraps
`saber exec --json` for Terminal-Bench evaluation.

## Usage

```bash
# After installing harbor (pip install harbor)
export ANTHROPIC_API_KEY=sk-...

# Smoke test (10 tasks)
harbor run --dataset terminal-bench@2.0 \
    --agent-path eval/harbor-agent \
    --max-tasks 10 \
    --n-concurrent 4

# Full run
harbor run --dataset terminal-bench@2.0 \
    --agent-path eval/harbor-agent \
    --attempts 3
```

## Notes

- The adapter treats saber as a black-box CLI (correct Harbor pattern)
- Exit codes: 0=success, 1=failure, 124=timeout
- `--json` mode outputs engine events as JSONL on stdout
- Full output and traces are stored in the Harbor job directory
- M0 baseline: run `--max-tasks 10` first, record in `docs/eval/baseline-m0.md`
