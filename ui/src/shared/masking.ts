const CREDENTIAL_ASSIGNMENT =
  /(api[_-]?key|token|secret|password|authorization|cookie|credential)(\s*[=:]\s*)(["'])?[^"';,\s]+/gi;

/**
 * The single masking source for every reactive/egress sink: notifications,
 * copy actions, reports and side-chat capsules must mask before storage or
 * transmission.
 */
export function maskSensitiveText(text: string): string {
  return text.replace(CREDENTIAL_ASSIGNMENT, (_match, key: string, separator: string, quote?: string) => {
    return `${key}${separator}${quote ?? ""}[masked]`;
  });
}

export function isMasked(candidate: string, original: string): boolean {
  return candidate !== original;
}
