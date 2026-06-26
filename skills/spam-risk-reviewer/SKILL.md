---
name: spam-risk-reviewer
description: Review a bounded campaign draft, list hygiene snapshot, and sender authentication posture before a governed send-as run is allowed to clear preflight.
source:
  type: cli-tool
  command: node
  args:
    - run.mjs
  timeout_seconds: 30
  sandbox:
    profile: readonly
    cwd_policy: skill-directory
inputs:
  campaign_draft:
    type: json
    required: true
    description: campaign_draft{from, subject, content_digest, optional preview_text and content_summary}
  list_metadata:
    type: json
    required: true
    description: list_metadata{size, bounce_rate, complaint_rate, freshness_days or last_validated_at}
  sender_auth_posture:
    type: json
    required: true
    description: sender_auth_posture{spf_pass, dkim_pass, dmarc_pass, warm_up_days}
  policy:
    type: json
    required: false
    description: Optional thresholds for bounce, complaint, freshness, and warm-up days.
runx:
  category: ops
  input_resolution:
    required:
      - campaign_draft
      - list_metadata
      - sender_auth_posture
---

# Spam Risk Reviewer

## What this skill does

`spam-risk-reviewer` emits a bounded `send_risk_verdict` for a campaign or
message before any live delivery lane can run. It reads only supplied evidence:

- `campaign_draft{from, subject, content_digest}`;
- `list_metadata{size, bounce_rate, complaint_rate, freshness}`;
- `sender_auth_posture{spf_pass, dkim_pass, dmarc_pass, warm_up_days}`.

The output is a verdict packet:

```yaml
send_risk_verdict:
  risk_level: pass | hold
  preflight_clear: boolean
  blockers: array
  evidence_summary: array
```

The skill has no transport authority. It does not send, schedule, mutate
domains, mint permissions, or read provider state. It also emits no
`runx.operational_proposal.v1`.

## When to use this skill

Use it immediately before a governed `send-as` run when an agent needs a
deterministic spam-risk checkpoint from already-bounded evidence. The verdict
is dispatched by naming: a separate `send-as` run reads the verdict into its
`preflight_required` and `blockers`.

If `preflight_clear` is `false`, `send-as` cannot satisfy preflight and must
route to the human approval lane. The public send Effect remains owned by
`send-as`; live delivery is always a separate governed `send-as` run.

## When not to use this skill

Do not use it to:

- send or schedule a campaign;
- infer SPF, DKIM, DMARC, list health, or consent from missing evidence;
- approve a campaign with failed authentication;
- approve lists with bounce, complaint, or freshness metrics above policy;
- bypass human approval for borderline, missing, or high-risk evidence.

## Procedure

1. Require `campaign_draft`, `list_metadata`, and `sender_auth_posture`.
2. Confirm the campaign has a stable `content_digest`.
3. Require SPF, DKIM, and DMARC to pass.
4. Compare sender warm-up days to policy.
5. Compare list bounce rate, complaint rate, and freshness to policy.
6. Flag risky subject or summary language when visible.
7. Emit `risk_level: pass` and `preflight_clear: true` only when every check is
   grounded and clear.
8. Emit `risk_level: hold`, blocker reasons, and `needs_human` for missing,
   failed, stale, or borderline evidence.

## Default policy

- `max_bounce_rate`: `0.02`
- `max_complaint_rate`: `0.001`
- `max_freshness_days`: `90`
- `min_warm_up_days`: `14`

Callers may provide a stricter policy object. Missing policy uses the defaults.

## Harness cases

- `low-risk-verified-sender`: SPF/DKIM/DMARC pass, list metrics are clean, and
  the verdict clears preflight.
- `high-risk-incomplete-auth-poor-list`: DKIM fails, bounce and complaint rates
  exceed policy, the list is stale, warm-up is too short, and the verdict holds
  for human approval with no preflight clearance.

## Output fields

- `send_risk_verdict`: the named verdict consumed by `send-as`.
- `authentication_signals`: normalized SPF, DKIM, DMARC, and warm-up evidence.
- `list_hygiene_metrics`: normalized list size, bounce, complaint, freshness.
- `policy_thresholds`: thresholds used for the decision.
- `content_risk_flags`: visible content risks from the supplied draft fields.
- `needs_human`: whether and why the approval lane must review.
- `send_as_dispatch`: how the separate governed `send-as` run consumes this
  verdict.
- `authority_boundary`: explicit proof that this skill emits no operational
  proposal, mints no authority, reads no domain state, and sends nothing.
