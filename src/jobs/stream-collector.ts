export class StreamCollector {
  private chunks: Buffer[] = [];
  private currentBytes = 0;
  public totalBytes = 0;
  public truncated = false;

  constructor(private maxBytes: number = 5 * 1024 * 1024) {}

  write(chunk: Buffer): void {
    const len = chunk.length;
    this.totalBytes += len;

    if (this.currentBytes + len <= this.maxBytes) {
      this.chunks.push(chunk);
      this.currentBytes += len;
    } else if (this.currentBytes < this.maxBytes) {
      const allowed = this.maxBytes - this.currentBytes;
      this.chunks.push(chunk.subarray(0, allowed));
      this.currentBytes += allowed;
      this.truncated = true;
    } else {
      this.truncated = true;
    }
  }

  getString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
