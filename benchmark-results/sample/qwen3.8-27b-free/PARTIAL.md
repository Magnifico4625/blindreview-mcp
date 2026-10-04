# qwen3.8-27b:free — incomplete (2026-10-04)

Same config as the other labels (reasoning_effort medium, 6000 tokens/call, 24000/review, timeout 240 s, seed 42), throttled with `--max-rpm 5 --concurrency 2 --retries 5 --stop-on-rate-limit`.

The free endpoint (single upstream provider) answered most requests with HTTP 429 / timeouts: in ~1.5 h only **9 of 375** reviews finished (log: `partial-run.stdout.txt`, records: `checkpoint.jsonl`). The first session stopped on a persistent 429 (resumable stop); the resumed session was stopped manually as impractical (~6 reviews/hour → ~2 days for a full run). No report or metrics are computed from 9 records.

Resume later (same config) with:

    npm run benchmark -- --label qwen3.8-27b-free --model qwen/qwen3.8-27b:free --base-url https://openrouter.ai/api/v1 \
      --reasoning-effort medium --max-tokens 6000 --max-review-tokens 24000 --runs 3 --timeout 240000 --seed 42 \
      --concurrency 2 --max-rpm 5 --retries 5 --stop-on-rate-limit --resume --out benchmark-results/sample
