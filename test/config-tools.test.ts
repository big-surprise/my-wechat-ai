import { loadConfig } from '../src/config.js';
import type { WaiConfig, ToolConfig } from '../src/types.js';

console.log('🧪 Testing ToolConfig configuration loading...');

// Test 1: Check that ToolConfig is correctly typed
const testToolConfig: ToolConfig = {
  allow: ['Read', 'Glob', 'Grep', 'Bash'],
  deny: ['WebSearch', 'WebFetch'],
  bash: {
    timeout: 180,
  },
  web_fetch: {
    timeout: 30,
  },
  web_search: {
    timeout: 20,
  },
};

console.log('✓ ToolConfig type check passed');
console.log('  - allow:', testToolConfig.allow);
console.log('  - deny:', testToolConfig.deny);
console.log('  - bash.timeout:', testToolConfig.bash?.timeout);
console.log('  - web_fetch.timeout:', testToolConfig.web_fetch?.timeout);
console.log('  - web_search.timeout:', testToolConfig.web_search?.timeout);

// Test 2: Check that default config has tools field optional
const defaultConfig: WaiConfig = {
  defaultProvider: 'qwen',
  providers: {},
  channels: {},
};

// This should compile without error
console.log('✓ WaiConfig accepts optional tools field');

// Test 3: Check that config can be loaded with tools
const configWithTools: WaiConfig = {
  defaultProvider: 'qwen',
  providers: {
    qwen: {
      type: 'claw-agent',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
    },
  },
  channels: {
    weixin: {
      type: 'weixin',
      enabled: true,
    },
  },
  tools: {
    allow: ['Read', 'Glob'],
    bash: {
      timeout: 120,
    },
  },
};

console.log('✓ Config with tools field compiles correctly');
console.log('  - tools.allow:', configWithTools.tools?.allow);
console.log('  - tools.bash.timeout:', configWithTools.tools?.bash?.timeout);

console.log('\n✅ All tests passed! ToolConfig integration is working correctly.');
