# M0 Baseline Evaluation

> Date: 2026-08-20
> Engine: saber 0.1.0 (commit range T1-T8)
> Adapter: `eval/harbor-agent/`

## Status: Scaffolded — requires live API key + Docker to execute

The Harbor adapter (`eval/harbor-agent/saber_agent.py`) is ready. Running
the baseline requires:

1. Docker Desktop running (Harbor uses Docker for task environments)
2. An API key: `export SABER_ANTHROPIC_KEY=sk-...` (or `OPENAI_API_KEY`)
3. Harbor installed: `pip install harbor`
4. saber binary in PATH: `cargo build --release && cp target/release/saber /usr/local/bin/`

## Run Commands

```bash
# Smoke test (10 tasks)
harbor run --dataset terminal-bench@2.0 \
    --agent-path eval/harbor-agent \
    --max-tasks 10 \
    --n-concurrent 4 \
    --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY

# Results archive
harbor view jobs/<latest-job-id>
```

## Results

| Metric | Value |
|--------|-------|
| Tasks | 10 |
| Passed | _pending_ |
| Failed | _pending_ |
| Pass rate | _pending_ |
| Avg cost | _pending_ |
| Avg time | _pending_ |

### Per-task results

_Pending first live run._

## Notes

- Exit codes: 0=success, 1=failure, 124=timeout
- `--json` mode outputs engine events as JSONL on stdout
- Production uses SeatbeltExecutor (macOS) — sandbox writes restricted to
  workspace + data dir, all network denied
- The doom-loop defense (3 identical calls → abort) may reduce scores on
  repetitive tasks; this is intentional

## Known Limitations (M0)

- No compaction: long tasks may overflow context
- No steering in headless mode
- Single provider session (no failover)
- Direct executor on non-macOS (no sandbox)
