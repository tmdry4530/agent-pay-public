import { parseArgs } from 'node:util';
import { runAgent } from './agent.ts';
import { SCENARIO_NAMES, isScenarioName, type ScenarioName } from './scenarios.ts';

const HELP = `agent-pay task agent (demo CLI)

Usage:
  node src/cli.ts [--task <text> | <task...>] [--scenario small|over-limit|needs-approval]
  npm run agent -w @agent-pay/agent -- --scenario small

Options:
  --api <url>              API base URL (default: http://127.0.0.1:8787)
  --agent-id <id>          Agent id (default: demo-agent)
  --task <text>            Task description for the planner
  --scenario <name>        Built-in demo task: small | over-limit | needs-approval
  --timeout-ms <n>         Approval wait and pending-receipt wait timeout (default: 120000)
  --poll-ms <n>            Ledger / refresh poll interval (default: 1000)
  --auto-approve-as <name> DEMO ONLY: simulate the human by calling POST /intents/:id/approve
                           from this CLI after the "waiting for human approval" step
  --approve-delay-ms <n>   Pause before the simulated approval (default: 1000)
  --json                   NDJSON on stdout: one {"type":"step"} per step, last line {"type":"summary"}
  --help                   Show this help

Exit codes: 0 paid, 2 rejected, 3 approval timeout / receipt still pending, 1 error/failed
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      api: { type: 'string', default: 'http://127.0.0.1:8787' },
      'agent-id': { type: 'string', default: 'demo-agent' },
      task: { type: 'string' },
      scenario: { type: 'string' },
      'timeout-ms': { type: 'string', default: '120000' },
      'poll-ms': { type: 'string', default: '1000' },
      'auto-approve-as': { type: 'string' },
      'approve-delay-ms': { type: 'string', default: '1000' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exitCode = 0;
    return;
  }

  let scenario: ScenarioName | undefined;
  if (values.scenario !== undefined) {
    if (!isScenarioName(values.scenario)) {
      console.error(`invalid scenario: ${values.scenario} (expected ${SCENARIO_NAMES.join(' | ')})`);
      process.exitCode = 1;
      return;
    }
    scenario = values.scenario;
  }

  const taskFromPos = positionals.length > 0 ? positionals.join(' ') : undefined;
  const task = values.task ?? taskFromPos;

  if (scenario && task) {
    console.error('use either --scenario or a task, not both');
    process.exitCode = 1;
    return;
  }
  if (!scenario && !task) {
    console.error('missing task or --scenario (see --help)');
    process.exitCode = 1;
    return;
  }

  const timeoutMs = Number(values['timeout-ms']);
  const pollMs = Number(values['poll-ms']);
  const approveDelayMs = Number(values['approve-delay-ms']);
  if (!Number.isFinite(approveDelayMs) || approveDelayMs < 0) {
    console.error('invalid --approve-delay-ms');
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    console.error('invalid --timeout-ms');
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    console.error('invalid --poll-ms');
    process.exitCode = 1;
    return;
  }

  const result = await runAgent({
    apiUrl: values.api!,
    agentId: values['agent-id']!,
    task,
    scenario,
    json: values.json,
    timeoutMs,
    pollMs,
    autoApproveAs: values['auto-approve-as'],
    approveDelayMs,
  });

  process.exitCode = result.exitCode;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
