---
name: selfie
description: Generate selfie/photo images of yourself (self-contained, handles image generation).
metadata: {"nanobot":{"emoji":"📸"}}
---

# Selfie

Generate selfie-style images with consistent visual identity.

## Step 1: Check Character Sheet (ALWAYS do this first)

Check the Memory section in your system prompt for a `## Selfie Character Sheet` section. MEMORY.md is already loaded — do NOT call `memory_read` for it.

- **Found** -> Go to Step 3
- **Not found** -> Go to Step 2

## Step 2: Create Character Sheet (first time only)

Based on your soul and identity, create a detailed character sheet **in the language you normally speak to users**. Cover:
- Gender, approximate age
- Hair style and color
- Skin tone
- Eye color and shape
- Face shape and distinguishing features
- Build / body type
- Signature clothing or accessories

Save it to MEMORY.md using `memory_write` under a `## Selfie Character Sheet` section.

## Step 3: Generate Image

Compose a detailed prompt that combines:
1. **Realistic selfie style prefix** (ALWAYS start with this): `Photorealistic iPhone selfie photograph, natural lighting, slight depth of field, casual mobile phone camera angle.`
2. **Full character sheet text** (copy verbatim — do NOT translate or rephrase)
3. **Scene/pose/expression** from the user's request (use the same language as the character sheet)

Then run the generation script via stdin. **You MUST include `--aspect-ratio 3:4`** — selfies are always portrait orientation:

exec(command="python3 /skills/image/scripts/gen.py --aspect-ratio 3:4", stdin="<the full prompt>")

**CRITICAL for visual consistency**: Copy the character sheet exactly as stored — never translate, rephrase, or reword it. Use the same language as the character sheet for the scene description. Mixing languages or rewording across generations will produce inconsistent faces.

## Updating Appearance

If the user wants to change their character's look, update the character sheet in MEMORY.md first, then generate a new image.
