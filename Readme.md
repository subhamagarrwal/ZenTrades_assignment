# ═══════════════════════════════════════════════════════════════
# PIPELINE A (Demo) → v1
# ═══════════════════════════════════════════════════════════════

# Step 1: Transcribe demo audio
node scripts/transcribeAudio.js "inputs/bens-electric/audio/demo/demo_audio.mp3"

# Step 2: Run Pipeline A
node scripts/v1/runDemo.js "bens-electric/transcripts/demo/transcript.txt" demo_001

# ═══════════════════════════════════════════════════════════════
# PIPELINE B (Onboarding) → v2
# ═══════════════════════════════════════════════════════════════

# Step 3: Transcribe onboarding audio
node scripts/transcribeAudio.js "inputs/bens-electric/audio/onboarding/onboarding_audio.mp3"

# Step 4: Run Pipeline B (updates agent in-place)
node scripts/v2/runOnboarding.js "bens-electric/transcripts/onboarding/transcript.txt" demo_001
