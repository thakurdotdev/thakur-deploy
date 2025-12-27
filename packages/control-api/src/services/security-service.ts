export const SecurityService = {
  validateBuildCommand(command: string) {
    const dangerousPatterns = [
      'rm -rf',
      'sudo',
      'wget',
      'curl',
      'eval',
      '|',
      ';',
      '>',
      '<',
      '/etc/passwd',
      '/etc/shadow',
      '/bin/sh',
      '/bin/bash',
    ];

    const allowedPrefixes = ['npm', 'yarn', 'pnpm', 'bun', 'echo', 'ls'];

    // 1. Check for dangerous patterns (excluding && which we handle specially)
    for (const pattern of dangerousPatterns) {
      if (command.includes(pattern)) {
        throw new Error(`Command contains dangerous pattern: "${pattern}"`);
      }
    }

    // 2. Split by && and validate each part starts with allowed prefix
    const commandParts = command.split('&&').map((part) => part.trim());

    for (const part of commandParts) {
      if (!part) continue; // Skip empty parts

      const startsWithAllowed = allowedPrefixes.some((prefix) => part.startsWith(prefix));

      if (!startsWithAllowed) {
        throw new Error(
          `Each command must start with one of: ${allowedPrefixes.join(', ')}. Invalid: "${part}"`,
        );
      }
    }

    return true;
  },
};
