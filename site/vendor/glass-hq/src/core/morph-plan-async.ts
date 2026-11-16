import { traceMorphSteps } from "./morph-path";
import type { MorphEndpoints, MorphGlass, MorphPlanOptions, MorphStop } from "./morph-path";

export const abortPlanError = () => new DOMException("Morph plan cancelled", "AbortError");
export interface PlanWorkOptions {
  signal?: AbortSignal;
  yieldTask?: () => Promise<void>;
  budgetMs?: number;
  onSlice?: (duration: number) => void;
}
/** Run the original trace in bounded chunks. Even the first chunk is deferred. */
export async function traceMorphAsync(e: MorphEndpoints, glass: MorphGlass | undefined, options: MorphPlanOptions, work: PlanWorkOptions = {}): Promise<MorphStop[]> {
  const pause = work.yieldTask ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const steps = traceMorphSteps(e, glass, options);
  try {
    for (;;) {
      await pause();
      if (work.signal?.aborted) throw abortPlanError();
      const start = performance.now();
      let item = steps.next();
      while (!item.done && performance.now() - start < (work.budgetMs ?? 4)) {
        if (work.signal?.aborted) throw abortPlanError();
        item = steps.next();
      }
      work.onSlice?.(performance.now() - start);
      if (item.done) return item.value;
    }
  } finally { steps.return([]); }
}
