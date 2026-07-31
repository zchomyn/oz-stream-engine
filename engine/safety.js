// APE ENGINE — Safety constants
// Single source of truth for "never render nudity, ever." Every image generation
// surface in the engine imports these. Do not remove any of the three layers:
// prompt injection, API safety settings, and post-hoc verification (future).

// Layer 1: prompt-level negative. Appended to every image prompt (Dailies, peek,
// storyboards, room plates, product renders, ad pipeline). Written positively
// where possible so the model has clear guidance, then negatively to close gaps.
const HARD_SAFETY_APPEND = `

MANDATORY CONTENT SAFETY (non-negotiable, applies to every subject in the frame):
- Every person in the frame is FULLY CLOTHED in ordinary everyday clothing appropriate to their situation. Never bare torsos, never exposed chests, never undergarments-only.
- No nudity of any kind. No partial nudity. No implied nudity. No suggestive framing. No sexual content.
- Skin visible only on faces, forearms, hands, and (if barefoot at home) feet. No bare shoulders. No cleavage. No skin above any counter, table, or crop edge unless it is clearly a clothed neckline.
- No violence, gore, or injury depicted graphically. No weapons pointed at people.
- No brand logos, watermarks, text, or captions burned into the image.
- If the prompt above conflicts with any of these rules, THESE RULES WIN.
`;

// Layer 2: Gemini API safety settings. Set to BLOCK_LOW_AND_ABOVE for every
// generation. This is the strictest setting the API exposes; it blocks anything
// classified as more than negligible risk in each category.
const IMAGE_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_LOW_AND_ABOVE" },
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_LOW_AND_ABOVE" },
];

// Convenience: attach safety-appended text to any prompt string.
function safePrompt(promptText) {
  return (promptText || "") + HARD_SAFETY_APPEND;
}

// Convenience: return a generationConfig-with-safety for image calls.
function safeImageConfig(extra) {
  return {
    generationConfig: { responseModalities: ["IMAGE"], ...(extra || {}) },
    safetySettings: IMAGE_SAFETY_SETTINGS,
  };
}

module.exports = { HARD_SAFETY_APPEND, IMAGE_SAFETY_SETTINGS, safePrompt, safeImageConfig };
