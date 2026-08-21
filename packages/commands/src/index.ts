import { buildNode, nodeFields, artboardFields, type Document, type Node } from '@artboard/schema';
import { aabb, classifyAnchors, nodeBox, reanchor, resizeFactor, round, type Anchors } from '@artboard/engine';

/** Immutable command layer. apply(doc, cmd) -> newDoc. invert(cmd) -> undo cmd. */

export class StaleCommandError extends Error {
  constructor(public nodeId: string) { super(`Command targets a node that no longer exists (${nodeId}).`); this.name = 'StaleCommandError'; }
}

/**
 * The artboard itself is gone. Extends StaleCommandError on purpose: undo and
 * redo drop a stale entry rather than exploding, and an artboard that vanished
 * is the same kind of staleness as a node that did.
 */
export class StaleArtboardError extends StaleCommandError {
  constructor(public artboardId: string) {
    super(artboardId);
    this.message = `Command targets an artboard that no longer exists (${artboardId}).`;
    this.name = 'StaleArtboardError';
  }
}

/**
 * The command is malformed against this document — a patch naming a field the
 * target does not have, or an id that is already taken. Deliberately NOT a
 * StaleCommandError: nothing here is stale, the command is wrong, and undo must
 * not quietly swallow it. `invert` never produces one of these.
 */
export class InvalidCommandError extends Error {
  constructor(detail: string) { super(detail); this.name = 'InvalidCommandError'; }
}

export type Command =
  | { type: 'addNode'; artboardId: string; node: Node; index?: number }
  | { type: 'removeNode'; artboardId: string; nodeId: string; node?: Node; index?: number }
  | { type: 'updateNode'; nodeId: string; patch: Record<string, unknown>; before?: Record<string, unknown> }
  | { type: 'reorder'; artboardId: string; nodeId: string; to: number; from?: number }
  | { type: 'setArtboard'; artboardId: string; patch: Record<string, unknown>; before?: Record<string, unknown> }
  | { type: 'addAsset'; asset: { id: string; mime: string; width: number; height: number; data: string } }
  | { type: 'batch'; label: string; commands: Command[] }
  /**
   * Wrap `nodeIds` in a new group node. `node` and `index` are the undo
   * capture: when present the group node is restored verbatim at that index
   * (so a group's own name/opacity/effects survive an ungroup + undo) instead
   * of being synthesised from the members' bounds.
   */
  | { type: 'group'; artboardId: string; nodeIds: string[]; groupId: string; node?: Node; index?: number }
  /**
   * Replace a group with its children. `indices` is the undo capture: the slot
   * each child occupied before it was grouped, which is what lets `group`'s
   * inverse restore a non-contiguous selection to its exact original order.
   */
  | { type: 'ungroup'; artboardId: string; groupId: string; indices?: number[] }
  /**
   * Move each of `nodeIds` by (dx, dy), depth-first over that node's whole
   * subtree.
   *
   * This exists because `updateNode` cannot express a move for a group.
   * `makeGroup` keeps children in artboard space and render-svg's `case 'group'`
   * emits no transform of its own, so a group's x/y is bounds metadata that
   * nothing draws from: patching it moved the selection handles and the
   * Inspector readout while every child stayed exactly where it was. A move has
   * to reach the leaves, and only a RELATIVE command can do that without every
   * caller having to know the shape of the subtree it is moving.
   *
   * Relative also makes the editor's revert-then-commit trick simpler rather
   * than harder: a drag reverts with `-dx` instead of having to remember and
   * replay an absolute position per node.
   */
  | { type: 'translate'; nodeIds: string[]; dx: number; dy: number }

  /**
   * Scale a subtree about a fixed point, in artboard space.
   *
   * The sibling of `translate`, and it exists for the same reason: a group's
   * width/height is bounds metadata that nothing draws from, so growing the box
   * grew the handles and left the artwork alone. Resizing has to reach the
   * leaves.
   *
   * `ox`/`oy` is the point that stays put -- the corner opposite the handle
   * being dragged -- so the gesture the user sees (that corner is pinned, the
   * rest follows) is the command's own definition rather than something the
   * caller has to arrange by combining a scale with a move.
   *
   * NOT relative-invertible, unlike `translate`. Coordinates round to 2dp, so
   * scaling by 2 and then by 0.5 does not land back where it started; `invert`
   * captures the subtree instead. See `replaceNodes`.
   */
  | { type: 'scale'; nodeIds: string[]; sx: number; sy: number; ox: number; oy: number }
  /*
   * Magic Resize. Deliberately NOT a `setArtboard` patch: it needs both
   * dimensions to compute a ratio, and a partial patch would let a caller send
   * half of what the command requires and discover it at runtime. `setArtboard`
   * still exists and still only sets fields -- resizing the page without
   * relayout is a different, valid gesture.
   */
  | { type: 'resizeArtboard'; artboardId: string; width: number; height: number }

  /**
   * Put these exact subtrees back, matched by id at any depth.
   *
   * The undo capture for commands that rewrite a subtree in a way arithmetic
   * cannot reverse. It is deliberately dumb -- no merging, no patching, just
   * "this is what those nodes were" -- because a lossy inverse is worse than a
   * verbose one, and this is the same idiom `removeNode` already uses when it
   * inverts to an `addNode` carrying the whole node back.
   *
   * Not offered to the MCP server: it is an undo primitive, and an agent that
   * wants to change a node has `updateNode`, `translate` and `scale`, all of
   * which validate what they are asked to do.
   */
  | { type: 'replaceNodes'; nodes: Node[] };

/**
 * Scale one subtree about (ox, oy).
 *
 * `k` is the factor for lengths that are a single number when the scale is not
 * uniform -- font size, corner radius, stroke width, blur. A box has an x and a
 * y factor; a font size has one, and there is no honest way to give it two. `k`
 * is the geometric mean, which is the only choice with all three properties
 * that matter here: it equals sx exactly when the scale IS uniform (the common
 * case, so the common case is exact rather than approximated), it preserves
 * area ratio, and it is continuous, so dragging a side handle does not make
 * text jump the moment the drag stops being square.
 *
 * Not scaled, deliberately: `rotation` is an angle, `lineHeight` is a multiple
 * of the font size and so scales with it already, and a path's `d`/`viewBox`
 * and an image's `frameD`/`frameBox` live in their own coordinate space that
 * the node's width/height already maps onto the artboard.
 */
/**
 * Is this rotation a multiple of a quarter turn?
 *
 * The tolerance is not decoration. `89.99999999999999 % 90` is `89.99999999999999`,
 * not a near-zero remainder, so a rotation a hair BELOW a quarter turn fails an
 * exact test while one a hair above passes -- the two ends of the interval
 * behave completely differently. Hence the distance to the nearer end.
 *
 * 1e-6 degrees is roughly 2e-5 px of deviation across a 1000px object: below
 * any pixel, and far above the float noise an interactive drag produces.
 */
const QUARTER_TURN_TOLERANCE = 1e-6;
export function isAxisAligned(rotation: number): boolean {
  const r = Math.abs(rotation ?? 0) % 90;
  return Math.min(r, 90 - r) <= QUARTER_TURN_TOLERANCE;
}

/**
 * The first node in this subtree that a non-uniform scale could not express,
 * or null if there is none. Exported so the editor can constrain the gesture
 * rather than let it fail: the command refusing and the handles allowing it
 * would be the same disagreement between what a control advertises and what it
 * can do that hiding the group resize handles was there to avoid.
 *
 * WHY it cannot be expressed: a node is stored as an axis-aligned box plus a
 * rotation angle. Rotating a rectangle and then scaling it by different x and y
 * factors produces a PARALLELOGRAM, and no (x, y, width, height, rotation)
 * describes one. Measured: a 100x50 rect at 20 degrees under scale (2, 1) comes
 * out with 115.7 degrees between adjacent edges instead of 90. That is not
 * precision loss to round away -- the shape has left the set the schema can
 * store. Quarter turns survive, because they only swap the axes.
 */
export function unscalableDescendant(n: Node): Node | null {
  if (!isAxisAligned((n as any).rotation ?? 0)) return n;
  if ((n as any).kind === 'group') {
    for (const c of (((n as any).children ?? []) as Node[])) {
      const found = unscalableDescendant(c);
      if (found) return found;
    }
  }
  return null;
}

function scaleEffect(e: any, sx: number, sy: number, k: number): any {
  switch (e?.kind) {
    case 'shadow': return { ...e, x: round(e.x * sx), y: round(e.y * sy), blur: round(e.blur * k), spread: round(e.spread * k) };
    case 'glow': return { ...e, blur: round(e.blur * k) };
    case 'blur': return { ...e, radius: round(e.radius * k) };
    case 'outline': return { ...e, width: round(e.width * k) };
    case 'echo': return { ...e, dx: round(e.dx * sx), dy: round(e.dy * sy) };
    case 'background': return { ...e, padding: round(e.padding * k), radius: round(e.radius * k) };
    // curve, adjust, duotone and vignette are proportions and colours, with no
    // length among them. Listed here rather than defaulted silently so the next
    // effect with a size in it has to make a decision.
    default: return e;
  }
}

type Frame = { width: number; height: number };

/*
 * A text node's box is a FRAME, not its visible extent, and the two disagree
 * exactly where it matters. A left-aligned headline inset 96px in a 1080 frame
 * has symmetric margins, so the box classifier reads it as centred -- correctly,
 * about the box. But the glyphs start at the left edge and the slack is all on
 * the right, so on a widening frame the "centred" frame slides right and the
 * headline detaches from the rule and button that stayed at the margin.
 *
 * Found by resizing a real design 1080x1080 -> 1584x396 and watching a left
 * column come apart: two of six left-margin nodes jumped 8.9% -> 39.7% while
 * the rest held. `align` states which edge the content is bound to, which is
 * better evidence than the symmetry of a box the user never sees.
 *
 * Only the `centre` reading is overridden. A frame whose margins decisively say
 * left or right is bound that way whatever its text does, and `stretch` must
 * survive so a full-bleed block stays full-bleed.
 *
 * X ONLY, AND THE MISSING `valign` HALF IS THE POINT. This shipped with a
 * matching y rule -- `middle` overridden to `top` or `bottom` from `valign` --
 * generalised from the x case by symmetry, with nothing measured. The symmetry
 * does not hold. `align: left` means the glyphs start at the frame's left edge
 * while the slack sits on the right, and a text frame's horizontal slack is
 * usually large: a headline box is as wide as the column, not as wide as the
 * words. Vertically the frame is sized to the text, so the slack is small and
 * the frame's middle really is near the element's middle.
 *
 * Priced twice. Against the per-node model it fired on 46 of 442 independently
 * placed text nodes and cost a net 1941px of extra tearing across the corpus.
 * Against the clustered model it fires on nothing -- but that number says less
 * than it looks like it says, and the honest version is worth the extra line.
 * Of 166 text nodes in the corpus, 165 land in a stack of two or more and take
 * their y from it; the single node placed alone does not read `middle`, so the
 * branch is unreachable here. `renderer-wins` made the same measurement with
 * the right control: forcing `y: 'top'` unconditionally ALSO changes nothing
 * across 120 fixture/target combinations. The corpus cannot distinguish any y
 * rule from any other, so the zero is a fact about the corpus, not about this
 * rule. What decides it is the argument above and the 1941px, not the zero.
 *
 * SO THIS IS A BEHAVIOUR CHANGE, NOT A DEAD-CODE DELETION, and an isolated text
 * node now anchors by its box geometry deliberately rather than by oversight.
 * Measured through `apply` on the case the corpus lacks -- one text node with
 * nothing within 10% of the frame on either axis, margins 430/350 in a 1000
 * frame, resized to 1000x2000: it lands at y = 970 by box geometry where the
 * removed rule put it at 860. Both answers are defensible for a lone caption,
 * which is the point: there was never evidence FOR the rule, only the symmetry
 * that put it there.
 *
 * Unreached is not unreachable, and the shape that would want it is written
 * down at the foot of tests/resize-artboard.test.ts rather than deleted with
 * the rule: a box far taller than its text, `valign: top`. What a future y rule
 * needs and this one lacked is a test for actual vertical SLACK -- `align` is
 * nearly always meaningful because a headline box is as wide as its column,
 * while `valign` is nearly always inert because a text box is as tall as its
 * text. Telling those apart means `layoutText` inside the command layer, which
 * should be bought with a design that visibly needs it, not with symmetry.
 */
function textAware(n: Node, a: Anchors): Anchors {
  if ((n as any).kind !== 'text' || a.x !== 'centre') return a;
  const align = (n as any).align;
  return { ...a, x: align === 'left' ? 'left' : align === 'right' ? 'right' : a.x };
}

/** Move a whole subtree by a delta, children included. */
function shiftSubtree(n: Node, dx: number, dy: number): Node {
  if (dx === 0 && dy === 0) return n;
  const a: any = { ...(n as any) };
  a.x = round(a.x + dx);
  a.y = round(a.y + dy);
  if (a.kind === 'group') a.children = ((a.children ?? []) as Node[]).map(c => shiftSubtree(c, dx, dy));
  return a as Node;
}

/*
 * VERTICAL STACKS.
 *
 * Anchoring each node independently tears designs apart, because a contiguous
 * column that straddles the frame's midline has some members nearer the top
 * edge and some nearer the bottom, and they leave in opposite directions. On
 * `social-gradient-launch` 1:1 -> 9:16 the headline's bottom landed at 1033 and
 * the body copy started at 1501: a 36px gap became 468px, a void the height of
 * the headline in the middle of a text column. 18 of 24 fixtures opened a gap
 * over 100px between two nodes that had been neighbours. It is visible in the
 * render, not just in the numbers.
 *
 * So adjacency is resolved BEFORE anchoring: nodes that read as one stack are
 * placed as one. Gaps inside a stack then scale by k like everything else, and
 * the frame's extra height is absorbed BETWEEN stacks -- which is what
 * "distribute down a taller frame" should mean, and what a designer does by
 * hand. A stack of one is the old behaviour exactly, so nothing that was
 * already right changes.
 *
 * MEMBERSHIP IS 2D, PLACEMENT IS Y ONLY, and the asymmetry is deliberate
 * rather than a simplification. Which nodes belong together is a question about
 * the whole plane -- a badge beside a name belongs with it -- so membership
 * looks at both axes. Where they go is not: horizontally each node is bound to
 * its own edge on the evidence of its own `align`, which a combined box does
 * not have. A cluster box for the launch template has 96px margins either side
 * and would classify as centred, undoing exactly the fix `textAware` exists to
 * make.
 */
type Stack = { members: number[]; box: { y: number; height: number } };

/*
 * Close enough to read as one stack, as a fraction of the frame on that axis.
 *
 * The corpus does NOT choose this number, and it is worth saying so rather than
 * implying a measurement settled it: 141 adjacent gaps run smoothly from 0 to
 * 29% of frame height with no valley to snap to (p50 2.7%, p85 8.0%). What
 * makes 10% safe is not that it is special but that the answer does not move
 * around it. Sweeping the whole corpus into a 9:16 frame:
 *
 *     gap    designs torn >100px    designs left in one clump
 *      0%         18 / 26                    2          <- what this replaces
 *      4%         14 / 26                    4
 *      6%          8 / 26                    7
 *      8%          3 / 26                   11
 *     10%          1 / 26                   13
 *     12%          1 / 26                   14
 *     15%          1 / 26                   17
 *
 * Tearing collapses up to 8-10% and then stops improving; clumping -- a design
 * that has stopped adapting and just sits in the frame as one block -- keeps
 * climbing. 10-12% is the flat spot between the two failure modes, so anywhere
 * in it gives the same answer and the exact value is not load-bearing. Below
 * 8% it very much is: at 6% a 42px gap in `business-card-mono` fell just
 * outside a 36px threshold and split a column that reads as one.
 *
 * The zero row is a control, not a data point: STACK_GAP = 0 disables
 * clustering entirely and reproduces the per-node behaviour this replaces.
 */
const STACK_GAP = 0.10;

/*
 * Bleed is not stack membership. A shape running off the page edge is
 * decoration behind the content, not a participant in its rhythm -- and it
 * would otherwise swallow the whole column, since a full-height blob sits
 * adjacent to everything.
 *
 * The tolerance is what makes this a real distinction rather than an equality
 * test on a float. `text-rules` has a last row overhanging its artboard by 10px
 * on 800 (1.25%); `social-gradient-launch` has gradient blobs overhanging by
 * 180px on 1080 (17%). Any tolerance between roughly 2% and 10% separates the
 * two identically, so the exact figure carries no weight -- the 13x between the
 * two populations does.
 */
const BLEED_TOLERANCE = 0.03;

function bleeds(b: { y: number; height: number }, frame: Frame): boolean {
  const slack = BLEED_TOLERANCE * frame.height;
  return b.y < -slack || b.y + b.height > frame.height + slack;
}

function stacksOf(boxes: readonly { x: number; y: number; width: number; height: number }[], frame: Frame): Stack[] {
  const eligible = boxes.map((b, i) => ({ i, b })).filter(e => !bleeds(e.b, frame));
  /* Union-find over every eligible PAIR rather than a sweep down the page. A
     sweep keeps one open cluster and closes it the moment a node joins nothing,
     so a design with two interleaved columns partitions by reading order
     instead of by adjacency -- and which nodes end up together then depends on
     the order they happen to sit in the array. */
  const parent = new Map<number, number>(eligible.map(e => [e.i, e.i]));
  const find = (i: number): number => {
    let r = i;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (i: number, j: number): void => { parent.set(find(i), find(j)); };

  for (let a = 0; a < eligible.length; a++) {
    for (let b = a + 1; b < eligible.length; b++) {
      const p = eligible[a]!.b, q = eligible[b]!.b;
      /* Proximity on BOTH axes, because the relationships that break are not
         all vertical. Requiring horizontal OVERLAP instead cost more than it
         bought: on `business-card-mono` the monogram badge sits 90px to the
         RIGHT of the name with no overlap, so the name's column moved down the
         story frame and left the badge behind at the top; `deck-section-mono`
         did the same to a numeral card and the title beside it. Both are
         visible in the render.
         Membership is 2D, placement is still y only -- see the note above. */
      const gapX = Math.max(p.x, q.x) - Math.min(p.x + p.width, q.x + q.width);
      const gapY = Math.max(p.y, q.y) - Math.min(p.y + p.height, q.y + q.height);
      // Negative is overlap, which is adjacency at its most emphatic: a label
      // sitting on its own button.
      if (gapX <= STACK_GAP * frame.width && gapY <= STACK_GAP * frame.height)
        union(eligible[a]!.i, eligible[b]!.i);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (const e of eligible) {
    const r = find(e.i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(e.i);
  }
  const out: Stack[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const bs = members.map(i => boxes[i]!);
    const top = Math.min(...bs.map(b => b.y));
    const bottom = Math.max(...bs.map(b => b.y + b.height));
    out.push({ members, box: { y: top, height: bottom - top } });
  }
  return out;
}

/** Where each stacked node's y and height land, keyed by index. A node in no
 *  stack is absent and anchors on its own, as before. */
function stackPlacements(
  boxes: readonly { x: number; y: number; width: number; height: number }[],
  from: Frame, to: Frame,
): Map<number, { y: number; height: number }> {
  const k = resizeFactor(from, to);
  const place = new Map<number, { y: number; height: number }>();
  for (const st of stacksOf(boxes, from)) {
    const anchors = classifyAnchors({ x: 0, y: st.box.y, width: from.width, height: st.box.height }, from);
    /* A stack is never stretched. Stretching one distributes the new height
       through its interior, which is the tear this exists to prevent; a column
       tall enough to read as full-bleed is still a column. */
    const y = anchors.y === 'stretch' ? 'middle' : anchors.y;
    const next = reanchor({ x: 0, y: st.box.y, width: 0, height: st.box.height }, { x: 'left', y }, from, to);
    for (const i of st.members) {
      const b = boxes[i]!;
      place.set(i, { y: round(next.y + (b.y - st.box.y) * k), height: round(b.height * k) });
    }
  }
  return place;
}

/*
 * One node's share of a Magic Resize.
 *
 * A group resolves against its DERIVED box rather than its stored one. The
 * stored box is metadata nothing draws from, so classifying against it would
 * anchor the group by a rectangle the user cannot see -- and a group whose
 * stored bounds were stale would relayout to the wrong edge while every
 * individual child looked correctly placed.
 */
function relayoutNode(n: Node, from: Frame, to: Frame, place?: { y: number; height: number }): Node {
  const k = resizeFactor(from, to);
  const box = nodeBox(n);
  const own = reanchor(box, textAware(n, classifyAnchors(box, from)), from, to);
  /* x from the node's own anchor, y from its stack's when it has one. */
  const next = place ? { ...own, ...place } : own;

  const sx = box.width > 0 ? next.width / box.width : 1;
  const sy = box.height > 0 ? next.height / box.height : 1;

  if ((n as any).kind !== 'group') {
    const a: any = { ...(n as any), x: next.x, y: next.y, width: next.width, height: next.height };
    /*
     * The UNIFORM factor, which is also min(sx, sy) for every anchor
     * combination -- not the vertical factor `scale` uses. The two rules differ
     * only on a stretch-anchored node, and there the vertical one overflows:
     * a stretch-y column keeps its height (ry = 1) while its width takes k, so
     * a font following ry stays put in a box half as wide. Measured at
     * 1000x1000 -> 500x1000: 9 lines became 19 and the block ran 28px past its
     * box. Following k keeps the wrap identical instead.
     *
     * This is what makes `resizeFactor`'s no-overflow guarantee hold, and that
     * guarantee is load-bearing -- it is why there is no auto-fit pass here.
     * `scale` still takes sy, and rightly: there k has no meaning, because the
     * user is stretching one axis on purpose.
     */
    if (a.kind === 'text') {
      a.fontSize = Math.max(1, round(a.fontSize * k));
      /* Tracking is horizontal and takes the horizontal factor. Safe against
         the same guarantee: on a stretch-x node the box grows by rx >= k while
         the glyphs grow by k, so the line has more room, not less. */
      a.letterSpacing = round(a.letterSpacing * sx);
    }
    return a as Node;
  }

  /* A rotated subtree stretched unevenly is the parallelogram `scale` refuses.
     Refusing here would be wrong -- picking a page preset must never fail --
     so it takes one factor and keeps its angle, landing proportionally placed
     rather than not at all. */
  const rotated = !!unscalableDescendant(n);
  const uniform = Math.abs(sx - sy) <= 1e-9 * Math.max(1, sx, sy);
  const [fx, fy] = rotated && !uniform ? [Math.min(sx, sy), Math.min(sx, sy)] : [sx, sy];

  /* Scaled about the box's own top-left, which leaves that corner fixed, then
     shifted onto the target. Solving for a fixed origin instead would divide
     by (1 - s) and blow up on the pure-move case, which a preset of the same
     aspect ratio produces constantly. */
  const scaled = scaleSubtree(n, fx, fy, box.x, box.y, Math.sqrt(fx * fy));
  return shiftSubtree(scaled, round(next.x - box.x), round(next.y - box.y));
}

function scaleSubtree(n: Node, sx: number, sy: number, ox: number, oy: number, k: number): Node {
  const a: any = { ...(n as any) };
  a.x = round(ox + (a.x - ox) * sx);
  a.y = round(oy + (a.y - oy) * sy);
  a.width = round(Math.max(0, a.width * sx));
  a.height = round(Math.max(0, a.height * sy));
  if (a.shadow) a.shadow = { ...a.shadow, x: round(a.shadow.x * sx), y: round(a.shadow.y * sy), blur: round(a.shadow.blur * k) };
  if (a.stroke) a.stroke = { ...a.stroke, width: round(a.stroke.width * k), dash: (a.stroke.dash ?? []).map((d: number) => round(d * k)) };
  if (typeof a.radius === 'number') a.radius = round(a.radius * k);
  if (a.kind === 'text') {
    // A font size is a VERTICAL measure, so it takes the vertical factor -- not
    // the geometric mean. Stretching a group sideways should widen the text
    // frame and let the text reflow, not enlarge the glyphs because half of a
    // horizontal stretch leaked into them. Letter spacing is the horizontal
    // counterpart and takes sx. Under a uniform scale all three agree, which is
    // the case that has to stay exact.
    //
    // The schema floors fontSize at 1, so an aggressive shrink would otherwise
    // produce a node that cannot be re-read from disk.
    a.fontSize = Math.max(1, round(a.fontSize * sy));
    a.letterSpacing = round(a.letterSpacing * sx);
  }
  if (a.effects?.length) a.effects = a.effects.map((e: any) => scaleEffect(e, sx, sy, k));
  if (a.kind === 'group') a.children = ((a.children ?? []) as Node[]).map(c => scaleSubtree(c, sx, sy, ox, oy, k));
  return a as Node;
}

export function apply(doc: Document, cmd: Command): Document {
  switch (cmd.type) {
    case 'batch':
      return cmd.commands.reduce((d, c) => apply(d, c), doc);

    case 'addNode':
      // A duplicate id is silent corruption rather than a no-op: findNode picks
      // whichever it sees last, updateNode patches both, removeNode deletes
      // both. Cheap to refuse, impossible to unpick later.
      if (findAny(doc, cmd.node.id)) {
        throw new InvalidCommandError(`A node with id "${cmd.node.id}" is already in the document.`);
      }
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = [...ab.nodes];
        nodes.splice(cmd.index ?? nodes.length, 0, cmd.node);
        return { ...ab, nodes };
      });

    case 'removeNode':
      // Throws on a node that is not there, like `updateNode`, `reorder` and
      // `group` do — and like this command's own `invert` already did. A filter
      // that quietly matches nothing reports a successful delete to whatever
      // asked for it, which is survivable in the editor (the user can see the
      // node is still on screen) and not survivable for an unattended caller.
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = (ab.nodes as Node[]).filter((n: Node) => n.id !== cmd.nodeId);
        if (nodes.length === ab.nodes.length) throw new StaleCommandError(cmd.nodeId);
        return { ...ab, nodes };
      });

    case 'updateNode': {
      // A key the node does not have is not an edit: the schema strips unknown
      // keys on the next parse, so the caller is told the change landed and
      // nothing about the document differs. A misspelled field name has to be
      // loud, or an unattended writer will keep sending it.
      const target = findAny(doc, cmd.nodeId);
      if (!target) throw new StaleCommandError(cmd.nodeId);
      // Ask the schema which fields exist, not the node in hand: an optional
      // field is absent from the instance and still perfectly settable --
      // `TextNode.fill` is exactly that, and `k in node` would reject the
      // command that puts a gradient on a piece of text.
      const fields = nodeFields((target as any).kind);
      const unknown = fields ? Object.keys(cmd.patch).filter(k => !fields.has(k)) : [];
      if (unknown.length) {
        throw new InvalidCommandError(
          `Node "${cmd.nodeId}" (${(target as any).kind}) has no field ${unknown.map(k => `"${k}"`).join(', ')}.`);
      }
      // A group's x/y is bounds metadata: `makeGroup` keeps children in
      // artboard space and render-svg's `case 'group'` emits no transform, so
      // writing it moves the selection handles and the Inspector readout and
      // not one drawn child. Refusing is the call `removeNode` and `reorder`
      // already make -- a command that cannot deliver what was asked has to say
      // so, or an unattended caller keeps sending it. Only a patch that would
      // actually CHANGE the position is refused: the drag commit sends x/y
      // unchanged alongside `rotation`, which a group does honour.
      if ((target as any).kind === 'group') {
        // Compared at the precision the document stores rather than with
        // `!==`: a caller that round-trips a group's width through a float
        // computation before restating it would otherwise be told it was
        // resizing when it was not, and the message would talk about resizing
        // on a gesture that only rotated. Reported by the `tests` session; no
        // caller does this today, and comparing rounded removes the class
        // rather than the instance.
        const changes = (k: 'x' | 'y' | 'width' | 'height') =>
          k in cmd.patch && round(Number(cmd.patch[k])) !== round(Number((target as any)[k]));
        const moves = (['x', 'y'] as const).filter(changes);
        const sizes = (['width', 'height'] as const).filter(changes);
        // Size is refused for the same reason as position, and now with an
        // alternative to offer: `scale` multiplies the whole subtree about a
        // pinned origin, so the message names it rather than reporting a gap
        // that has since been filled. This half said "no command scales a
        // subtree yet" for as long as that was true and for one commit longer,
        // which is how a correct guard turns into a wrong signpost -- the
        // refusal keeps working and the sentence quietly stops being about
        // the code. Flagged by the `renderer-wins` session, whose guard it is.
        if (moves.length || sizes.length) {
          const list = (ks: readonly string[]) => ks.map(k => `"${k}"`).join(' and ');
          const why = [
            moves.length ? `patching ${list(moves)} would move its bounds but none of its children -- use a "translate" command instead` : '',
            sizes.length ? `patching ${list(sizes)} would resize its bounds but none of its children -- use a "scale" command instead` : '',
          ].filter(Boolean).join('; ');
          throw new InvalidCommandError(`Node "${cmd.nodeId}" is a group, so ${why}.`);
        }
      }
      return mapNodes(doc, n => (n.id === cmd.nodeId ? patchNode(n, cmd.patch) : n));
    }

    case 'reorder':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = [...ab.nodes];
        const from = nodes.findIndex((n: Node) => n.id === cmd.nodeId);
        if (from < 0) throw new StaleCommandError(cmd.nodeId);
        const [moved] = nodes.splice(from, 1);
        nodes.splice(Math.max(0, Math.min(nodes.length, cmd.to)), 0, moved!);
        return { ...ab, nodes };
      });

    case 'group':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = ab.nodes as Node[];
        const ids = cmd.nodeIds;
        if (ids.length === 0 || new Set(ids).size !== ids.length) throw new StaleCommandError(cmd.groupId);
        const picked = ids.map(id => {
          const index = nodes.findIndex((n: Node) => n.id === id);
          if (index < 0) throw new StaleCommandError(id);
          return { index, node: nodes[index]! };
        }).sort((a, b) => a.index - b.index);

        const topmost = picked[picked.length - 1]!.index;
        const taken = new Set(ids);
        const rest = nodes.filter((n: Node) => !taken.has(n.id));
        // The group lands where the topmost member sat, once the members below
        // it have been lifted out.
        const at = clampIndex(cmd.index ?? topmost - (picked.length - 1), rest.length);
        const group = cmd.node ?? makeGroup(cmd.groupId, picked.map(p => p.node));
        const next = [...rest];
        next.splice(at, 0, group);
        return { ...ab, nodes: next };
      });

    case 'ungroup':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const nodes = ab.nodes as Node[];
        const gi = nodes.findIndex((n: Node) => n.id === cmd.groupId);
        const group = gi < 0 ? undefined : nodes[gi];
        if (!group || (group as any).kind !== 'group') throw new StaleCommandError(cmd.groupId);
        const children = (((group as any).children ?? []) as Node[]);
        const rest = nodes.filter((_: Node, i: number) => i !== gi);

        if (!cmd.indices) {
          const next = [...rest];
          next.splice(gi, 0, ...children);
          return { ...ab, nodes: next };
        }

        // Undo of `group`: every child goes back to the exact slot it came from.
        const total = rest.length + children.length;
        if (cmd.indices.length !== children.length) throw new StaleCommandError(cmd.groupId);
        const slots: Array<Node | undefined> = new Array(total).fill(undefined);
        cmd.indices.forEach((slot, i) => {
          if (!Number.isInteger(slot) || slot < 0 || slot >= total || slots[slot] !== undefined) {
            throw new StaleCommandError(cmd.groupId);
          }
          slots[slot] = children[i]!;
        });
        let cursor = 0;
        const next = slots.map(s => s ?? rest[cursor++]!);
        return { ...ab, nodes: next };
      });

    case 'setArtboard':
      return mapArtboard(doc, cmd.artboardId, ab => {
        const fields = artboardFields();
        const unknown = Object.keys(cmd.patch).filter(k => !fields.has(k));
        if (unknown.length) {
          throw new InvalidCommandError(
            `Artboard "${cmd.artboardId}" has no field ${unknown.map(k => `"${k}"`).join(', ')}.`);
        }
        return { ...ab, ...cmd.patch };
      });

    case 'resizeArtboard': {
      const ab: any = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      if (!Number.isFinite(cmd.width) || !Number.isFinite(cmd.height) || cmd.width <= 0 || cmd.height <= 0) {
        throw new InvalidCommandError(
          `resizeArtboard needs finite positive dimensions; got ${cmd.width}x${cmd.height}.`);
      }
      const from: Frame = { width: ab.width, height: ab.height };
      const to: Frame = { width: cmd.width, height: cmd.height };
      if (from.width === to.width && from.height === to.height) return doc;
      return mapArtboard(doc, cmd.artboardId, a => ({
        ...a, width: to.width, height: to.height,
        nodes: (() => {
          const nodes = a.nodes as Node[];
          const place = stackPlacements(nodes.map(nodeBox), from, to);
          return nodes.map((n, i) => relayoutNode(n, from, to, place.get(i)));
        })(),
      }));
    }

    case 'translate': {
      // Every target is checked before anything moves, so a batch naming one
      // stale id cannot leave the rest half-translated.
      for (const id of cmd.nodeIds) if (!findAny(doc, id)) throw new StaleCommandError(id);
      if (cmd.dx === 0 && cmd.dy === 0) return doc;

      const shift = (n: Node): Node => {
        const next: any = { ...(n as any), x: round((n as any).x + cmd.dx), y: round((n as any).y + cmd.dy) };
        if (next.kind === 'group') next.children = ((next.children ?? []) as Node[]).map(shift);
        return next as Node;
      };
      // Once a node matches we move its whole subtree and stop looking inside
      // it: selecting a group AND one of its own children must not move that
      // child twice. Nesting is handled by `shift` recursing, not by `rec`.
      const wanted = new Set(cmd.nodeIds);
      const rec = (nodes: Node[]): Node[] => nodes.map(n => {
        if (wanted.has(n.id)) return shift(n);
        if ((n as any).kind === 'group') return { ...(n as any), children: rec(((n as any).children ?? []) as Node[]) };
        return n;
      });
      return { ...doc, artboards: doc.artboards.map(ab => ({ ...ab, nodes: rec(ab.nodes as Node[]) })) };
    }

    case 'scale': {
      for (const id of cmd.nodeIds) if (!findAny(doc, id)) throw new StaleCommandError(id);
      if (![cmd.sx, cmd.sy, cmd.ox, cmd.oy].every(Number.isFinite) || cmd.sx <= 0 || cmd.sy <= 0) {
        throw new InvalidCommandError(
          `scale needs finite positive factors about a finite origin; got sx=${cmd.sx}, sy=${cmd.sy}, origin=(${cmd.ox}, ${cmd.oy}). Mirroring is flipX/flipY, not a negative scale.`);
      }
      if (cmd.sx === 1 && cmd.sy === 1) return doc;
      // Compared with a tolerance rather than `!==`: sx and sy arrive from
      // dividing one measured box by another, so a genuinely square drag can
      // produce factors differing in the last bits, and an exact test would
      // refuse it while claiming the shape cannot be represented.
      const uniform = Math.abs(cmd.sx - cmd.sy) <= 1e-9 * Math.max(1, cmd.sx, cmd.sy);
      if (!uniform) {
        for (const id of cmd.nodeIds) {
          const blocked = unscalableDescendant(findAny(doc, id) as Node);
          if (blocked) {
            throw new InvalidCommandError(
              `Cannot scale "${id}" by different x and y factors: "${blocked.id}" is rotated ${(blocked as any).rotation}deg, and a rotated box stretched unevenly becomes a parallelogram, which a node cannot represent. Scale it uniformly instead.`);
          }
        }
      }
      const k = Math.sqrt(cmd.sx * cmd.sy);
      // Same subtree-stop walk as `translate`, and for the same reason:
      // selecting a group AND one of its children must not scale that child
      // twice, which would compound rather than double.
      const wanted = new Set(cmd.nodeIds);
      const rec = (nodes: Node[]): Node[] => nodes.map(n => {
        if (wanted.has(n.id)) return scaleSubtree(n, cmd.sx, cmd.sy, cmd.ox, cmd.oy, k);
        if ((n as any).kind === 'group') return { ...(n as any), children: rec(((n as any).children ?? []) as Node[]) };
        return n;
      });
      return { ...doc, artboards: doc.artboards.map(ab => ({ ...ab, nodes: rec(ab.nodes as Node[]) })) };
    }

    case 'replaceNodes': {
      const byId = new Map(cmd.nodes.map(n => [n.id, n]));
      for (const id of byId.keys()) if (!findAny(doc, id)) throw new StaleCommandError(id);
      const rec = (nodes: Node[]): Node[] => nodes.map(n => {
        const replacement = byId.get(n.id);
        if (replacement) return replacement;
        if ((n as any).kind === 'group') return { ...(n as any), children: rec(((n as any).children ?? []) as Node[]) };
        return n;
      });
      return { ...doc, artboards: doc.artboards.map(ab => ({ ...ab, nodes: rec(ab.nodes as Node[]) })) };
    }

    case 'addAsset':
      return { ...doc, assets: { ...doc.assets, [cmd.asset.id]: cmd.asset } };

    // Unreachable for typed callers, and that is exactly the risk: without it a
    // union member added here but missed below falls off the end and returns
    // `undefined`, which every caller assigns straight back over its document.
    // A missing case must be loud at the moment it is introduced.
    default:
      throw new InvalidCommandError(`apply: unhandled command type "${(cmd as Command).type}".`);
  }
}

/** Produce the command that undoes `cmd`, captured against the doc BEFORE it was applied. */
export function invert(doc: Document, cmd: Command): Command {
  switch (cmd.type) {
    case 'batch': {
      /*
       * Each child is inverted against the document as it stood immediately
       * BEFORE that child ran, not against the batch's starting document.
       *
       * That distinction is the whole correctness of a batch. The inverse of
       * `removeNode` is `addNode` at an INDEX, and the inverse of `reorder` is
       * another index — and indices shift as earlier children of the same batch
       * are applied. Capturing every inverse against the starting document made
       * deleting two non-adjacent nodes in one gesture come back in the wrong
       * z-order on undo. So: walk forward capturing inverses against the live
       * state, then reverse the list, because undo runs the last thing first.
       */
      const inverses: Command[] = [];
      let d = doc;
      for (const c of cmd.commands) { inverses.push(invert(d, c)); d = apply(d, c); }
      inverses.reverse();
      return { type: 'batch', label: `Undo ${cmd.label}`, commands: inverses };
    }

    case 'addNode':
      if (!doc.artboards.some(a => a.id === cmd.artboardId)) throw new StaleArtboardError(cmd.artboardId);
      return { type: 'removeNode', artboardId: cmd.artboardId, nodeId: cmd.node.id };

    case 'removeNode': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      const index = ab.nodes.findIndex((n: Node) => n.id === cmd.nodeId);
      const node = ab.nodes[index];
      if (!node) throw new StaleCommandError(cmd.nodeId);
      return { type: 'addNode', artboardId: cmd.artboardId, node: node as Node, index };
    }

    case 'updateNode': {
      const node = findAny(doc, cmd.nodeId);
      if (!node) throw new StaleCommandError(cmd.nodeId);
      // A key the node does not currently have is captured as `undefined`,
      // which `patchNode` reads as "remove it again". Recording the absence
      // any other way makes undo *add* the key back as an explicit undefined,
      // so a document stops matching itself across a set + undo.
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) before[k] = (node as any)[k];
      return { type: 'updateNode', nodeId: cmd.nodeId, patch: before };
    }

    case 'reorder': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      // An unchecked findIndex made this return a reorder to index -1, so the
      // failure surfaced later inside apply, one step from its cause — while
      // every sibling case threw here.
      const from = (ab.nodes as Node[]).findIndex((n: Node) => n.id === cmd.nodeId);
      if (from < 0) throw new StaleCommandError(cmd.nodeId);
      return { type: 'reorder', artboardId: cmd.artboardId, nodeId: cmd.nodeId, to: from };
    }

    case 'group': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleCommandError(cmd.groupId);
      const indices = cmd.nodeIds.map(id => {
        const i = (ab.nodes as Node[]).findIndex((n: Node) => n.id === id);
        if (i < 0) throw new StaleCommandError(id);
        return i;
      }).sort((a, b) => a - b);
      // `makeGroup` keeps the members in document order, so `indices` (ascending)
      // lines up index-for-index with the group's children.
      return { type: 'ungroup', artboardId: cmd.artboardId, groupId: cmd.groupId, indices };
    }

    case 'ungroup': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      const index = ab ? (ab.nodes as Node[]).findIndex((n: Node) => n.id === cmd.groupId) : -1;
      const group = ab && index >= 0 ? (ab.nodes as Node[])[index] : undefined;
      if (!group || (group as any).kind !== 'group') throw new StaleCommandError(cmd.groupId);
      const children = (((group as any).children ?? []) as Node[]);
      return {
        type: 'group', artboardId: cmd.artboardId, groupId: cmd.groupId,
        nodeIds: children.map(c => c.id), node: group, index,
      };
    }

    case 'setArtboard': {
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      const before: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) before[k] = (ab as any)[k];
      return { type: 'setArtboard', artboardId: cmd.artboardId, patch: before };
    }

    case 'resizeArtboard': {
      /*
       * Captured, not recomputed, for the reason `scale` captures: every node
       * lands through `round` at 2dp, so resizing back by the reciprocal ratio
       * does not return the original numbers. It returns numbers a hundredth
       * out, which reads as noise rather than as a broken undo -- the worst
       * shape a bug can take.
       *
       * Both halves are needed and neither is sufficient: the dimensions
       * without the nodes leaves a relayout applied to the old frame, and the
       * nodes without the dimensions leaves the page the wrong size.
       *
       * The capture is not only a rounding defence. `resizeFactor` takes the
       * MINIMUM of the two ratios, which is what "nothing overflows" means and
       * makes the transform lossy in the return direction: square -> story is
       * k = 1, story -> square is k = 0.5625, so resizing there and back lands
       * at 56%. Capturing makes this the only EXACT way back. "Try a story,
       * dislike it, go back" is Cmd+Z, not a second resize -- they are
       * different gestures and only one of them is a resize.
       */
      const ab = doc.artboards.find(a => a.id === cmd.artboardId);
      if (!ab) throw new StaleArtboardError(cmd.artboardId);
      return {
        type: 'batch', label: 'resize page',
        commands: [
          { type: 'setArtboard', artboardId: cmd.artboardId, patch: { width: (ab as any).width, height: (ab as any).height } },
          { type: 'replaceNodes', nodes: (ab as any).nodes as Node[] },
        ],
      };
    }

    case 'translate': {
      // Checked here as well as in `apply`, so an undo entry that can no longer
      // run is dropped by `undo`'s StaleCommandError path rather than throwing
      // out of the reducer.
      for (const id of cmd.nodeIds) if (!findAny(doc, id)) throw new StaleCommandError(id);
      return { type: 'translate', nodeIds: cmd.nodeIds, dx: -cmd.dx, dy: -cmd.dy };
    }

    case 'scale':
    case 'replaceNodes': {
      // Captured, not computed. Scaling rounds to 2dp, so the reciprocal scale
      // does not land back on the original numbers -- undo has to carry the
      // subtree it is going to put back. `replaceNodes` inverts the same way,
      // which makes undo/redo of a resize symmetrical.
      const ids = cmd.type === 'scale' ? cmd.nodeIds : cmd.nodes.map(n => n.id);
      const nodes = ids.map(id => {
        const n = findAny(doc, id);
        if (!n) throw new StaleCommandError(id);
        return n as Node;
      });
      return { type: 'replaceNodes', nodes };
    }

    case 'addAsset':
      return { type: 'batch', label: 'noop', commands: [] };

    // See `apply`. A missed case here is worse: `invert` returning `undefined`
    // pushes a non-command onto the undo stack, so the failure surfaces on a
    // later ctrl-Z rather than on the edit that caused it.
    default:
      throw new InvalidCommandError(`invert: unhandled command type "${(cmd as Command).type}".`);
  }
}

/* ── history ────────────────────────────────────────────────────────────── */
export interface History { past: Command[]; future: Command[]; }
export const emptyHistory = (): History => ({ past: [], future: [] });
export const MAX_HISTORY = 500;

export function commit(doc: Document, history: History, cmd: Command): { doc: Document; history: History } {
  const undoCmd = invert(doc, cmd);
  const next = apply(doc, cmd);
  const past = [...history.past, undoCmd].slice(-MAX_HISTORY);
  return { doc: next, history: { past, future: [] } };
}

export function undo(doc: Document, history: History): { doc: Document; history: History } {
  const cmd = history.past[history.past.length - 1];
  if (!cmd) return { doc, history };
  try {
    const redoCmd = invert(doc, cmd);
    return { doc: apply(doc, cmd), history: { past: history.past.slice(0, -1), future: [...history.future, redoCmd] } };
  } catch (e) {
    if (e instanceof StaleCommandError) return { doc, history: { past: history.past.slice(0, -1), future: [] } };
    throw e;
  }
}

export function redo(doc: Document, history: History): { doc: Document; history: History } {
  const cmd = history.future[history.future.length - 1];
  if (!cmd) return { doc, history };
  try {
    const undoCmd = invert(doc, cmd);
    return { doc: apply(doc, cmd), history: { past: [...history.past, undoCmd], future: history.future.slice(0, -1) } };
  } catch (e) {
    if (e instanceof StaleCommandError) return { doc, history: { ...history, future: [] } };
    throw e;
  }
}

/* ── helpers ────────────────────────────────────────────────────────────── */
/**
 * Every artboard-scoped command routes through here, so an id that matches
 * nothing used to be a silent success for all six of them: addNode, removeNode,
 * reorder, group, ungroup and setArtboard each returned the document untouched
 * and reported that the edit had happened. Survivable in the editor, where the
 * artboard id comes from the thing you clicked; not survivable for an
 * unattended caller that only sees the return value.
 */
/**
 * Apply a patch to a node. An `undefined` value removes the field rather than
 * setting it: that is the only way undo can restore a node that legitimately
 * did not have an optional field, and `{...n, fill: undefined}` is not the
 * same document as one with no `fill` at all.
 */
/**
 * Apply `patch` to `n` and re-validate the result against the schema.
 *
 * The validation is the point. `updateNode` already refuses a patch naming a
 * field the node does not have, which reads like enough checking and is not:
 * the VALUE went in unexamined, so `radius: -50` or `opacity: 9` was accepted,
 * written to the document, saved to disk, and only surfaced much later when
 * something unrelated re-validated -- grouping the node, or reopening the file
 * -- as `Invalid rect node: Number must be greater than or equal to 0`, with
 * nothing left pointing at the command that wrote it. A stored value the
 * schema rejects is corruption whether or not anything has noticed yet, and
 * the moment to refuse it is the moment it arrives.
 *
 * `buildNode` rather than a bare parse, and no `as Node`: the cast is what let
 * this through, because it silences the compiler precisely when the schema
 * knows something the local code does not.
 */
function patchNode(n: Node, patch: Record<string, unknown>): Node {
  const next: Record<string, unknown> = { ...(n as any) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  try {
    return buildNode(next);
  } catch (e) {
    throw new InvalidCommandError(
      `Patching "${(n as any).id}" with ${JSON.stringify(patch)} would make it invalid: ${(e as Error).message}`);
  }
}

function mapArtboard(doc: Document, id: string, fn: (ab: any) => any): Document {
  if (!doc.artboards.some(ab => ab.id === id)) throw new StaleArtboardError(id);
  return { ...doc, artboards: doc.artboards.map(ab => (ab.id === id ? fn(ab) : ab)) };
}
function mapNodes(doc: Document, fn: (n: Node) => Node): Document {
  const rec = (nodes: Node[]): Node[] => nodes.map(n => {
    const mapped = fn(n);
    if ((mapped as any).kind === 'group') return { ...(mapped as any), children: rec((mapped as any).children ?? []) };
    return mapped;
  });
  return { ...doc, artboards: doc.artboards.map(ab => ({ ...ab, nodes: rec(ab.nodes as Node[]) })) };
}
function findAny(doc: Document, id: string): Node | null {
  let found: Node | null = null;
  const rec = (nodes: Node[]) => { for (const n of nodes) { if (n.id === id) found = n; if ((n as any).kind === 'group') rec((n as any).children ?? []); } };
  for (const ab of doc.artboards) rec(ab.nodes as Node[]);
  return found;
}

const clampIndex = (i: number, max: number): number => Math.max(0, Math.min(max, i));

/** A fresh group whose box is the union of its members' rotated bounds. */
function makeGroup(id: string, members: Node[]): Node {
  const boxes = members.map(m => aabb({
    x: (m as any).x, y: (m as any).y,
    width: (m as any).width, height: (m as any).height,
    rotation: (m as any).rotation ?? 0,
  }));
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.width));
  const maxY = Math.max(...boxes.map(b => b.y + b.height));
  // Through `buildNode`, never a hand-written literal cast to `Node`: the cast
  // silences the compiler exactly when the schema grows a field this forgot, so
  // the group a user makes stops matching the group a reload parses and the
  // document no longer survives save/load unchanged. Zod fills every default.
  return buildNode({
    id, name: 'Group', kind: 'group',
    x: minX, y: minY, width: maxX - minX, height: maxY - minY,
    // Children stay in artboard space - render-svg's `case 'group'` draws each
    // child with its own absolute x/y and adds no translate of its own.
    children: members,
  });
}

export const uid = (prefix = 'n'): string => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
