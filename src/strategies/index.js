// Strategy Registry
// Để thêm strategy mới: import + push vào STRATEGIES array.
// Không cần sửa engine hay UI.

import { PivotReversalStrategy }   from "./pivotReversal";
import { PrpPivotPsarStrategy }    from "./prpPivotPsar";
import { ChannelBreakoutStrategy } from "./channelBreakout";
import { MomentumStrategy }        from "./momentum";

export const STRATEGIES = [
  PivotReversalStrategy,
  PrpPivotPsarStrategy,
  ChannelBreakoutStrategy,
  MomentumStrategy,
];

export const STRATEGY_MAP = Object.fromEntries(
  STRATEGIES.map((s) => [s.id, s])
);

// Lấy default params từ paramSchema của strategy
export function getDefaultParams(strategy) {
  return Object.fromEntries(
    Object.entries(strategy.paramSchema).map(([key, schema]) => [key, schema.default])
  );
}
