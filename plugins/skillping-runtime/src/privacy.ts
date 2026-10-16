const MINIMUM_EXCERPT_LENGTH = 24;

export function hasPromptExcerpt(value: unknown, prompt: string): boolean {
  const original = prompt.trim();
  if (original.length === 0) return false;
  const matches = (text: string) => {
    const candidate = text.trim();
    if (candidate === original || candidate.includes(original)) return true;
    if (candidate.length < MINIMUM_EXCERPT_LENGTH || original.length < MINIMUM_EXCERPT_LENGTH) return false;
    for (let index = 0; index <= candidate.length - MINIMUM_EXCERPT_LENGTH; index += 1) {
      if (original.includes(candidate.slice(index, index + MINIMUM_EXCERPT_LENGTH))) return true;
    }
    return false;
  };
  const visit = (current: unknown): boolean => {
    if (typeof current === "string") return matches(current);
    if (Array.isArray(current)) return current.some(visit);
    if (current && typeof current === "object") return Object.values(current).some(visit);
    return false;
  };
  return visit(value);
}
