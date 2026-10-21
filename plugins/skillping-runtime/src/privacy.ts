const MINIMUM_EXCERPT_LENGTH = 24;

export function isExternalContentSafe(text: string): boolean {
  return !/(?:[a-z]:[\\/]|\\\\|https?:\/\/|(?:^|\s)[/~][\w.-]+\/|\b[\w.-]+\.(?:csv|xlsx?|docx?|pdf|json|ya?ml|tsx?|py|sql)\b|\b(?:password|passphrase|token|api[_ -]?key|private[_ -]?key|recovery[_ -]?code)["']?\s*[:=]\s*\S+|\b(?:my|secret|access)\s+(?:password|passphrase|token|api[_ -]?key)\s+(?:is|=|:)\s*\S+|\bsk-(?:proj-)?[\w-]{16,}|\b(?:gh[pousr]_|github_pat_)[\w]{20,}|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[\w-]{12,}|-----BEGIN .*PRIVATE KEY-----|(?:密码|私钥|令牌|恢复码)\s*[:=：是为]\s*\S+|\b(?:confidential|personally identifiable|do not share)\b|机密|个人隐私|不得外传)/iu.test(text);
}

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
