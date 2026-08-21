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
      if (line === "") {
        payloads.push(...this.dispatch());
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
        this.dataLines.push(value);
      }
    }
    return payloads;
  }

  finish(): string[] {
    this.buffer = "";
    return this.dispatch();
  }

  private dispatch(): string[] {
    if (this.dataLines.length === 0) return [];
    const joined = this.dataLines.join("\n");
    this.dataLines = [];
    return [joined];
  }
}
