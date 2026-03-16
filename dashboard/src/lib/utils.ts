import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Strip raw image markdown references from display text.
 * Fallback sanitizer for historical data that was stored before normalization.
 */
export function sanitizeMessageText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/!\[[^\]]*\]\(image:[^)]+\)/g, "[image]")
    .replace(/!\[[^\]]*\]\(\/media\/[^)]+\)/g, "[image]")
    .replace(/!\[[^\]]*\]\([^)]*\/workspace\/[^)]+\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
