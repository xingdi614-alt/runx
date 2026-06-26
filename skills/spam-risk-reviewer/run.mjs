import fs from "node:fs";

const inputs = readInputs();
const campaignDraft = objectValue(inputs.campaign_draft, "campaign_draft");
const listMetadata = objectValue(inputs.list_metadata, "list_metadata");
const senderAuthPosture = objectValue(inputs.sender_auth_posture, "sender_auth_posture");
const policy = normalizePolicy(inputs.policy);

const blockers = [];
const evidenceSummary = [];
const contentRiskFlags = [];

const from = stringValue(campaignDraft.from);
const subject = stringValue(campaignDraft.subject);
const contentDigest = stringValue(campaignDraft.content_digest);

if (!from) blockers.push("campaign_draft.from is required");
if (!subject) blockers.push("campaign_draft.subject is required");
if (!contentDigest) blockers.push("campaign_draft.content_digest is required");

const authSignals = {
  spf_pass: booleanValue(senderAuthPosture.spf_pass),
  dkim_pass: booleanValue(senderAuthPosture.dkim_pass),
  dmarc_pass: booleanValue(senderAuthPosture.dmarc_pass),
  warm_up_days: numberValue(senderAuthPosture.warm_up_days),
};

for (const signal of ["spf_pass", "dkim_pass", "dmarc_pass"]) {
  if (authSignals[signal] !== true) {
    blockers.push(`${signal.replace("_pass", "").toUpperCase()} does not pass`);
  }
}

if (!Number.isFinite(authSignals.warm_up_days)) {
  blockers.push("sender_auth_posture.warm_up_days is required");
} else if (authSignals.warm_up_days < policy.min_warm_up_days) {
  blockers.push(`sender warm-up ${authSignals.warm_up_days}d is below policy minimum ${policy.min_warm_up_days}d`);
}

const listSignals = {
  size: numberValue(listMetadata.size),
  bounce_rate: numberValue(listMetadata.bounce_rate),
  complaint_rate: numberValue(listMetadata.complaint_rate),
  freshness_days: freshnessDays(listMetadata),
};

if (!Number.isFinite(listSignals.size) || listSignals.size <= 0) {
  blockers.push("list_metadata.size must be a positive number");
}
if (!Number.isFinite(listSignals.bounce_rate)) {
  blockers.push("list_metadata.bounce_rate is required");
} else if (listSignals.bounce_rate > policy.max_bounce_rate) {
  blockers.push(`bounce_rate ${listSignals.bounce_rate} exceeds policy maximum ${policy.max_bounce_rate}`);
}
if (!Number.isFinite(listSignals.complaint_rate)) {
  blockers.push("list_metadata.complaint_rate is required");
} else if (listSignals.complaint_rate > policy.max_complaint_rate) {
  blockers.push(`complaint_rate ${listSignals.complaint_rate} exceeds policy maximum ${policy.max_complaint_rate}`);
}
if (!Number.isFinite(listSignals.freshness_days)) {
  blockers.push("list_metadata.freshness_days or last_validated_at is required");
} else if (listSignals.freshness_days > policy.max_freshness_days) {
  blockers.push(`list freshness ${listSignals.freshness_days}d exceeds policy maximum ${policy.max_freshness_days}d`);
}

contentRiskFlags.push(...detectContentRisk(subject, campaignDraft));

if (contentRiskFlags.length > 0 && blockers.length === 0) {
  blockers.push(`content risk requires human approval: ${contentRiskFlags.join(", ")}`);
}

evidenceSummary.push(`auth spf=${authSignals.spf_pass} dkim=${authSignals.dkim_pass} dmarc=${authSignals.dmarc_pass}`);
evidenceSummary.push(`warm_up_days=${Number.isFinite(authSignals.warm_up_days) ? authSignals.warm_up_days : "missing"}`);
evidenceSummary.push(`list size=${Number.isFinite(listSignals.size) ? listSignals.size : "missing"} bounce_rate=${Number.isFinite(listSignals.bounce_rate) ? listSignals.bounce_rate : "missing"} complaint_rate=${Number.isFinite(listSignals.complaint_rate) ? listSignals.complaint_rate : "missing"} freshness_days=${Number.isFinite(listSignals.freshness_days) ? listSignals.freshness_days : "missing"}`);
evidenceSummary.push(`content_digest=${contentDigest || "missing"}`);

const preflightClear = blockers.length === 0;
const riskLevel = preflightClear ? "pass" : "hold";

const sendRiskVerdict = {
  risk_level: riskLevel,
  preflight_clear: preflightClear,
  blockers,
  evidence_summary: evidenceSummary,
};

const result = {
  send_risk_verdict: sendRiskVerdict,
  authentication_signals: authSignals,
  list_hygiene_metrics: listSignals,
  policy_thresholds: policy,
  content_risk_flags: contentRiskFlags,
  needs_human: {
    required: !preflightClear,
    lane: !preflightClear ? "human_approval" : null,
    reasons: blockers,
  },
  send_as_dispatch: {
    target_skill: "send-as",
    dispatch_by_naming: true,
    preflight_required: true,
    preflight_clear: preflightClear,
    blockers,
    public_send_effect_owner: "send-as",
    live_delivery_authority: "separate_governed_send_as_run",
    note: preflightClear
      ? "A separate governed send-as run may read this verdict into its preflight evidence."
      : "A separate governed send-as run cannot satisfy preflight with this verdict and must route to human approval.",
  },
  authority_boundary: {
    emits_operational_proposal: false,
    mints_authority: false,
    reads_domain_state: false,
    sends_messages: false,
  },
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    campaign_draft: parseInputValue(process.env.RUNX_INPUT_CAMPAIGN_DRAFT),
    list_metadata: parseInputValue(process.env.RUNX_INPUT_LIST_METADATA),
    sender_auth_posture: parseInputValue(process.env.RUNX_INPUT_SENDER_AUTH_POSTURE),
    policy: parseInputValue(process.env.RUNX_INPUT_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function objectValue(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function normalizePolicy(raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    max_bounce_rate: finiteOr(input.max_bounce_rate, 0.02),
    max_complaint_rate: finiteOr(input.max_complaint_rate, 0.001),
    max_freshness_days: finiteOr(input.max_freshness_days, 90),
    min_warm_up_days: finiteOr(input.min_warm_up_days, 14),
  };
}

function finiteOr(value, fallback) {
  const number = numberValue(value);
  return Number.isFinite(number) ? number : fallback;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return null;
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function freshnessDays(metadata) {
  const explicit = numberValue(metadata.freshness_days);
  if (Number.isFinite(explicit)) return explicit;
  const lastValidated = stringValue(metadata.last_validated_at);
  if (!lastValidated) return NaN;
  const parsed = Date.parse(lastValidated);
  if (!Number.isFinite(parsed)) return NaN;
  return Math.max(0, Math.ceil((Date.now() - parsed) / 86_400_000));
}

function detectContentRisk(subject, draft) {
  const text = [
    subject,
    stringValue(draft.preview_text),
    stringValue(draft.content_summary),
  ].filter(Boolean).join(" ").toLowerCase();
  const flags = [];
  if (matches(text, ["password", "seed phrase", "private key", "wire transfer", "bank login"])) {
    flags.push("sensitive-credential-or-payment-language");
  }
  if (matches(text, ["guaranteed", "risk free", "free money", "act now", "limited time!!!"])) {
    flags.push("spammy-claim-or-pressure-language");
  }
  if (matches(text, ["viagra", "casino", "crypto airdrop", "loan approval"])) {
    flags.push("high-risk-spam-topic");
  }
  return flags;
}

function matches(text, needles) {
  return needles.some((needle) => text.includes(needle));
}
