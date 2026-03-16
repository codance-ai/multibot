#!/usr/bin/env python3
"""Image generation script. Reads config from environment variables.
Supports OpenAI, xAI, Google providers. Saves image to /workspace/images/."""

import argparse
import base64
import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error

OUTPUT_DIR = "/workspace/images"
TIMEOUT = 55  # seconds (image APIs can take 20-45s)
MAX_RETRIES = 1  # retry once on transient errors
RETRY_DELAY = 3  # seconds between retries
UA = "multibot/1.0"


ASPECT_TO_SIZE = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "4:3": "1536x1024",
    "9:16": "1024x1792",
    "16:9": "1792x1024",
}


def generate_openai(prompt, api_key, model, base_url, aspect_ratio="1:1"):
    url = f"{base_url}/v1/images/generations"
    body = json.dumps({"model": model, "prompt": prompt, "n": 1, "size": ASPECT_TO_SIZE.get(aspect_ratio, "1024x1024")}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": UA,
    })
    resp = json.loads(urllib.request.urlopen(req, timeout=TIMEOUT).read())
    item = resp["data"][0]
    if "b64_json" in item:
        return base64.b64decode(item["b64_json"])
    dl = urllib.request.Request(item["url"], headers={"User-Agent": UA})
    return urllib.request.urlopen(dl, timeout=TIMEOUT).read()


def generate_xai(prompt, api_key, model, base_url, aspect_ratio="1:1"):
    url = f"{base_url}/v1/images/generations"
    body = json.dumps({
        "model": model, "prompt": prompt, "n": 1,
        "aspect_ratio": aspect_ratio,
        "response_format": "url",
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": UA,
    })
    resp = json.loads(urllib.request.urlopen(req, timeout=TIMEOUT).read())
    dl = urllib.request.Request(resp["data"][0]["url"], headers={"User-Agent": UA})
    return urllib.request.urlopen(dl, timeout=TIMEOUT).read()


def generate_google(prompt, api_key, model, base_url, aspect_ratio="1:1"):
    url = f"{base_url}/v1beta/models/{model}:generateContent"
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": aspect_ratio},
        },
    }).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
        "User-Agent": UA,
    })
    resp = json.loads(urllib.request.urlopen(req, timeout=TIMEOUT).read())
    candidates = resp.get("candidates", [])
    if not candidates:
        block = resp.get("promptFeedback", {}).get("blockReason", "unknown")
        raise RuntimeError(f"Image blocked by safety filter: {block}")
    for part in candidates[0]["content"]["parts"]:
        if "inlineData" in part:
            return base64.b64decode(part["inlineData"]["data"])
    raise RuntimeError("No image data in Google response")


GENERATORS = {"openai": generate_openai, "xai": generate_xai, "google": generate_google}


def main():
    parser = argparse.ArgumentParser(description="Generate an image from a text prompt.")
    parser.add_argument("--prompt", help="Text prompt")
    parser.add_argument("--prompt-file", help="Path to file containing the prompt")
    parser.add_argument("--prompt-env", help="Environment variable name containing the prompt")
    parser.add_argument("--aspect-ratio", default="1:1", choices=list(ASPECT_TO_SIZE.keys()), help="Aspect ratio (default: 1:1)")
    args = parser.parse_args()

    # Read prompt (env var > file > arg > stdin)
    if args.prompt_env:
        prompt = os.environ.get(args.prompt_env, "")
        if not prompt:
            print(f"Error: environment variable {args.prompt_env} is empty or not set", file=sys.stderr)
            sys.exit(1)
    elif args.prompt_file:
        with open(args.prompt_file) as f:
            prompt = f.read().strip()
    elif args.prompt:
        prompt = args.prompt
    elif not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()
    else:
        print("Error: provide prompt via --prompt, --prompt-file, --prompt-env, or stdin", file=sys.stderr)
        sys.exit(1)

    if not prompt:
        print("Error: prompt is empty", file=sys.stderr)
        sys.exit(1)

    # Load config from environment variables
    provider = os.environ.get("IMAGE_PROVIDER")
    api_key = os.environ.get("IMAGE_API_KEY")
    model = os.environ.get("IMAGE_MODEL")
    base_url = os.environ.get("IMAGE_BASE_URL")

    if not provider or not api_key or not model or not base_url:
        print(f"Error: incomplete config — provider={provider}, model={model}, baseUrl={base_url}, apiKey={'set' if api_key else 'missing'}", file=sys.stderr)
        sys.exit(1)

    gen_fn = GENERATORS.get(provider)
    if not gen_fn:
        print(f"Error: unsupported provider '{provider}'", file=sys.stderr)
        sys.exit(1)

    aspect_ratio = args.aspect_ratio

    # Generate (with retry for transient errors)
    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            image_data = gen_fn(prompt, api_key, model, base_url, aspect_ratio)
            break
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            last_error = f"HTTP {e.code} from {provider}: {body}"
            # Retry on 429 (rate limit) and 5xx (server errors)
            if e.code in (429, 500, 502, 503, 504) and attempt < MAX_RETRIES:
                print(f"Retrying after {RETRY_DELAY}s ({last_error})...", file=sys.stderr)
                time.sleep(RETRY_DELAY)
                continue
            print(f"Error: {last_error}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            last_error = str(e)
            print(f"Error: {last_error}", file=sys.stderr)
            sys.exit(1)
    else:
        print(f"Error: failed after {MAX_RETRIES + 1} attempts: {last_error}", file=sys.stderr)
        sys.exit(1)

    # Save
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    filename = f"{uuid.uuid4().hex[:12]}.png"
    output_path = f"{OUTPUT_DIR}/{filename}"
    with open(output_path, "wb") as f:
        f.write(image_data)

    alt = (prompt[:77] + "...") if len(prompt) > 80 else prompt
    print(f"![{alt}](image:{output_path})")


if __name__ == "__main__":
    main()
