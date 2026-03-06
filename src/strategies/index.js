// Strategy Registry
// Để thêm strategy mới: import + push vào STRATEGIES array.
// Không cần sửa engine hay UI.

import { PivotReversalStrategy }    from "./pivotReversal";
import { PivotReversalAtrStrategy } from "./pivotReversalAtr";
import { PivotReversalRsiStrategy } from "./pivotReversalRsi";

export const STRATEGIES = [
  PivotReversalStrategy,
  PivotReversalAtrStrategy,
  PivotReversalRsiStrategy,
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
