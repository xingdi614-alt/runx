# spam-risk-reviewer preflight report

## Summary

`spam-risk-reviewer` reviews a bounded campaign draft, list hygiene snapshot, and sender authentication posture before a separate governed `send-as` run can clear preflight.

The skill emits `send_risk_verdict{risk_level, preflight_clear, blockers, evidence_summary}` and explicitly does not send messages, read domain state, mint authority, or emit `runx.operational_proposal.v1`.

## Verification

- runx version: `runx-cli 0.6.13`
- local harness command: `runx harness skills/spam-risk-reviewer --json`
- harness cases: `low-risk-verified-sender`, `high-risk-incomplete-auth-poor-list`
- harness status: passed
- dogfood command: `runx skill skills/spam-risk-reviewer --json ...`
- dogfood receipt: `runx:receipt:sha256:96133678a23eb309486cf87fbcd86790ae0a909870706617d67941636fd1cd2f`
- verification verdict: valid receipt digest, valid content address, valid production Ed25519 signature, no findings

## Low-risk case

The low-risk fixture supplies passing SPF, DKIM, and DMARC; 45 sender warm-up days; bounce rate `0.004`; complaint rate `0.0002`; and list freshness `18` days. The verdict clears preflight with `risk_level: pass` and an empty blockers array.

## Stop case

The high-risk fixture supplies failed DKIM, only 3 sender warm-up days, bounce rate `0.12`, complaint rate `0.004`, stale list freshness of `220` days, and pressure-language content. The verdict returns `risk_level: hold`, `preflight_clear: false`, blocker reasons, and `needs_human` for the human approval lane.

## Composition with send-as

The verdict is dispatched by naming to `send-as`. A separate governed `send-as` run reads the verdict into `preflight_required` and `blockers`; a non-clear verdict prevents `send-as` from satisfying preflight and routes to human approval. The public send effect stays owned by `send-as`.
