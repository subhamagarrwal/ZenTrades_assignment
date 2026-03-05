# Loom Video Script (~4 min)

## [0:00–0:20] INTRO (20s)

- "This is Clara Automation — it takes raw sales demo calls and onboarding recordings and turns them into fully configured AI voice agents, automatically."
- "I'll walk through one full cycle: demo call → v1 agent → onboarding call → v2 agent, and show the diff."

---

## [0:20–1:10] PIPELINE A — Demo → v1 (50s)

- Open the web UI at localhost:3000
- Type company name: `bens-electric`
- Upload the demo audio file
- Click **Run v1** — show the SSE logs streaming in real time
- Point out key steps in the logs: "Whisper transcription → LLM extraction → Zod validation → agent spec generated"
- Once done, scroll down to show the **v1 output**: memo.json with company_name, services, business_hours, routing_rules etc.
- "This memo is the structured profile extracted purely from the demo call. Fields like timezone and emergency_definition might be null — that's expected, the demo didn't cover everything."

---

## [1:10–2:10] PIPELINE B — Onboarding → v2 (60s)

- Now upload the onboarding audio for the same company
- Click **Run v2** — show logs streaming again
- Point out: "It loads the v1 memo, extracts new facts from the onboarding call, then merges — new info fills gaps, conflicting info gets the onboarding version since it's more recent."
- Once done, show the **v2 output**: memo.json now has business_hours filled in, emergency_definition populated, etc.
- **Key moment**: Point at the **diff viewer** that appeared below — "This is the changelog. It shows exactly what changed between v1 and v2, field by field, with before/after values."
- Click through a few changes: "business_hours went from null to Monday–Friday 8:30–5:00, services_mentioned got expanded..."
- "This diff persists — if I come back later and type `bens-electric`, the changelog loads automatically."

---

## [2:10–3:00] GENERATED OUTPUTS (50s)

- Switch to the file explorer / terminal
- Navigate to `outputs/accounts/bens-electric/`
- Show the folder structure: v1/ and v2/ side by side
- Open v1/memo.json briefly, then v2/memo.json — visually compare a field or two
- Open v2/agentDraftSpec.json — "This is the Retell-ready agent config: general_prompt, begin_message, all generated from the memo"
- Open v2/changes.json — "The raw diff, 3 fields changed"
- Open changelog/bens-electric.json — "The global changelog tracks every version transition"

---

## [3:00–3:40] BATCH + BONUS (40s)

- Open n8n at localhost:5678
- Show the batch workflow — "This processes 5 accounts sequentially using SplitInBatches"
- Show the account list in the workflow node
- Switch back to the web UI — show the **Batch Monitor** panel with status cards
- "Each card shows v1/v2 completion status. The panel auto-appears when processing starts and auto-hides when done."
- Briefly mention: "There's also a local fallback — if Groq rate-limits, it falls back to whisper.cpp and llama.cpp running on CPU, no GPU needed."

---

## [3:40–4:00] WRAP UP (20s)

- "So the full loop: audio in → structured memo → versioned agent spec → changelog diff. All zero-cost APIs, Dockerized, works with one `docker-compose up`."
- "Everything's in the repo — scripts, workflows, outputs, changelogs. Thanks for watching."
