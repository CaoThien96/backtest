// Strategy Registry
// Để thêm strategy mới: import + push vào STRATEGIES array.
// Không cần sửa engine hay UI.

import { PivotReversalStrategy }    from "./pivotReversal";
import { PivotReversalAtrStrategy } from "./pivotReversalAtr";
import { PivotReversalRsiStrategy } from "./pivotReversalRsi";
import { MomentumZigzagStrategy }   from "./momentumZigzag";
import { PrpPivotPsarStrategy }     from "./prpPivotPsar";
import { ChannelBreakoutStrategy }  from "./channelBreakout";
import { MomentumStrategy }         from "./momentum";
import { CenteredRsiCrossStrategy } from "./centeredRsiCross";
import { Ema200TrendlineBreakoutStrategy } from "./ema200TrendlineBreakout";
import { PivotSupertrendStrategy }  from "./pivotSupertrend";
import { PivotHiloFilteringStrategy } from "./pivotHiloFiltering";

export const STRATEGIES = [
  PivotReversalStrategy,
  PivotReversalAtrStrategy,
  PivotReversalRsiStrategy,
  MomentumZigzagStrategy,
  PrpPivotPsarStrategy,
  ChannelBreakoutStrategy,
  MomentumStrategy,
  CenteredRsiCrossStrategy,
  Ema200TrendlineBreakoutStrategy,
  PivotSupertrendStrategy,
  PivotHiloFilteringStrategy,
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
