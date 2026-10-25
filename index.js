/**
 * Codex mode, host half.
 *
 * This is a Codex driver layer over DSH's durable agent loop:
 *
 * - `systemPrompt.section` adds Codex's operating contract while the session's
 *   permission identity is one of the `codex-*` presets.
 * - The step wrapper owns one protocol invariant DSH does not enforce: an
 *   assistant message that invokes tools must also carry visible commentary.
 *   When the model emits only tool calls, the driver commits a short localized
 *   progress block with the assistant message, before the tools run.
 * - `agent/turn-stopping` gives the model one nudge when it tries to stop with
 *   unfinished todos, which is Codex's "keep going" behavior expressed as a
 *   durable steer into the same turn.
 *
 * DSH remains the transport: turn construction, tool dispatch, retries,
 * compaction, approvals, and the event log are still its systems. The mode is
 * stored by the permission-preset service, so it is in the session log,
 * survives resume, and is independent of the sandbox level.
 *
 * @module @local/dsh-codex-mode
 */

import { randomUUID } from 'node:crypto';

/** Permission identity prefix owned by this plugin. */
const CODEX_PREFIX = 'codex-';

/**
 * The Codex execution contract. This is deliberately shorter than Codex's own
 * instructions: the model already has DSH's tool documentation and the active
 * deployment persona, so this section only adds loop behavior that would
 * otherwise be missing.
 */
const CODEX_PROMPT = `# Codex mode

You are operating in Codex mode. It adapts the execution discipline of OpenAI Codex's coding agent to this harness. These rules shape how you work; direct user instructions, repository guidance, the active permission policy, and safety rules still take precedence.

## The loop

- Ground first. Read the relevant files and inspect the current state before proposing or making changes. Let the codebase teach you its patterns.
- Plan when the work is multi-step, ambiguous, or long-running. Skip the plan for a one-step answer or a trivial edit.
- Act in small, coherent increments. After each meaningful change, run the narrowest check that would catch the failure you are most worried about. Broaden verification only when the blast radius justifies it.
- Continue until the request is genuinely handled. Do not stop at analysis, a proposal, a half-finished edit, or a plan. If a step fails, inspect the actual error and try a different route before giving up.
- Ask only for user-owned decisions or material ambiguity that inspection cannot resolve. Do not ask where code lives or how current behavior works when you can find out.
- Before the final answer, re-read the newest user request and check that the work and the verification actually answer it.

## Planning

- Use \`todo_write\` as Codex's plan tool. It replaces the whole list, so send the complete plan every time.
- Use a plan for multi-step work, work with dependencies, work that needs checkpoints, or when the user asks for a plan. Do not pad simple work with filler steps.
- Keep exactly one item \`in_progress\` while you work; several only when the work is genuinely parallel.
- Mark an item \`completed\` as soon as it is done, before moving on. If the plan changes, update the whole list and briefly explain why.
- Do not repeat the full plan in prose after updating it; the UI already shows it. Summarize the change and the next concrete step.

## Tools in this harness

- Before each tool batch, write one short user-facing progress sentence explaining what you are about to do and why. Never emit a tool call as the only content of a step: the user must be able to follow the work while it happens.
- Use \`pwsh\` on Windows (or \`bash\` where present) for commands. Prefer \`rg\` and \`rg --files\` for search. Keep commands focused; do not chain unrelated checks with separators.
- Use \`read\`, \`glob\`, and \`grep\` to inspect. Parallelize independent reads and searches when the harness supports it. Never parallelize writes or other mutations.
- Use \`edit\` and \`write\` for file changes. Read a file before editing it, keep edits scoped to the task, and do not use shell redirection to write source files.
- Use \`apply_patch\` semantics even though the tool is called \`edit\`: make the smallest complete patch, preserve surrounding code, and do not rewrite a file just to change one region.
- Never revert changes you did not make. Treat an unexpected dirty worktree as the user's work, work with it when it affects the task, and ignore it when it does not.
- Do not run destructive git commands such as \`git reset --hard\` or \`git checkout --\` unless the user explicitly asked for that operation.
- Use \`ask_user_question\` for a decision only the user can make; include useful options instead of an open-ended prompt when possible.

## Working with the user

- Give short, grounded progress updates while you work: what you found, what you are changing, and what you are checking. Do not narrate every command.
- Do not praise a plan by contrasting it with an implied worse alternative. State what you are doing and why.
- If the user redirects you, follow the newest instruction. If the new message adds to the unfinished request, carry both forward.
- If compaction rewrites the history, continue naturally from the summary. Do not restart finished work.

## Verification and closing

- Verify the behavior, not just the diff. Run the relevant tests, type checks, builds, or a focused runtime check. If you cannot run something, say exactly what remains unverified.
- Do not write tests that merely mirror the implementation. Test behavior that matters to the change.
- In the final answer, lead with the outcome. For small changes, one or two short paragraphs plus a verification line is enough. Use structure only when the task calls for it.
- Mention changed files with clickable paths, and call out any real risk, blocker, or remaining check. Never claim a check passed if you did not run it.
- Keep the final answer under roughly 50-70 lines and make every line earn its place.`;

/** The steer text used when a Codex-mode turn tries to stop with pending work. */
const CONTINUE_MESSAGE = `Your todo list still has unfinished work. Continue from the current state: run the next concrete step, verify it, and update todo_write. Do not restate the plan and do not stop to ask for permission unless you are blocked by a user-owned choice.`;

/**
 * Build one complete user message for the continuation steer.
 *
 * `Agent.steer()` inserts its argument into the durable inbox as-is; it does
 * not fill in a role or identity. A partial `{ content, source }` object reaches
 * the provider without a role and fails the request. Build the same shape
 * `createUserMessage()` would produce, without importing a Host package.
 *
 * @returns a frozen, fully identified user-role message.
 */
function codexSteerMessage() {
  return Object.freeze({
    id: `codex-mode-${randomUUID()}`,
    role: 'user',
    content: Object.freeze([
      Object.freeze({ type: 'text', text: CONTINUE_MESSAGE }),
    ]),
    source: Object.freeze({ kind: 'codex-mode' }),
  });
}

/**
 * Read whether one live agent is in Codex mode.
 *
 * The permission preset is the durable switch. `permissionPresets.current()`
 * folds the session projection and returns the selected preset identity, which
 * is why the mode survives resume and why changing permission while the mode
 * is on can keep it on through a matching codex-* variant.
 *
 * @param ctx - plugin context carrying `permissionPresets`.
 * @param agent - live agent whose session is read.
 * @returns true when the current permission preset belongs to Codex mode.
 */
function isCodexMode(ctx, agent) {
  try {
    return String(ctx.permissionPresets.current(agent.session)).startsWith(CODEX_PREFIX);
  } catch (_error) {
    return false;
  }
}

/**
 * Read the last assistant text committed in the session.
 *
 * The turn-stopping guard must not interrupt a question to the user. If a tool
 * call is the latest relevant event, there is no final text to inspect and the
 * turn should be left alone.
 *
 * @param session - session whose event log is read.
 * @returns the latest assistant message's text, or an empty string.
 */
function lastAssistantText(session) {
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'assistant/message') {
      return event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }
    if (event.type === 'tool/call' || event.type === 'tool/result') return '';
  }
  return '';
}

/**
 * Detect a reply that ends in a question. The guard is intentionally
 * conservative: a question is a user-owned decision and must be allowed to end
 * the turn even when the todo list is incomplete.
 *
 * @param text - latest assistant text.
 * @returns true when the final visible line is a question.
 */
function endsWithQuestion(text) {
  return /[?？]\s*$/u.test(text);
}

/** Clamp one value for a one-line progress note. */
function shortText(value, maxLength = 48) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length === 0) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Keep a path recognizable without dumping an entire absolute path. */
function shortPath(value) {
  const text = String(value ?? '').trim();
  if (text === '') return '';
  const parts = text.split(/[\\/]/u).filter(Boolean);
  return parts.length <= 2 ? text : parts.slice(-2).join('/');
}

/** Read whether one message's text contains Chinese. */
function messageIsChinese(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return false;
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return /[\u3400-\u9fff]/u.test(text);
}

/** Read whether the newest human prompt is Chinese, so generated progress matches. */
function latestUserMessageIsChinese(session, pending = []) {
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const message = pending[index];
    if (message?.role !== 'user' || message.source?.kind !== 'user') continue;
    if (messageIsChinese(message)) return true;
    if (message.content?.some((block) => block.type === 'text' && block.text.trim() !== '')) return false;
  }
  const events = session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'user/message') continue;
    if (event.data.source?.kind !== 'user') continue;
    if (messageIsChinese(event.data)) return true;
    if (event.data.content.some((block) => block.type === 'text' && block.text.trim() !== '')) return false;
  }
  return false;
}

/** Describe one tool call as a short verb phrase. */
function describeToolCall(call, chinese) {
  let args = {};
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch (_error) {
    // Invalid JSON is a tool error, not a reason to lose the progress line.
  }

  const name = typeof call.name === 'string' ? call.name : 'tool';
  const path = shortPath(args.file_path ?? args.path ?? args.file);
  const pattern = shortText(args.pattern ?? args.query ?? args.glob, 34);
  const description = shortText(args.description, 44);
  const url = shortText(args.url, 44);

  if (chinese) {
    if (name === 'read') return path === '' ? '读取文件' : `读取 \`${path}\``;
    if (name === 'read_image') return path === '' ? '查看图片' : `查看图片 \`${path}\``;
    if (name === 'grep') return pattern === '' ? '搜索代码' : `搜索 \`${pattern}\``;
    if (name === 'glob') return pattern === '' ? '定位相关文件' : `定位 \`${pattern}\``;
    if (name === 'edit') return path === '' ? '修改文件' : `修改 \`${path}\``;
    if (name === 'write') return path === '' ? '写入文件' : `写入 \`${path}\``;
    if (name === 'todo_write') return '更新执行计划';
    if (name === 'pwsh' || name === 'bash') {
      return /[\u3400-\u9fff]/u.test(description) && description !== ''
        ? description
        : '执行命令确认当前状态';
    }
    if (name === 'web_search') return '检索资料';
    if (name === 'web_fetch') return url === '' ? '打开网页' : `打开 \`${url}\``;
    if (name === 'subagent' || name === 'subagent_fork') return '委派一个子任务';
    if (name === 'ask_user_question') return '向你确认一个选择';
    if (name === 'apply_patch') return '应用补丁';
    return `使用 \`${name}\``;
  }

  if (name === 'read') return path === '' ? 'read the file' : `read \`${path}\``;
  if (name === 'read_image') return path === '' ? 'look at the image' : `look at \`${path}\``;
  if (name === 'grep') return pattern === '' ? 'search the code' : `search for \`${pattern}\``;
  if (name === 'glob') return pattern === '' ? 'locate the relevant files' : `locate \`${pattern}\``;
  if (name === 'edit') return path === '' ? 'update the file' : `update \`${path}\``;
  if (name === 'write') return path === '' ? 'write the file' : `write \`${path}\``;
  if (name === 'todo_write') return 'update the plan';
  if (name === 'pwsh' || name === 'bash') {
    return description !== '' && !/[\u3400-\u9fff]/u.test(description)
      ? `run ${description}`
      : 'run a command to check the current state';
  }
  if (name === 'web_search') return 'search the web';
  if (name === 'web_fetch') return url === '' ? 'open the page' : `open \`${url}\``;
  if (name === 'subagent' || name === 'subagent_fork') return 'delegate a subtask';
  if (name === 'ask_user_question') return 'ask you to choose';
  if (name === 'apply_patch') return 'apply a patch';
  return `use \`${name}\``;
}

/**
 * Build a Codex-style progress line for a silent tool batch.
 *
 * Codex streams a short commentary message before it acts. DSH deliberately
 * accepts a tool-only assistant message, which is what makes a long turn look
 * like the model "went silent". The Codex driver uses this line when the model
 * omitted its own commentary, so every durable tool batch has a visible
 * narration block before the tool rows.
 */
function commentaryForToolCalls(toolCalls, chinese) {
  const labels = toolCalls.slice(0, 3).map((call) => describeToolCall(call, chinese));
  const extra = toolCalls.length - labels.length;
  if (labels.length === 0) return chinese ? '我继续执行下一步。' : "I'll continue with the next step.";
  if (chinese) {
    const rest = extra > 0 ? `，然后处理其余 ${extra} 个调用` : '';
    return `我先${labels.join('，再')}${rest}。`;
  }
  const rest = extra > 0 ? `, then handle ${extra} more call${extra === 1 ? '' : 's'}` : '';
  return `I'll ${labels.join(', then ')}${rest}.`;
}

/**
 * Return assistant-message payload with a progress text block when the model
 * emitted only tool calls.
 *
 * The durable message stays the model's message; only a leading text block is
 * added. Keeping this at the session append boundary means it applies to every
 * step in the Codex turn, including retries and parallel tool batches, without
 * teaching the Conversation UI a second message format.
 */
function withCodexCommentary(data, chinese) {
  const message = data?.message;
  const content = Array.isArray(message?.content) ? message.content : null;
  if (content === null) return data;
  const toolCalls = content.filter((block) => block?.type === 'tool-call');
  if (toolCalls.length === 0) return data;
  const hasText = content.some((block) => block?.type === 'text'
    && typeof block.text === 'string'
    && block.text.trim() !== '');
  if (hasText) return data;

  const insertAt = content.findIndex((block) => block?.type === 'tool-call');
  const text = commentaryForToolCalls(toolCalls, chinese);
  const nextContent = [
    ...content.slice(0, insertAt),
    { type: 'text', text },
    ...content.slice(insertAt),
  ];

  if (!Array.isArray(data.stream)) {
    return { ...data, message: { ...message, content: nextContent } };
  }

  const stream = data.stream.map((record) => {
    if (record?.type === 'chunk') {
      const index = record.chunk?.index;
      if (typeof index !== 'number' || index < insertAt) return record;
      return { ...record, chunk: { ...record.chunk, index: index + 1 } };
    }
    if (typeof record?.index !== 'number' || record.index < insertAt) return record;
    return { ...record, index: record.index + 1 };
  });
  const streamInsertAt = stream.findIndex((record) => typeof record.index === 'number' && record.index >= insertAt);
  const time0 = streamInsertAt < 0
    ? Date.now()
    : (typeof stream[streamInsertAt].time0 === 'number' ? stream[streamInsertAt].time0 : Date.now());
  const textRecord = {
    type: 'text-chunks',
    time0,
    index: insertAt,
    dt: [0],
    texts: [text],
  };
  stream.splice(streamInsertAt < 0 ? stream.length : streamInsertAt, 0, textRecord);
  return {
    ...data,
    message: { ...message, content: nextContent },
    stream,
  };
}

/**
 * Equip one live agent with the Codex step protocol.
 *
 * The DSH loop remains the transport, but in Codex mode this driver owns one
 * invariant DSH does not enforce: an assistant message that invokes tools must
 * also carry visible commentary. It patches the session append boundary for
 * the duration of each step, so the commentary is committed atomically with the
 * tool call and survives reloads, instead of being a UI-only status chip.
 *
 * @param ctx - plugin context carrying the permission preset service.
 * @param agent - live agent whose step method is wrapped.
 * @returns a disposer that restores the original step method.
 */
function installCodexStepProtocol(ctx, agent) {
  const originalStep = agent.step;
  if (typeof originalStep !== 'function') return () => {};

  const wrappedStep = async function codexStep(decision) {
    if (!isCodexMode(ctx, agent)) return originalStep.call(this, decision);

    const session = agent.session;
    const chinese = latestUserMessageIsChinese(session, decision?.messages);
    const hadOwnAppend = Object.prototype.hasOwnProperty.call(session, 'append');
    const originalAppend = session.append;
    const codexAppend = function append(type, data, intent) {
      const next = type === 'assistant/message' && isCodexMode(ctx, agent)
        ? withCodexCommentary(data, chinese)
        : data;
      return originalAppend.call(this, type, next, intent);
    };

    let patched = false;
    try {
      session.append = codexAppend;
      patched = session.append === codexAppend;
    } catch (error) {
      ctx.logger.warn(
        'codex-mode: session append protocol unavailable: %s',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!patched) return originalStep.call(this, decision);

    try {
      return await originalStep.call(this, decision);
    } finally {
      try {
        if (session.append === codexAppend) {
          if (hadOwnAppend) session.append = originalAppend;
          else delete session.append;
        }
      } catch (error) {
        ctx.logger.warn(
          'codex-mode: could not restore session append protocol: %s',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  };

  try {
    agent.step = wrappedStep;
  } catch (error) {
    ctx.logger.warn(
      'codex-mode: could not install step protocol: %s',
      error instanceof Error ? error.message : String(error),
    );
    return () => {};
  }

  return () => {
    if (agent.step === wrappedStep) agent.step = originalStep;
  };
}

/**
 * Mount the Codex prompt and turn guard on one live agent.
 *
 * Registrations live on `agent.ctx` so they disappear with that agent. The
 * returned disposer is also retained by the plugin context: unloading the
 * plugin must remove them even while the agent stays alive.
 *
 * @param ctx - plugin context.
 * @param agent - live agent to equip.
 * @param setup - per-agent bookkeeping shared by the plugin.
 */
function setupAgent(ctx, agent, setup) {
  if (setup.owned.has(agent.id)) return;
  setup.owned.add(agent.id);

  const dispose = agent.ctx.effect(() => {
    const offSection = agent.ctx.systemPrompt.section({
      name: 'codex:mode',
      order: 8600,
      interpolate: false,
      text: () => (isCodexMode(ctx, agent) ? CODEX_PROMPT : ''),
    });

    const offStopping = agent.ctx.on('agent/turn-stopping', async (payload) => {
      if (!isCodexMode(ctx, agent)) return;
      if (payload.agent !== agent) return;
      if (setup.nudged.get(agent.id) === payload.turn) return;

      const todos = ctx.sessionProjections.stateOf(agent.session, 'todos');
      if (!Array.isArray(todos) || todos.length === 0) return;
      if (!todos.some((todo) => todo.status !== 'completed')) return;

      const text = lastAssistantText(agent.session);
      if (text === '' || endsWithQuestion(text)) return;

      setup.nudged.set(agent.id, payload.turn);
      try {
        await agent.steer(codexSteerMessage());
      } catch (error) {
        setup.nudged.delete(agent.id);
        ctx.logger.warn(
          'codex-mode: could not continue unfinished turn: %s',
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    const offStep = installCodexStepProtocol(ctx, agent);

    return () => {
      offStep();
      offStopping();
      offSection();
    };
  }, 'codex-mode: agent prompt and turn guard');

  ctx.effect(() => dispose, 'codex-mode: agent registrations');
}

/**
 * Host plugin body.
 *
 * @param ctx - host context carrying the agent registry, permission presets,
 * system prompt, and session projections.
 */
export function apply(ctx) {
  const setup = {
    owned: new Set(),
    nudged: new Map(),
  };

  ctx.on('agent/created', ({ agent }) => {
    setupAgent(ctx, agent, setup);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    setup.owned.delete(agent.id);
    setup.nudged.delete(agent.id);
  });

  for (const agent of ctx.agents.list()) setupAgent(ctx, agent, setup);
}

/**
 * The mode depends on the permission preset identity, the prompt registry, and
 * the todo projection. `agents` is required for agents that already exist when
 * the plugin is installed.
 */
export const inject = ['agents', 'permissionPresets', 'systemPrompt', 'sessionProjections'];
