import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'

if (process.platform === 'darwin') {
  const output = 'electron/security/darwin-safe-file-system'
  const result = spawnSync('clang', [
    '-fobjc-arc',
    '-framework', 'Foundation',
    'electron/security/darwin-safe-file-system.m',
    '-o', output,
  ], { stdio: 'inherit' })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  chmodSync(output, 0o755)
}
