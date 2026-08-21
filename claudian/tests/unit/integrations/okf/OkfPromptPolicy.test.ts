import {
  normalizeSystemPromptMode,
  OKF_NATIVE_BASE_INSTRUCTIONS,
  resolveSystemPromptInstructions,
  systemPromptVersion,
} from '@/integrations/okf/OkfPromptPolicy';

describe('OKF prompt policy', () => {
  it('uses a minimal stable bridge in OKF Native mode', () => {
    expect(resolveSystemPromptInstructions({
      mode: 'okf-native',
      fullPrompt: 'very long Claudian prompt',
      customReplacement: 'custom prompt',
    })).toBe(OKF_NATIVE_BASE_INSTRUCTIONS);
    expect(OKF_NATIVE_BASE_INSTRUCTIONS).not.toContain('Claudian');
    expect(OKF_NATIVE_BASE_INSTRUCTIONS).not.toContain('Obsidian expert');
  });

  it('preserves the upstream prompt as an explicit mode', () => {
    expect(resolveSystemPromptInstructions({
      mode: 'claudian-full',
      fullPrompt: 'full prompt',
    })).toBe('full prompt');
  });

  it('replaces rather than appends custom instructions', () => {
    expect(resolveSystemPromptInstructions({
      mode: 'custom-replace',
      fullPrompt: 'full prompt',
      customReplacement: '  replacement only  ',
    })).toBe('replacement only');
  });

  it('fails closed to OKF Native for invalid or empty custom configuration', () => {
    expect(normalizeSystemPromptMode('unknown')).toBe('okf-native');
    expect(resolveSystemPromptInstructions({
      mode: 'custom-replace',
      fullPrompt: 'full prompt',
      customReplacement: ' ',
    })).toBe(OKF_NATIVE_BASE_INSTRUCTIONS);
    expect(systemPromptVersion('okf-native')).toBe('okf-native.v1');
  });
});
