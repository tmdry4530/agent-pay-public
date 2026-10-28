/**
 * Built-in demo scenarios. Each is a task string run through the RuleBasedPlanner, sized against the seed
 * policy (demo-agent: perTxMax 100, dailyMax 200, approval above 50, USD, openai-api allowed).
 */
export const SCENARIOS = {
  /** 1M tokens x 10 USD = 10 USD → auto-approved and paid. */
  small: { task: 'buy 1M tokens of GPT inference', expect: 'paid' },
  /** 15M tokens = 150 USD → rejected (per_tx_limit_exceeded, perTxMax 100). */
  'over-limit': { task: 'buy 15M tokens of GPT inference', expect: 'rejected' },
  /** 7.5M tokens = 75 USD → needs_approval (above 50), then paid once a human approves. */
  'needs-approval': { task: 'buy 7.5M tokens of GPT inference', expect: 'needs_approval' },
} as const;

export type ScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

export function isScenarioName(value: string): value is ScenarioName {
  return Object.hasOwn(SCENARIOS, value);
}
