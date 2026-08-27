import { stripVTControlCharacters } from "node:util";

/**
 * Terminal-injection defense: model answers, tool output, and error text are
 * untrusted (a malicious repo can echo OSC/CSI sequences through `cat`).
 * Strip VT sequences and all C0 controls except newline and tab before
 * anything reaches <Text>.
 */
export function sanitizeTerminalText(input: string): string {
  const stripped = stripVTControlCharacters(input);
  // belt-and-braces: stripVTControlCharacters misses OSC without ST/BEL
  // terminators and other C0 controls
  return stripped.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
