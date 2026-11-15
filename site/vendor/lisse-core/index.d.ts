import { S as SmoothCornerOptions, E as EffectsConfig, O as OverlayOffset, a as ShadowConfig, B as BorderConfig } from './path-BUrhRKpo.js';
export { A as APPLE_SMOOTHING, b as BorderStyle, C as CURVE_TYPES, c as CornerConfig, d as CornerParams, e as CornerPathParams, f as CurveBuilder, g as CurveBuilderInput, h as CurveBuilderOutput, i as CurveType, D as DEFAULT_CURVE, j as DEFAULT_EXPONENT, k as DEFAULT_PRESERVE_SMOOTHING, l as DEFAULT_SHADOW, m as DEFAULT_SMOOTHING, F as FIGMA_SMOOTHING, G as GradientConfig, n as GradientStop, L as LinearGradientConfig, N as NormalizedCorner, o as NormalizedCorners, p as Orient, P as PerCornerConfig, R as RadialGradientConfig, U as UniformCornerOptions, q as buildArc, r as buildClothoid, s as buildSquircle, t as buildSuperellipse, u as cornerOptionsToBorderRadius, v as distributeAndNormalize, w as generateClipPath, x as generatePath, y as getCurveBuilder, z as getPathParamsForCorner } from './path-BUrhRKpo.js';

interface SvgEffectsHandle {
    update(options: SmoothCornerOptions, effects: EffectsConfig, width: number, height: number, offset?: OverlayOffset): void;
    destroy(): void;
}
/**
 * SVG overlay for inner/outer/middle borders and inner shadows. Appended to
 * `anchor` and positioned over `target`, the clipped element — which must never
 * be an ancestor of the overlay, since `clip-path` clips its whole subtree and
 * would cut an outer border away. Clip-path, mask and filter elements update in
 * sync with the smooth-corner path on each `update()`.
 */
declare function createSvgEffects(anchor: HTMLElement, target?: HTMLElement): SvgEffectsHandle;

interface DropShadowHandle {
    update(options: SmoothCornerOptions, shadow: ShadowConfig | ShadowConfig[], width: number, height: number, offset?: OverlayOffset): void;
    destroy(): void;
}
/**
 * Path-based drop shadows behind `target`, the clipped element, rendered into
 * `anchor`. Uses spread-adjusted squircle paths so the shadow follows the
 * smooth-corner silhouette at any spread. Accepts a single ShadowConfig or an
 * array; first entry renders topmost. The SVG sits at z-index:-1 inside the
 * anchor's `isolation:isolate` stacking context.
 */
declare function createDropShadow(anchor: HTMLElement, target?: HTMLElement): DropShadowHandle;

/** A border-box size in CSS pixels, at float precision. */
interface MeasuredSize {
    width: number;
    height: number;
}
/** The computed-style fields the border-box math reads. */
type LayoutStyleSource = Pick<CSSStyleDeclaration, "width" | "height" | "boxSizing" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "borderTopWidth" | "borderRightWidth" | "borderBottomWidth" | "borderLeftWidth">;
/**
 * Read an element's border-box in CSS pixels with float precision,
 * ignoring transforms on the element or any ancestor.
 *
 * - `getBoundingClientRect` folds in ancestor transforms (an element
 *   under `transform: scale(K)` would clip to K× its layout size).
 * - `offsetWidth/offsetHeight` ignore transforms (good) but round to
 *   integers — a fractional layout height (e.g. 28.8 px from
 *   line-height × font-size) leaves a sub-pixel sliver of un-clipped
 *   paint at the edge.
 * - `getComputedStyle.width/height` is the resolved used value in CSS
 *   pixels at full float precision. On `border-box` it's already the
 *   border-box; on `content-box` we add padding + border to recover it.
 *
 * Falls back to `offset*` in non-browser environments (happy-dom under
 * test) where `getComputedStyle` may return `"auto"` or "".
 *
 * Pass a pre-read `cs` to reuse an existing `getComputedStyle` result (its
 * values must be snapshotted before any layout-dirtying write — computed
 * style is live); omit it and the element's computed style is read here.
 */
declare function getLayoutSize(el: HTMLElement, cs?: LayoutStyleSource): MeasuredSize;

/**
 * Border-box size per `getLayoutSize`, plus the element's offset within its
 * `offsetParent`. The offset rides along so consumers never read it in the write
 * pass, where it would force a relayout per element.
 */
interface Measured extends MeasuredSize {
    offsetLeft: number;
    offsetTop: number;
}
/**
 * Receives what was measured at the start of this flush; callers may ignore it
 * and re-measure. Extra parameters are ignored by `() => void` callbacks, so
 * this stays backward-compatible.
 */
type Callback = (measured?: Measured) => void;
/**
 * Queue `el` for the next batched flush without reading layout. For work driven
 * by something other than `el`'s own resize, where measuring inline would land
 * in the write pass. Costs one frame. No-op if `el` isn't observed.
 *
 * Queues unconditionally: unlike an observer notification there is no entry box
 * to recognise as already-measured, and the caller asked precisely because
 * something other than `el` changed what `el` should render.
 */
declare function requestMeasure(el: Element): void;
/**
 * Observe `el` for resize via a shared ResizeObserver; callbacks are
 * rAF-batched (one frame per tick, across all observed elements) with an
 * immediate initial dispatch. The returned function unsubscribes; the
 * observer disconnects once the last element is released.
 */
declare function observeResize(el: Element, callback: Callback): () => void;
/**
 * Re-measure `target` whenever `anchor` resizes.
 *
 * Skips the anchor's first dispatch. That one comes from the anchor's own
 * subscribe-time queueing, in the same flush that already measured `target` for
 * `target`'s own subscribe — re-queueing there buys nothing and costs `target` a
 * whole extra flush read.
 */
declare function observeAnchor(anchor: Element, target: Element): () => void;

declare function clearCurveCache(): void;

interface ExtractedEffects {
    effects: EffectsConfig;
    /**
     * The element's border box as it stood at extraction, so the caller's first
     * sync can render without reading layout again. Still accurate after the
     * strip: `extractAndStripEffects` only removes a border it compensates for.
     */
    size: MeasuredSize;
    savedStyles: {
        border: string;
        boxShadow: string;
        paddingTop: string;
        paddingRight: string;
        paddingBottom: string;
        paddingLeft: string;
    };
}
/**
 * Parse an rgb/rgba color (as returned by getComputedStyle) to hex + opacity.
 * Accepts legacy comma form `rgb(255, 0, 0)` and CSS Color L4 space form
 * `rgb(255 0 0 / 0.5)`. Returns undefined for unrecognised input.
 */
declare function parseColor(raw: string): {
    hex: string;
    opacity: number;
} | undefined;
/** The computed-style fields `parseBorder` reads. */
type BorderStyleSource = Pick<CSSStyleDeclaration, "borderTopStyle" | "borderTopWidth" | "borderTopColor">;
/**
 * Read the computed border from an element as a BorderConfig.
 * Returns undefined when the border is effectively invisible (none/hidden,
 * width 0, or transparent).
 *
 * Pass a pre-read `cs` to reuse an existing `getComputedStyle` result (its
 * values must be snapshotted before any layout-dirtying write — computed
 * style is live); omit it and the element's computed style is read here.
 */
declare function parseBorder(el: HTMLElement, cs?: BorderStyleSource): BorderConfig | undefined;
/**
 * Parse a computed box-shadow string into outer and inset shadow arrays,
 * preserving CSS order within each group.
 */
declare function parseBoxShadow(raw: string): {
    shadow?: ShadowConfig[];
    innerShadow?: ShadowConfig[];
};
/**
 * Extract CSS border and box-shadow from an element, strip them inline, and
 * return equivalent EffectsConfig values plus the saved styles needed to
 * restore the original inline state.
 */
declare function extractAndStripEffects(el: HTMLElement): ExtractedEffects;
/** True when `config` defines any renderable effect. */
declare function hasEffects(config: EffectsConfig | undefined | null): boolean;
/** Merge auto-extracted and explicit effects; explicit wins per key. */
declare function mergeEffects(extracted: ExtractedEffects | undefined, explicit: EffectsConfig | undefined): EffectsConfig;
/**
 * Restore previously saved inline border/boxShadow/padding styles. An empty
 * saved value clears the inline override so stylesheet rules can reassert.
 */
declare function restoreStyles(el: HTMLElement, saved: ExtractedEffects["savedStyles"]): void;

/**
 * Ensure an anchor is positioned so the SVG effects overlay can sit on it.
 * Ref-counted: already-acquired anchors just increment. A static anchor
 * gets `position: relative` and counts as the first acquire. Returns false
 * when the anchor is non-static but not ours — caller bails out rather
 * than stomp on a user-set style. Pair with `releasePosition`.
 */
declare function acquirePosition(anchor: HTMLElement): boolean;
/**
 * Decrement the ref count; the last release clears the inline `position`
 * applied by `acquirePosition`. A no-op when the anchor was never acquired
 * (we mustn't stomp a user-set inline style).
 */
declare function releasePosition(anchor: HTMLElement): void;
/**
 * Stacking context for a `z-index:-1` sibling — core's drop-shadow SVG, or an
 * adapter's CSS box-shadow div. Ref-counted because a whole grid routinely
 * shares one anchor (saving per handle meant the second captured the first's
 * `isolate` and restored it on teardown), and because both owners hold it at
 * once while a `shadowStrategy` flip hands over.
 */
declare function acquireIsolation(anchor: HTMLElement): void;
declare function releaseIsolation(anchor: HTMLElement): void;

export { BorderConfig, type DropShadowHandle, EffectsConfig, type ExtractedEffects, type Measured, type MeasuredSize, OverlayOffset, ShadowConfig, SmoothCornerOptions, type SvgEffectsHandle, acquireIsolation, acquirePosition, clearCurveCache, createDropShadow, createSvgEffects, extractAndStripEffects, getLayoutSize, hasEffects, mergeEffects, observeAnchor, observeResize, parseBorder, parseBoxShadow, parseColor, releaseIsolation, releasePosition, requestMeasure, restoreStyles };
