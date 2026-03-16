---
name: image
description: Generate non-selfie images from text descriptions (landscapes, objects, artwork, etc.).
metadata: {"nanobot":{"emoji":"🎨"}}
---

# Image Generation

Generate images using the image generation script.

## Usage

Run the generation script, passing the prompt via stdin:

exec(command="python3 /skills/image/scripts/gen.py", stdin="detailed description of the image")

The script reads provider config from environment variables (auto-injected by the system).
The generated image is returned as a markdown image reference — include it in your reply as-is.

## Prompt Tips

- Be specific and detailed: describe subject, style, lighting, composition, colors
- Include art style if relevant: "watercolor", "photorealistic", "anime style"
- Keep prompts in English for best results
- The script supports OpenAI, xAI, and Google image providers
