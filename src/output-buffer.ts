export interface DrainedOutput {
  text: string;
  droppedBytes: number;
}

/** A drainable byte buffer that discards the oldest data when full. */
export class OutputBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  get hasData(): boolean {
    return this.bytes > 0 || this.droppedBytes > 0;
  }

  append(value: Buffer | string): void {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (chunk.length === 0) return;

    if (chunk.length >= this.maximumBytes) {
      this.droppedBytes += this.bytes + chunk.length - this.maximumBytes;
      chunk = chunk.subarray(chunk.length - this.maximumBytes);
      this.chunks = [chunk];
      this.bytes = chunk.length;
      return;
    }

    this.chunks.push(chunk);
    this.bytes += chunk.length;
    let excess = this.bytes - this.maximumBytes;
    while (excess > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
        this.droppedBytes += first.length;
        excess -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
        this.droppedBytes += excess;
        excess = 0;
      }
    }
  }

  drain(): DrainedOutput {
    let combined = Buffer.concat(this.chunks, this.bytes);
    let incompletePrefixBytes = 0;
    while (
      incompletePrefixBytes < combined.length
      && (combined[incompletePrefixBytes] & 0b1100_0000) === 0b1000_0000
    ) {
      incompletePrefixBytes += 1;
    }
    if (incompletePrefixBytes > 0) combined = combined.subarray(incompletePrefixBytes);
    const result = {
      text: combined.toString('utf8'),
      droppedBytes: this.droppedBytes + incompletePrefixBytes,
    };
    this.chunks = [];
    this.bytes = 0;
    this.droppedBytes = 0;
    return result;
  }
}
