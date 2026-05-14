import { ARIAClient, TrackOptions } from './index.js';

export interface ARIAToolOptions {
  agentDid: string;
  secret: string;
  action?: string;
  trackOptions?: TrackOptions;
}

/**
 * Wraps any LangChain-compatible tool with ARIA tracking.
 * Works with DynamicTool, Tool, and any object with
 * a name and func property.
 */
export function wrapTool<T extends {
  name: string;
  description?: string;
  func?: (input: string) => Promise<string>;
  call?: (input: string) => Promise<string>;
}>(
  tool: T,
  aria: ARIAClient,
  options: ARIAToolOptions
): T {
  const action = options.action ?? `tool:${tool.name}`;
  const originalFunc = tool.func ?? tool.call;

  if (!originalFunc) return tool;

  const wrappedFunc = async (input: string): Promise<string> => {
    const result = await aria.track(
      options.agentDid,
      options.secret,
      action,
      async () => originalFunc.call(tool, input),
      options.trackOptions ?? { mode: 'light' }
    );
    return String(result);
  };

  return {
    ...tool,
    func: wrappedFunc,
    call: wrappedFunc,
  };
}

/**
 * Wraps an array of LangChain tools with ARIA tracking.
 * Automatically derives action name from tool name.
 */
export function wrapTools<T extends {
  name: string;
  description?: string;
  func?: (input: string) => Promise<string>;
  call?: (input: string) => Promise<string>;
}>(
  tools: T[],
  aria: ARIAClient,
  options: Omit<ARIAToolOptions, 'action'>
): T[] {
  return tools.map(tool =>
    wrapTool(tool, aria, {
      ...options,
      action: `tool:${tool.name}`
    })
  );
}

/**
 * Creates an ARIA-aware LangChain agent executor wrapper.
 * Intercepts every agent step and records it with ARIA.
 */
export function createARIACallbackHandler(
  aria: ARIAClient,
  agentDid: string,
  secret: string,
  trackOptions?: TrackOptions
) {
  return {
    handleToolStart: async (
      tool: { name: string },
      input: string
    ) => {
      aria.track(
        agentDid,
        secret,
        `tool:${tool.name}:start`,
        async () => ({ input }),
        { mode: 'light' }
      ).catch(() => {});
    },

    handleToolEnd: async (
      output: string,
      _runId: string,
      _parentRunId: string,
      _tags?: string[],
      _metadata?: Record<string, unknown>
    ) => {
      aria.track(
        agentDid,
        secret,
        `tool:complete`,
        async () => ({ output: output.slice(0, 200) }),
        trackOptions ?? { mode: 'light' }
      ).catch(() => {});
    },

    handleToolError: async (
      error: Error,
      _runId: string
    ) => {
      aria.track(
        agentDid,
        secret,
        `tool:error`,
        async () => { throw error; },
        { mode: 'light' }
      ).catch(() => {});
    },

    handleAgentAction: async (
      action: { tool: string; toolInput: string }
    ) => {
      aria.track(
        agentDid,
        secret,
        `agent:action:${action.tool}`,
        async () => ({ toolInput: action.toolInput }),
        trackOptions ?? { mode: 'light' }
      ).catch(() => {});
    },
  };
}
