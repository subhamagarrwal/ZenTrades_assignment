# Clara Automation

Turns raw sales demo calls and onboarding recordings into fully configured Retell AI voice agents — with structured versioning, field-level diff tracking, and batch processing across multiple accounts.

---

## Architecture & Data Flow

```
Audio / Transcript
       │
       ▼
transcribeAudio.js ──► Groq Whisper API ──► transcript.txt
                            (429?)
                       whisper.cpp (CPU)          ← local fallback
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ Pipeline A  (scripts/v1/runDemo.js)                      │
│                                                          │
│  extractMemo.js                                          │
│    └─ chunks transcript at (mm:ss) timestamp boundaries  │
│    └─ extract pass:  llama-3.3-70b-versatile             │
│    └─ compose pass:  openai/gpt-oss-120b                 │
│    └─ validates result against AccountMemoSchema (Zod)   │
│                                                          │
│  generateAgentDraftSpec.js → mapAgentSpec.js             │
│    └─ maps memo fields to Retell agent + LLM config      │
│    └─ upserts agent via Retell SDK                       │
│                                                          │
│  Output: outputs/accounts/<slug>/v1/                     │
│    memo.json │ agentDraftSpec.json │ agent_id.json        │
└──────────────────────────────────────────────────────────┘
       │
       ▼  (after onboarding call)
┌──────────────────────────────────────────────────────────┐
│ Pipeline B  (scripts/v2/runOnboarding.js)                │
│                                                          │
│  extractOnboardingUpdate.js                              │
│    └─ extracts only new/changed fields from transcript   │
│                                                          │
│  Merge strategy                                          │
│    └─ patch applied on top of v1 memo                    │
│    └─ onboarding values win on conflict                  │
│    └─ null v1 fields filled in where transcript has them │
│                                                          │
│  generateChangelog()                                     │
│    └─ field-by-field diff: before / after / note         │
│    └─ appended to changelog/<slug>.json                  │
│                                                          │
│  Output: outputs/accounts/<slug>/v2/                     │
│    memo.json │ agentDraftSpec.json                       │
│    changes.json │ onboarding_update.json                 │
└──────────────────────────────────────────────────────────┘
       │
       ▼
  Asana task created for human review
  Web UI diff viewer shows v1 → v2 changelog
```

**Transport layer:** `server.js` is a raw Node `http` server. The web UI uses Server-Sent Events so pipeline logs stream to the browser in real time. n8n calls the `/run` and `/onboard` JSON endpoints for batch orchestration.

**Rate-limit fallback:** On Groq 429, the client retries twice (honouring the `retry-after` wait time from the error body), then falls back to local CPU inference — whisper.cpp for STT and llama.cpp (Qwen2.5-1.5B Q4_K_M) for LLM. Models are downloaded on first use and cached in a Docker volume.

---

## How to Run Locally

### 1. Prerequisites

- Node.js 20+
- A `.env` file in the project root:

```env
GROQ_API_KEY=gsk_...        # required — free tier works
RETELL_API_KEY=key_...      # optional — skip to only generate specs locally
ASANA_TOKEN=1/...           # optional — skip to disable review task creation
MODELS_DIR=/app/models      # Docker only — local model cache dir
```

### 2. Install and start

```bash
npm install
npm start        # http://localhost:3000
```

The web dashboard at `http://localhost:3000` lets you run both pipelines, stream logs, and view the diff viewer interactively. No separate build step needed.

### 3. Docker (Clara + n8n, one command)

```bash
cd docker
docker-compose up --build
```

| Service | URL | Credentials |
|---------|-----|-------------|
| Clara server | `http://localhost:3000` | — |
| n8n | `http://localhost:5678` | admin / clara2025 |

Import `workflows/batch_all_accounts.json` into n8n and hit **Execute Workflow** to run batch processing.

### 4. CLI (no server)

Both pipeline scripts accept a transcript `.txt` or an audio file directly. If audio is given, transcription runs automatically first.

```bash
# Pipeline A — demo call → v1
node scripts/transcribeAudio.js "inputs/bens-electric/audio/demo/recording.mp3"
node scripts/v1/runDemo.js "bens-electric/transcripts/demo/transcript.txt" bens-electric

# Pipeline B — onboarding call → v2
node scripts/transcribeAudio.js "inputs/bens-electric/audio/onboarding/onboarding.mp3"
node scripts/v2/runOnboarding.js "bens-electric/transcripts/onboarding/transcript.txt" bens-electric
```

---

## Plugging In Dataset Files

The `inputs/` directory is the only thing you need to populate. Use this structure:

```
inputs/
└── <company-slug>/
    ├── audio/
    │   ├── demo/
    │   │   └── recording.mp3       ← mp3 wav m4a ogg flac webm aac
    │   └── onboarding/
    │       └── call.mp3
    └── transcripts/
        ├── demo/
        │   └── transcript.txt      ← plain text; (mm:ss) timestamps optional
        └── onboarding/
            └── transcript.txt
```

**Rules:**
- `<company-slug>` is the account identifier everywhere — use lowercase with hyphens (e.g. `bens-electric`).
- Provide audio **or** a transcript — not both required. Transcription writes `transcript.txt` automatically and skips re-transcription on re-runs.
- Timestamps in `(mm:ss)` format enable smarter LLM chunking at natural call boundaries. They are not required.
- For Pipeline B you can also supply structured form data as JSON via the web UI or `/onboard` API — it gets merged on top of whatever the transcript produced.
- **Pipeline A must be run before Pipeline B.** Pipeline B loads `v1/memo.json` as its baseline; if it doesn't exist, the script exits with an error.

---

## Where Outputs Are Stored

```
outputs/accounts/<company-slug>/
├── v1/
│   ├── memo.json              ← extracted business profile (Zod-validated)
│   ├── agentDraftSpec.json    ← Retell-ready agent + LLM configuration
│   ├── agent_id.json          ← Retell agent ID (only if RETELL_API_KEY set)
│   └── llm_id.json            ← Retell LLM ID  (only if RETELL_API_KEY set)
└── v2/
    ├── memo.json              ← merged / updated profile
    ├── agentDraftSpec.json    ← updated agent spec
    ├── onboarding_update.json ← raw patch extracted from onboarding call
    └── changes.json           ← field-level diff for this v1→v2 transition

changelog/
└── <company-slug>.json        ← append-only history of all version transitions
```

**`memo.json` fields** (all nullable — null means the call didn't mention it):

| Field | Description |
|-------|-------------|
| `company_name` | Business name as stated in the call |
| `industry_type` | e.g. HVAC, electrical, landscaping |
| `services_mentioned` | Array of specific services the business offers |
| `business_hours` | Days + start/end times + timezone |
| `emergency_definition` | What the business defines as an after-hours emergency |
| `routing_rules` | Call routing logic (transfers, hold behaviour) |
| `integration_constraints` | CRM or scheduling tools mentioned |
| `transfer_timeout_seconds` | How long to hold before transferring |
| `address` | Physical address if mentioned |
| `questions_or_unknowns` | Gaps the LLM flagged for human review |

**`changelog/<slug>.json` shape:**

```json
{
  "account_id": "bens-electric",
  "history": [
    {
      "version_from": "v1",
      "version_to": "v2",
      "generated_at": "2026-03-05T02:37:10.022Z",
      "total_changes": 3,
      "changes": [
        { "field": "business_hours", "before": null, "after": { ... }, "note": "Field updated" }
      ]
    }
  ]
}
```

---

## Known Limitations

**Extraction accuracy on long calls**
Transcripts longer than ~2,250 words are split into chunks at timestamp boundaries. Facts first mentioned in one chunk can contradict facts in another — the compose pass reconciles these but occasionally drops detail or paraphrases imprecisely.

**Onboarding hallucinations**
The extraction prompt for Pipeline B sometimes returns a company name in the patch instead of omitting it (the correct behaviour when the field didn't change). This creates a spurious diff entry. Fixable with a stricter prompt and a post-extraction filter.

**`business_hours` schema inconsistency**
The LLM sometimes produces non-canonical shapes for nested fields (`business_hours`, `routing_rules`) that pass Zod validation but look different across accounts, making downstream comparison harder.

**Rate limits and local fallback quality**
The Groq free tier has per-minute and daily token limits. Long audio files exhaust the daily limit quickly. The local CPU fallback (whisper-small + Qwen2.5-1.5B) is noticeably less accurate — it handles simple calls but struggles with fast speech, industry jargon, and overlapping speakers. Inference on CPU is also slow (~8 min to transcribe 30 min of audio on a laptop).

**No persistent storage**
All state is flat JSON files on disk. There is no deduplication, rollback, or account-level search beyond the file system.

**No authentication**
The server has no auth — any caller can read any account's outputs. This is fine for local/demo use but unsuitable for production.

---

## What I Would Improve With Production Access

**Confidence scoring per field**
Ask the LLM to return a `0–1` confidence score alongside each extracted value. Low-confidence fields would surface in the Asana review task and be highlighted in the diff viewer, so a human knows exactly where to focus attention rather than reviewing everything.

**Field-aware merge policy**
The current merge is last-writer-wins (onboarding always beats v1). In production, merge rules should be per-field — e.g. `business_hours` from an onboarding call should win, but if `company_name` looks like a hallucination (doesn't match the slug or existing value), flag it instead of overwriting.

**LLM with fast inference capabilities**
Upgrade to a more efficient LLM variant that can handle real-time inference with lower latency, improving the user experience for live calls.

**Versioned prompt config**
Extraction prompts are currently embedded in script files. Moving them into a versioned config (YAML or JSON with a `prompt_version` key) means prompt improvements are auditable, and the prompt version is recorded in every output file — making it possible to re-run old extractions for comparison.

**Streaming from live Retell transcripts**
Plug into the Retell real-time transcript webhook so Pipeline B triggers automatically as the onboarding call ends, without a manual file upload. The current architecture already supports this — the server just needs a `/webhook/retell` endpoint.

**Evaluation harness**
A held-out set of calls with ground-truth memos to measure field-level extraction accuracy across prompt versions, and a minimum passing threshold that blocks a prompt change from shipping if accuracy drops below it.

---

## Tests

```bash
npm test
```

- `tests/groq_working.test.js` — Groq API connectivity check
- `tests/v1-check.test.js` — validates v1 pipeline output structure against schema
