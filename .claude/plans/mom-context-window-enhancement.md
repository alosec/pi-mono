# Mom Bot Context Window Enhancement Plan

## Overview

Transform the mom bot's static 50-message context limit into an intelligent roving window that maximizes the 200K token context, with real-time usage visibility.

---

## Visual Design

### Slack Thread Footer (Usage Indicator)

```
┌─────────────────────────────────────────────────────────────────┐
│  @mom what was the architecture decision we made last week?     │
├─────────────────────────────────────────────────────────────────┤
│  _Searching message history..._                                 │
│                                                                 │
│  Based on the conversation from Nov 23rd, you decided to use    │
│  PostgreSQL with a read replica for the analytics service.      │
│  The key reasons were:                                          │
│  • Familiar tooling for the team                                │
│  • Built-in partitioning for time-series data                   │
│  • Cost efficiency vs TimescaleDB                               │
├─────────────────────────────────────────────────────────────────┤
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓  43.2K/200K tokens           │
│  └─ cached (32K) ─────────────┘└ new ┘                          │
│  📊 267 messages in context │ 🕐 Nov 18 - Nov 30                │
└─────────────────────────────────────────────────────────────────┘
```

### Console Output (Server Logs)

```
[12:34:56] #dev-ops @mario: what was the architecture decision...
[12:34:56] Context: 267 msgs | 43.2K/200K tokens (21%) | Nov 18-30
[12:34:56] ├── System prompt:     8.4K tokens (cached)
[12:34:56] ├── Memory files:      2.1K tokens (cached)
[12:34:56] ├── Message history:  28.7K tokens (cached)
[12:34:56] └── Current message:   4.0K tokens (new)
[12:34:57] → Response streaming...
[12:34:59] ✓ Complete | 892 tokens out | $0.0043
```

### Context Window Visualization

```
    CONTEXT WINDOW (200K tokens)
    ╔═══════════════════════════════════════════════════════════╗
    ║                                                           ║
    ║  ┌─────────┐ ┌─────────┐ ┌─────────────────────────────┐ ║
    ║  │ SYSTEM  │ │ MEMORY  │ │      MESSAGE HISTORY        │ ║
    ║  │ PROMPT  │ │  FILES  │ │    (roving window)          │ ║
    ║  │  ~10K   │ │  ~5K    │ │        ~145K                │ ║
    ║  │ (fixed) │ │ (fixed) │ │     (dynamic)               │ ║
    ║  └─────────┘ └─────────┘ └─────────────────────────────┘ ║
    ║                                                           ║
    ║  Reserved for output: ~40K tokens                         ║
    ╚═══════════════════════════════════════════════════════════╝

    ROVING WINDOW BEHAVIOR:

    Full history: [msg1][msg2][msg3]...[msg500][msg501]...[msg1000]
                              ↑                               ↑
                              │         CONTEXT WINDOW        │
                              └───────────────────────────────┘
                                     (fits ~145K tokens)

    As new messages arrive, window slides forward:

    Before: [msg1][msg2][msg3]...[msg500][msg501]...[msg1000]
                         └────────── in context ──────────┘

    After:  [msg1][msg2][msg3]...[msg500][msg501]...[msg1000][msg1001]
                              └────────── in context ───────────┘
                    ↑
                    dropped (but still in log.jsonl for queries)
```

### Token Budget Allocation

```
    ┌────────────────────────────────────────────────────────┐
    │                   200,000 TOKENS TOTAL                 │
    ├────────────────────────────────────────────────────────┤
    │                                                        │
    │   OUTPUT RESERVE        │      INPUT BUDGET            │
    │      40,000             │       160,000                │
    │        20%              │         80%                  │
    │                         │                              │
    │   ┌─────────────────────┼──────────────────────────┐   │
    │   │                     │  System Prompt  ~10K     │   │
    │   │   Reserved for      │  Memory Files   ~5K      │   │
    │   │   model output      │  Tools Schema   ~3K      │   │
    │   │   (maxTokens)       │  ─────────────────       │   │
    │   │                     │  Available for           │   │
    │   │                     │  messages: ~142K         │   │
    │   └─────────────────────┼──────────────────────────┘   │
    │                         │                              │
    └─────────────────────────┴──────────────────────────────┘
```

---

## File Tree

```
packages/
├── ai/
│   └── src/
│       └── tokens.ts                    [CREATE] Token estimation utilities
│
└── mom/
    └── src/
        ├── context/
        │   ├── index.ts                 [CREATE] Context module exports
        │   ├── token-estimator.ts       [CREATE] Token counting/estimation
        │   ├── roving-window.ts         [CREATE] Sliding window logic
        │   └── context-builder.ts       [CREATE] Build optimized context
        │
        ├── agent.ts                     [MODIFY] Use new context system
        ├── slack.ts                     [MODIFY] Display usage in thread footer
        ├── log.ts                       [MODIFY] Add context metrics logging
        │
        └── types.ts                     [CREATE] Shared types for context
```

### File Descriptions

| File | Action | Description |
|------|--------|-------------|
| `packages/ai/src/tokens.ts` | CREATE | Fast token estimation using char-based heuristics with model-specific multipliers. No external dependencies. |
| `packages/mom/src/context/index.ts` | CREATE | Barrel exports for the context module |
| `packages/mom/src/context/token-estimator.ts` | CREATE | Wrapper around ai/tokens.ts with message-specific logic (handles JSONL, attachments, tool results) |
| `packages/mom/src/context/roving-window.ts` | CREATE | Core sliding window algorithm. Selects messages to fit token budget while preserving recency and coherence. |
| `packages/mom/src/context/context-builder.ts` | CREATE | Orchestrates context building: loads history, applies window, formats for prompt. Returns context + metrics. |
| `packages/mom/src/types.ts` | CREATE | TypeScript interfaces for ContextMetrics, WindowConfig, etc. |
| `packages/mom/src/agent.ts` | MODIFY | Replace hardcoded `getRecentMessages(50)` with `buildContext()`. Pass metrics to event handlers. |
| `packages/mom/src/slack.ts` | MODIFY | Add context usage footer to thread after run completes. |
| `packages/mom/src/log.ts` | MODIFY | Add `logContextMetrics()` function for detailed console output. |

---

## Implementation Steps

### Phase 1: Token Estimation Foundation

#### 1.1 Create Token Estimation Utility in AI Package

**File:** `packages/ai/src/tokens.ts`

```typescript
// Approximate tokens using character-based heuristics
// Claude tokenizer: ~4 chars per token for English, ~2-3 for code
```

- [ ] 1.1.1 Create `estimateTokens(text: string): number` function
  - Use 4 chars/token as baseline for English text
  - Add adjustment for code blocks (3 chars/token)
  - Add adjustment for JSON (3.5 chars/token)
  - Return integer token count

- [ ] 1.1.2 Create `estimateMessageTokens(message: Message): number` function
  - Handle UserMessage (text + images at 1000 tokens each)
  - Handle AssistantMessage (text + thinking + tool calls)
  - Handle ToolResultMessage (content array)

- [ ] 1.1.3 Create `estimateContextTokens(context: Context): number` function
  - Sum system prompt tokens
  - Sum all message tokens
  - Sum tool schema tokens (JSON.stringify each tool)

- [ ] 1.1.4 Export from `packages/ai/src/index.ts`

#### 1.2 Create Types for Context System

**File:** `packages/mom/src/types.ts`

- [ ] 1.2.1 Define `ContextMetrics` interface:
  ```typescript
  interface ContextMetrics {
    totalTokens: number;
    maxTokens: number;
    utilization: number; // 0-1
    breakdown: {
      systemPrompt: number;
      memoryFiles: number;
      toolSchemas: number;
      messageHistory: number;
      currentMessage: number;
    };
    messageCount: number;
    dateRange: { start: Date; end: Date } | null;
    cachedTokens: number;
    newTokens: number;
  }
  ```

- [ ] 1.2.2 Define `WindowConfig` interface:
  ```typescript
  interface WindowConfig {
    maxInputTokens: number;  // 160K default
    reservedForOutput: number; // 40K default
    systemPromptTokens: number;
    memoryTokens: number;
    toolSchemaTokens: number;
  }
  ```

- [ ] 1.2.3 Define `ContextResult` interface:
  ```typescript
  interface ContextResult {
    formattedHistory: string;
    metrics: ContextMetrics;
    includedMessages: number;
    droppedMessages: number;
  }
  ```

---

### Phase 2: Roving Window Implementation

#### 2.1 Create Token Estimator Module

**File:** `packages/mom/src/context/token-estimator.ts`

- [ ] 2.1.1 Import `estimateTokens` from `@mariozechner/pi-ai`

- [ ] 2.1.2 Create `estimateLogMessageTokens(line: string): number`
  - Parse JSONL line
  - Estimate text content tokens
  - Add overhead for metadata (date, user, etc.) ~20 tokens
  - Handle attachments (add 50 tokens per attachment reference)

- [ ] 2.1.3 Create `estimateSystemPromptTokens(prompt: string): number`
  - Use base estimation
  - Account for code blocks in prompt

- [ ] 2.1.4 Create `estimateMemoryTokens(memory: string): number`
  - Estimate markdown content

#### 2.2 Create Roving Window Algorithm

**File:** `packages/mom/src/context/roving-window.ts`

- [ ] 2.2.1 Create `selectMessagesForWindow(lines: string[], config: WindowConfig): WindowResult`

  **Algorithm:**
  ```
  1. Calculate available budget = maxInputTokens - reserved tokens
  2. Start from most recent message
  3. Add messages backwards while under budget
  4. Track cumulative token count
  5. Return selected lines + metrics
  ```

- [ ] 2.2.2 Implement efficient backwards iteration
  - Read file from end using line-by-line approach
  - Accumulate token estimates
  - Stop when budget exceeded

- [ ] 2.2.3 Handle edge cases:
  - Empty log file
  - Single message exceeds budget (truncate with notice)
  - Very long tool results (summarize marker)

- [ ] 2.2.4 Return `WindowResult`:
  ```typescript
  interface WindowResult {
    selectedLines: string[];
    totalTokens: number;
    messageCount: number;
    dateRange: { start: string; end: string } | null;
    droppedCount: number;
  }
  ```

#### 2.3 Create Context Builder

**File:** `packages/mom/src/context/context-builder.ts`

- [ ] 2.3.1 Create `buildContext(channelDir: string, config: Partial<WindowConfig>): ContextResult`

- [ ] 2.3.2 Implement loading sequence:
  ```typescript
  1. Load and estimate system prompt tokens
  2. Load and estimate memory file tokens
  3. Calculate tool schema tokens
  4. Calculate remaining budget for messages
  5. Apply roving window to log.jsonl
  6. Format selected messages as TSV
  7. Compile metrics
  ```

- [ ] 2.3.3 Create `formatMessagesAsTsv(lines: string[]): string`
  - Reuse existing format from agent.ts
  - Handle parsing errors gracefully

- [ ] 2.3.4 Export barrel from `packages/mom/src/context/index.ts`

---

### Phase 3: Integration with Agent

#### 3.1 Modify Agent to Use Context Builder

**File:** `packages/mom/src/agent.ts`

- [ ] 3.1.1 Import context module:
  ```typescript
  import { buildContext, type ContextMetrics } from "./context/index.js";
  ```

- [ ] 3.1.2 Replace `getRecentMessages(channelDir, 50)` call:
  ```typescript
  // Before
  const recentMessages = getRecentMessages(channelDir, 50);

  // After
  const contextResult = buildContext(channelDir, {
    maxInputTokens: 160000,
    reservedForOutput: 40000,
  });
  const recentMessages = contextResult.formattedHistory;
  const contextMetrics = contextResult.metrics;
  ```

- [ ] 3.1.3 Pass `contextMetrics` to event handler scope

- [ ] 3.1.4 Add metrics to usage summary:
  ```typescript
  // In agent_end event
  const summary = {
    ...totalUsage,
    context: contextMetrics,
  };
  ```

- [ ] 3.1.5 Remove old `getRecentMessages` function (now in context module)

#### 3.2 Enhance Logging

**File:** `packages/mom/src/log.ts`

- [ ] 3.2.1 Create `logContextMetrics(logCtx, metrics: ContextMetrics): void`
  ```
  [12:34:56] Context: 267 msgs | 43.2K/200K tokens (21%) | Nov 18-30
  [12:34:56] ├── System prompt:     8.4K tokens
  [12:34:56] ├── Memory files:      2.1K tokens
  [12:34:56] ├── Message history:  28.7K tokens
  [12:34:56] └── Current message:   4.0K tokens
  ```

- [ ] 3.2.2 Add color coding based on utilization:
  - Green: < 50%
  - Yellow: 50-80%
  - Red: > 80%

- [ ] 3.2.3 Call from `createAgentRunner` before `agent.prompt()`

---

### Phase 4: Slack UI Enhancement

#### 4.1 Add Context Footer to Thread

**File:** `packages/mom/src/slack.ts`

- [ ] 4.1.1 Create `formatContextFooter(metrics: ContextMetrics, usage: Usage): string`
  ```typescript
  // Returns Slack mrkdwn formatted footer
  // Example: "░░░░▓▓ 43K/200K │ 267 msgs │ Nov 18-30"
  ```

- [ ] 4.1.2 Create `renderProgressBar(current: number, max: number, width: number): string`
  - Use block characters: ░ (empty), ▓ (filled)
  - Show percentage visually

- [ ] 4.1.3 Format date range human-readable:
  - Same day: "Nov 30"
  - Same month: "Nov 18-30"
  - Different months: "Oct 28 - Nov 30"

#### 4.2 Integrate Footer into Agent Response

**File:** `packages/mom/src/agent.ts`

- [ ] 4.2.1 After usage summary, add context footer:
  ```typescript
  // In run() after agent completes
  const contextFooter = formatContextFooter(contextMetrics, totalUsage);
  await ctx.respondInThread(contextFooter);
  ```

- [ ] 4.2.2 Only show footer if there are significant metrics (> 10 messages)

---

### Phase 5: Testing & Validation

#### 5.1 Unit Tests

**File:** `packages/mom/src/context/__tests__/`

- [ ] 5.1.1 Test token estimation accuracy:
  - Compare estimates vs actual API usage
  - Target: within 15% accuracy

- [ ] 5.1.2 Test roving window:
  - Empty log file
  - Log file under budget
  - Log file over budget (verify truncation)
  - Single very long message

- [ ] 5.1.3 Test context builder:
  - Integration of all components
  - Metrics accuracy

#### 5.2 Integration Testing

- [ ] 5.2.1 Test with real Slack channel:
  - Small history (< 50 messages)
  - Medium history (50-500 messages)
  - Large history (1000+ messages)

- [ ] 5.2.2 Verify cache efficiency:
  - System prompt should be cached
  - Older messages should be cached
  - Only new messages should be "new" tokens

#### 5.3 Performance Testing

- [ ] 5.3.1 Measure context building time:
  - Target: < 100ms for 1000 messages
  - Profile and optimize if needed

- [ ] 5.3.2 Memory usage:
  - Ensure streaming/line-by-line reading
  - No full file load into memory

---

### Phase 6: Configuration & Polish

#### 6.1 Make Thresholds Configurable

- [ ] 6.1.1 Add environment variables:
  ```bash
  MOM_MAX_INPUT_TOKENS=160000
  MOM_OUTPUT_RESERVE=40000
  MOM_SHOW_CONTEXT_FOOTER=true
  ```

- [ ] 6.1.2 Add to README documentation

#### 6.2 Edge Case Handling

- [ ] 6.2.1 Handle corrupted log.jsonl lines gracefully
- [ ] 6.2.2 Handle missing memory files
- [ ] 6.2.3 Handle very large attachments in message history
- [ ] 6.2.4 Add warning when context is > 90% utilized

#### 6.3 Documentation

- [ ] 6.3.1 Update README.md with new context system
- [ ] 6.3.2 Document token estimation approach
- [ ] 6.3.3 Add troubleshooting for context issues

---

## Success Criteria

1. **Token Utilization**: Bot uses 70-90% of available context window (vs current ~10%)
2. **Accuracy**: Token estimates within 15% of actual usage
3. **Performance**: Context building < 100ms for 1000 messages
4. **Visibility**: Users can see context usage in Slack threads
5. **Reliability**: No context overflow errors (stopReason: "length")
6. **Cache Efficiency**: > 80% cache hit rate for repeated interactions

---

## Rollback Plan

If issues arise:
1. Context module has fallback to return last 50 messages (current behavior)
2. Footer display is optional and can be disabled via env var
3. Token estimation failure falls back to message count heuristic

---

## Dependencies

- No new npm packages required
- Reuses existing @mariozechner/pi-ai types
- Uses Node.js built-in fs for file operations

---

## Timeline Estimate

This is a medium-complexity feature with well-defined scope. The implementation can be done incrementally with each phase being independently valuable.
