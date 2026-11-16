/** One animation frame for reading motion and its optical projection.
 * Advance callbacks commit animation state before the single source-measure
 * phase. Paint callbacks then consume that snapshot without reading sources. */
export type ReaderFramePhase = "advance" | "measure" | "paint";
type Callback = (now: number) => boolean | void;
type Participant = { phase: ReaderFramePhase; priority: number; callback: Callback };
const phases: ReaderFramePhase[] = ["advance", "measure", "paint"];

export class ReaderFrameCoordinator {
  private participants = new Set<Participant>();
  private scheduled = 0;
  private flushing = false;
  private frames = 0;
  private durations = { advance: 0, measure: 0, paint: 0 };
  constructor(
    private raf: typeof requestAnimationFrame = callback => requestAnimationFrame(callback),
    private cancel: typeof cancelAnimationFrame = id => cancelAnimationFrame(id),
  ) {}
  request = () => {
    // Requests produced by a current motion callback are already represented
    // in this frame's later phases; only returned motion asks for another.
    if (!this.scheduled && !this.flushing && this.participants.size) this.scheduled = this.raf(this.flush);
  };
  subscribe(phase: ReaderFramePhase, callback: Callback, priority = 0) {
    const entry = { phase, callback, priority };
    this.participants.add(entry);
    this.request();
    return () => {
      this.participants.delete(entry);
      if (!this.participants.size && this.scheduled) { this.cancel(this.scheduled); this.scheduled = 0; }
    };
  }
  private flush = (now: number) => {
    this.scheduled = 0;
    this.flushing = true;
    let moving = false;
    const entries = [...this.participants].sort((a, b) => a.priority - b.priority);
    try {
      for (const phase of phases) {
        const start = performance.now();
        for (const entry of entries) {
          if (entry.phase === phase && this.participants.has(entry)) moving = entry.callback(now) === true || moving;
        }
        this.durations[phase] = performance.now() - start;
      }
      this.frames++;
    } finally {
      this.flushing = false;
      if (moving) this.request();
    }
  };
  inspect() { return { frames: this.frames, pending: Boolean(this.scheduled), phases: { ...this.durations } }; }
}

export const readerFrame = new ReaderFrameCoordinator();
