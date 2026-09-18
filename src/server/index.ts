import type { ModuleBackend, ModuleBackendContext, ModuleResponse } from '@cockpit/module-api';
import { MAX_JSON_BYTES, SpeechError } from '../shared/limits.ts';
import { azureTranscriber, parseInput } from './azure.ts';
import type { Transcriber } from './azure.ts';
import { readConfig } from './config.ts';

export function activate(context: ModuleBackendContext, transcriber: Transcriber = azureTranscriber()): ModuleBackend {
  const lifetime = new AbortController();
  const json = (body: unknown, status = 200): ModuleResponse => ({
    status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }, body,
  });
  const failure = (error: unknown): ModuleResponse => {
    const safe = error instanceof SpeechError ? error : new SpeechError('SPEECH_FAILED', '语音转写失败。', 500);
    return json({ error: { code: safe.code, message: safe.message } }, safe.status);
  };
  let active = false;
  return {
    routes: [
      {
        method: 'GET', path: '/config-ready',
        async handler() {
          try { await readConfig(context.dataRoot); return json({ ready: true }); }
          catch (error) { return failure(error); }
        },
      },
      {
        method: 'POST', path: '/transcribe', body: 'json', bodyLimit: MAX_JSON_BYTES,
        async handler(request) {
          if (active) return failure(new SpeechError('SPEECH_BUSY', '已有语音正在转写，请等待完成后重试。', 409));
          active = true;
          try {
            const signal = AbortSignal.any([request.signal, context.signal, lifetime.signal]);
            signal.throwIfAborted();
            const input = parseInput(request.body);
            const config = await readConfig(context.dataRoot);
            signal.throwIfAborted();
            const text = await transcriber.transcribe(config, input, signal);
            signal.throwIfAborted();
            return json({ text });
          } catch (error) {
            if (request.signal.aborted || context.signal.aborted || lifetime.signal.aborted) return failure(new SpeechError('CANCELLED', '语音转写已取消。', 499));
            return failure(error);
          } finally { active = false; }
        },
      },
    ],
    dispose() { lifetime.abort(); },
  };
}
