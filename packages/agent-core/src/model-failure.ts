import type { RunFailure } from '@openclawx/contracts';

/** Retain technical signatures, never arbitrary SDK response bodies or credentials. */
export function diagnoseModelFailure(error: unknown, context: { phase: RunFailure['phase']; elapsedMs: number }): { message: string; failure: RunFailure } {
  const metadata = error && typeof error === 'object' ? error as { message?: unknown; status?: unknown; code?: unknown; cause?: { code?: unknown } } : {};
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : typeof metadata.message === 'string' ? metadata.message : '';
  // Pi's SDK serializes APIError to error.message: e.g. `402 {"error":...}`.
  // Do not search arbitrary numbers in response bodies or user-supplied URLs.
  const parsedStatus = /\b(?:status|HTTP|error[: ]+)\s*[:=]?\s*([45]\d\d)\b/i.exec(raw)?.[1]
    ?? /^\s*(?:Error:\s*)?([45]\d\d)(?=\s|:|$)/i.exec(raw)?.[1];
  const status = typeof metadata.status === 'number' ? metadata.status : parsedStatus ? Number(parsedStatus) : undefined;
  const candidate = String(metadata.code || metadata.cause?.code || raw);
  const transportCode = /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_[A-Z_]+)\b/.exec(candidate)?.[1];
  let code: RunFailure['code'] = 'MODEL_ERROR'; let signature = 'Unclassified model error';
  let message = '模型请求失败，未能完成本轮任务。请查看运行诊断或测试模型连接。';
  if (/Model stream idle after \d+s/i.test(raw)) {
    code = 'MODEL_IDLE_TIMEOUT'; signature = raw.match(/Model stream idle after \d+s/i)![0];
    message = '模型单轮响应长时间无进展，已停止等待；这不是总任务超时。可重试或切换模型。';
  } else if (status === 402 || /insufficient[\s_.-]*(?:balance|funds|credits)|credit balance (?:is )?too low|\barrearage\b|余额不足|(?:账户|账号).{0,8}欠费/i.test(`${typeof metadata.code === 'string' ? metadata.code : ''} ${raw}`)) {
    code = 'UPSTREAM_BALANCE'; signature = status ? `HTTP ${status}: Insufficient balance` : 'Insufficient balance';
    message = '模型服务账户余额不足或已欠费，本轮未完成。请到供应商控制台检查余额并充值，或切换其他供应商。';
  } else if (status === 429) { code = 'UPSTREAM_RATE_LIMIT'; signature = 'HTTP 429'; message = '模型服务限流，请稍后重试或切换模型。';
  } else if (status === 401 || status === 403) { code = 'UPSTREAM_AUTH'; signature = `HTTP ${status}`; message = '模型服务拒绝认证或访问，请检查连接凭据与模型权限。';
  } else if (status && status >= 500) { code = 'UPSTREAM_SERVICE'; signature = `HTTP ${status}`; message = '上游模型服务异常，请稍后重试或切换模型。';
  } else if (/Bad control character|Unterminated string|Bad escaped character|in string literal in JSON|Expected ',' or '}' after property value|Expected ',' or '\]'|JSON at position|Unexpected .*JSON|Unexpected non-whitespace|JSON\.parse|tool arguments.*(?:invalid|parse)/i.test(raw)) { code = 'TOOL_ARGUMENTS'; signature = 'Invalid tool arguments JSON'; message = '模型生成的工具参数不完整或格式错误，本轮未完成。';
  } else if (/reasoning_content/i.test(raw)) { signature = 'Missing reasoning_content'; message = '模型思考模式的多轮工具协议不兼容，请关闭思考模式后重试或切换模型。';
  } else if (/aborted|aborterror/i.test(raw)) { code = 'MODEL_ABORTED'; signature = 'Model request aborted'; message = '模型请求被中断，本轮未完成；请查看运行状态后重试。';
  } else if (transportCode || /connection.?error|fetch failed|failed to fetch|terminated|socket hang up|network|timeout|timed out|stream idle|remote end closed|ssl|tls|broken pipe/i.test(raw)) {
    code = 'CONNECTION_INTERRUPTED'; signature = transportCode || (/timeout|timed out/i.test(raw) ? 'Model connection timeout' : 'Model connection interrupted');
    message = '与模型服务的连接中断或超时，无法仅据此判断是本机网络、代理还是上游服务。';
  }
  return { message, failure: { code, signature, phase: context.phase, elapsedMs: Math.max(0, context.elapsedMs), ...(status && status >= 100 && status <= 599 ? { status } : {}), ...(transportCode ? { transportCode } : {}) } };
}
