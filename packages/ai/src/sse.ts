/**
 * In-crate SSE parser: LLM streams are `data:` lines plus `[DONE]`.
 * Handles chunk boundaries, CRLF, multi-line data, comments, and
 * ignores event:/id:/retry: fields.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.processLine(line, payloads);
    }
    return payloads;
  }

  finish(): string[] {
    this.buffer = "";
    return this.dispatch();
  }

  private processLine(line: string, out: string[]): void {
    if (line === "") {
      out.push(...this.dispatch());
      return;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
      this.dataLines.push(value);
    }
    // `:` comments and event:/id:/retry: fields are ignored
  }

  private dispatch(): string[] {
    if (this.dataLines.length === 0) return [];
    const joined = this.dataLines.join("\n");
    this.dataLines = [];
    return [joined];
  }
}
