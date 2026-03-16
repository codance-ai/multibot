#!/bin/bash
# Generate voice sample audio files for dashboard preview
# Usage: OPENAI_API_KEY=sk-... ./scripts/generate-voice-samples.sh
#
# Generates MP3 samples for each OpenAI TTS voice and uploads to R2.

set -euo pipefail

VOICES=("alloy" "ash" "coral" "echo" "fable" "onyx" "nova" "sage" "shimmer")
MODEL="gpt-4o-mini-tts"
TEXT="Hello! I'm your AI assistant. How can I help you today?"
TMPDIR=$(mktemp -d)

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "Error: OPENAI_API_KEY environment variable is required"
  exit 1
fi

echo "Generating voice samples..."

for voice in "${VOICES[@]}"; do
  echo "  Generating ${voice}..."
  curl -s "https://api.openai.com/v1/audio/speech" \
    -H "Authorization: Bearer ${OPENAI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${MODEL}\",\"voice\":\"${voice}\",\"input\":\"${TEXT}\"}" \
    --output "${TMPDIR}/${voice}.mp3"

  if [ ! -s "${TMPDIR}/${voice}.mp3" ]; then
    echo "  Warning: Failed to generate ${voice}, skipping"
    continue
  fi

  echo "  Uploading ${voice}.mp3 to R2..."
  npx wrangler r2 object put "multibot-assets/voice-samples/${voice}.mp3" \
    --file "${TMPDIR}/${voice}.mp3" \
    --content-type "audio/mpeg"
done

rm -rf "${TMPDIR}"
echo "Done! ${#VOICES[@]} voice samples generated and uploaded."
