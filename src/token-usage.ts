import type { CompletionUsage } from 'openai/resources/completions';

// This is a user-configured capacity, not model metadata or a claim about provider limits.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

function validateCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('OPENAI_CONTEXT_WINDOW_TOKENS 必须是正的安全整数（tokens）');
  }
  return value;
}

export function contextWindowTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENAI_CONTEXT_WINDOW_TOKENS;
  if (raw === undefined) return DEFAULT_CONTEXT_WINDOW_TOKENS;
  return validateCapacity(Number(raw));
}

type Count = number | null;
export interface TokenCounts {
  input: Count;
  output: Count;
  total: Count;
  cached: Count;
  reasoning: Count;
}

export interface UsageSnapshot {
  calls: number;
  single: TokenCounts;
  cumulative: TokenCounts;
  knownSubtotal: TokenCounts;
  promptDetails: Record<string, number>;
  completionDetails: Record<string, number>;
  context: {
    // Latest API-reported prompt only; never cumulative spend or a local token estimate.
    inputTokens: Count;
    capacityTokens: number;
    percent: Count;
  };
}

function count(value: unknown): Count {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function details(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => count(entry[1]) !== null));
}

const emptyCounts = (value: Count): TokenCounts => ({ input: value, output: value, total: value, cached: value, reasoning: value });

/** One instance per runAgent invocation: main and child runs never share counters. */
export class TokenUsageTracker {
  private calls = 0;
  private cumulative = emptyCounts(0);
  private subtotal = emptyCounts(0);

  constructor(private readonly capacityTokens = contextWindowTokens()) {
    validateCapacity(capacityTokens);
  }

  record(usage: CompletionUsage | null | undefined): UsageSnapshot {
    this.calls += 1;
    const promptDetails = details(usage?.prompt_tokens_details);
    const completionDetails = details(usage?.completion_tokens_details);
    const single: TokenCounts = {
      input: count(usage?.prompt_tokens),
      output: count(usage?.completion_tokens),
      total: count(usage?.total_tokens),
      cached: count(promptDetails.cached_tokens),
      reasoning: count(completionDetails.reasoning_tokens),
    };
    for (const key of Object.keys(single) as (keyof TokenCounts)[]) {
      const value = single[key];
      this.subtotal[key] = (this.subtotal[key] ?? 0) + (value ?? 0);
      const previous = this.cumulative[key];
      this.cumulative[key] = previous === null || value === null ? null : previous + value;
    }
    return {
      calls: this.calls,
      single,
      cumulative: { ...this.cumulative },
      knownSubtotal: { ...this.subtotal },
      promptDetails,
      completionDetails,
      context: {
        inputTokens: single.input,
        capacityTokens: this.capacityTokens,
        percent: single.input === null ? null : single.input / this.capacityTokens * 100,
      },
    };
  }
}

const compactNumber = new Intl.NumberFormat('en-US', {
  notation: 'compact', maximumFractionDigits: 1,
});
const display = (value: Count): string => value === null ? '—' : compactNumber.format(value);
const exact = (value: Count): string => value === null ? 'unknown' : String(value);

function formatCounts(counts: TokenCounts): string {
  return `input=${exact(counts.input)} output=${exact(counts.output)} total=${exact(counts.total)} cached=${exact(counts.cached)} reasoning=${exact(counts.reasoning)}`;
}

function formatPercent(value: Count): string {
  if (value === null) return '—';
  if (value > 0 && value < 0.0001) return '<0.0001%';
  return `${Number(value.toFixed(value > 0 && value < 0.01 ? 4 : 2))}%`;
}

export function formatUsage(snapshot: UsageSnapshot, logPrefix = '', verbose = false): string[] {
  const tag = logPrefix || '[main]';
  const { single, cumulative, knownSubtotal, context } = snapshot;
  const total = cumulative.total === null
    ? `已知 ${display(knownSubtotal.total)}`
    : display(cumulative.total);
  const details = [
    `上下文 ${formatPercent(context.percent)} (${display(context.inputTokens)} / ${display(context.capacityTokens)})`,
  ];
  if (single.cached !== null) details.push(`缓存 ${display(single.cached)}`);
  if (single.reasoning !== null) details.push(`推理 ${display(single.reasoning)}`);
  const lines = [
    `${tag} tokens #${snapshot.calls}  输入 ${display(single.input)} · 输出 ${display(single.output)} · 本次 ${display(single.total)} · 累计 ${total}`,
    `${tag}   └ ${details.join(' · ')}`,
  ];
  if (verbose) {
    lines.push(`${tag}   单次: ${formatCounts(single)}`);
    lines.push(`${tag}   累计: ${formatCounts(cumulative)}`);
    if (Object.values(cumulative).includes(null)) {
      lines.push(`${tag}   已知小计: ${formatCounts(knownSubtotal)}`);
    }
    lines.push(`${tag}   prompt_tokens_details=${JSON.stringify(snapshot.promptDetails)} completion_tokens_details=${JSON.stringify(snapshot.completionDetails)}`);
    lines.push(`${tag}   上下文输入: ${exact(context.inputTokens)}/${context.capacityTokens} tokens（最近请求 prompt）`);
  }
  return lines;
}
