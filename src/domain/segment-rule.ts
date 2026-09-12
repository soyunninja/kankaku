/**
 * A rule that tags a tool execution as belonging to a named segment (e.g.
 * `review`) when the tool name matches `tool` and the tool's argument text
 * matches `pattern`.
 */
export interface SegmentRule {
  tag: string;
  tool: string;
  pattern: RegExp;
}
