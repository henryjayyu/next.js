import { createHash } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { execFile, type ExecFileException } from 'child_process'
import { promisify } from 'util'
import semver from 'next/dist/compiled/semver'
import loadConfig from '../../server/config'
import { PHASE_INFO } from '../../shared/lib/constants'
import { getNpxCommand } from '../helpers/get-npx-command'
import {
  fetchJSON,
  NPM_REGISTRY,
  readSecuritySnapshot,
  selectSecurityTarget,
} from './security'
import type { NextConfig } from '../../server/config-shared'
import type { SecuritySnapshot } from './security'

export interface UpgradeApp {
  directory: string
  nextVersion: string
  routers: ('app' | 'pages')[]
  config: NextConfig
  manifestPath: string
  manifestHash: string
  lockfilePath?: string
  lockfileHash?: string
}

export type UpgradeResolution =
  | {
      status: 'disabled' | 'unaffected' | 'blocked'
      reason: string
    }
  | {
      status: 'ready'
      app: UpgradeApp
      target: { nextVersion: string; reason: string }
      tools: {
        command: string
        args: string[]
        invokingNextVersion: string
        codemodVersion: string
      }
      snapshot: SecuritySnapshot
    }

const execFileAsync = promisify(execFile)
const hash = (contents: string) =>
  createHash('sha256').update(contents).digest('hex')

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isDirectory()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code

    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error
    }

    return false
  }
}

export async function readUpgradeRouters(
  directory: string
): Promise<UpgradeApp['routers']> {
  const routers: UpgradeApp['routers'] = []

  for (const router of ['app', 'pages'] as const) {
    if (
      (await exists(join(directory, router))) ||
      (await exists(join(directory, 'src', router)))
    ) {
      routers.push(router)
    }
  }

  return routers
}

export async function readUpgradeApp(
  directory: string,
  config: NextConfig,
  routers: UpgradeApp['routers']
): Promise<UpgradeApp> {
  const requireFromApp = createRequire(join(directory, 'package.json'))
  const next = JSON.parse(
    await readFile(requireFromApp.resolve('next/package.json'), 'utf8')
  )
  const manifestPath = join(directory, 'package.json')
  const manifest = await readFile(manifestPath, 'utf8')
  let lockfilePath: string | undefined
  let lockfileHash: string | undefined
  const lockfiles = [
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
  ]
  let current = directory

  for (;;) {
    for (const name of lockfiles) {
      try {
        const contents = await readFile(join(current, name), 'utf8')
        lockfilePath = join(current, name)
        lockfileHash = hash(contents)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }

    if (lockfilePath || dirname(current) === current) {
      break
    }

    current = dirname(current)
  }

  return {
    directory,
    nextVersion: next.version,
    routers,
    config,
    manifestPath,
    manifestHash: hash(manifest),
    lockfilePath,
    lockfileHash,
  }
}

function relevantConfig(config: NextConfig): NextConfig {
  // Retain only fields used to preserve upgrade policy and optional features.
  return {
    cacheComponents: config.cacheComponents,
    partialPrefetching: config.partialPrefetching,
    experimental: {
      agenticAutoUpgrade: config.experimental?.agenticAutoUpgrade,
    },
  }
}

async function readPackageVersion(
  name: string,
  revision: string
): Promise<string> {
  const { value } = await fetchJSON(
    `${NPM_REGISTRY}${encodeURIComponent(name)}/${encodeURIComponent(revision)}`
  )

  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !semver.valid(value.version)
  ) {
    throw new Error(`Incomplete metadata for ${name}@${revision}.`)
  }

  return value.version
}

export interface UpgradeDependencies {
  now: () => Date
  readRouters: typeof readUpgradeRouters
  loadConfig: (directory: string) => Promise<NextConfig>
  readApp: typeof readUpgradeApp
  readSecurity: () => Promise<SecuritySnapshot>
  resolveRevision: (revision: string) => Promise<string>
  resolveCodemod: () => Promise<string>
  getRunner: (directory: string) => string[]
  checkCodemod: (command: string, args: string[]) => Promise<void>
  nodeVersion: string
  invokingNextVersion: string
}

export async function checkCodemod(
  command: string,
  args: string[]
): Promise<void> {
  // Package managers can otherwise suppress the error we need to explain a blocker.
  const probeArgs = [
    ...args.filter((arg) => arg !== '--silent' && arg !== '--quiet'),
    'upgrade',
    '--help',
  ]
  let stdout: string

  try {
    ;({ stdout } = await execFileAsync(command, probeArgs, {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }))
  } catch (error) {
    const cause = error as ExecFileException & {
      stdout?: string
      stderr?: string
    }
    const status = cause.killed
      ? 'timed out after 60 seconds'
      : cause.signal
        ? `signal ${cause.signal}`
        : `exit code ${cause.code ?? 'unknown'}`
    const details = [cause.stderr?.trim(), cause.stdout?.trim()]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      `Could not check codemod compatibility (${status}).\n` +
        `Command: ${[command, ...probeArgs].join(' ')}\n` +
        `${details || cause.message}\n` +
        'Resolve this command failure, then retry next upgrade --experimental-agent.',
      { cause: error }
    )
  }

  for (const option of ['--skip-adoption', '--yes']) {
    if (!stdout.includes(option)) {
      throw new Error(
        `The selected codemod does not support ${option}. Use a release containing the upgrade controls.`
      )
    }
  }
}

const defaults: UpgradeDependencies = {
  now: () => new Date(),
  readRouters: readUpgradeRouters,
  loadConfig: (directory) => loadConfig(PHASE_INFO, directory),
  readApp: readUpgradeApp,
  readSecurity: readSecuritySnapshot,
  resolveRevision: (revision) => readPackageVersion('next', revision),
  resolveCodemod: () => readPackageVersion('@next/codemod', 'canary'),
  getRunner: (directory) => getNpxCommand(directory).split(' '),
  checkCodemod,
  nodeVersion: process.versions.node,
  invokingNextVersion:
    process.env.__NEXT_VERSION ?? require('../../../package.json').version,
}

export async function resolveUpgrade(
  input: {
    directory: string
    config?: { directory: string; value: NextConfig }
    app?: UpgradeApp
    snapshot?: SecuritySnapshot
    target?: string
    revision?: string
  },
  overrides: Partial<UpgradeDependencies> = {}
): Promise<UpgradeResolution> {
  const deps = { ...defaults, ...overrides }

  try {
    const directory = resolve(input.directory)

    // Reused inputs must belong to this app, especially in a monorepo.
    if (input.config && resolve(input.config.directory) !== directory) {
      throw new Error('Supplied configuration belongs to a different app.')
    }

    if (input.app && resolve(input.app.directory) !== directory) {
      throw new Error(
        'Supplied installed-app context belongs to a different app.'
      )
    }

    // Identify the app before loading config or fetching metadata. A config
    // file is optional; router directories also select the migration guides.
    const routers = input.app?.routers ?? (await deps.readRouters(directory))

    if (!routers.length) {
      return {
        status: 'disabled',
        reason:
          `No App Router or Pages Router directory found in ${directory}. ` +
          'Run from the app directory or pass it explicitly: next upgrade <app-directory> --experimental-agent.',
      }
    }

    // The flag selects agent execution, but the app's config controls opt-in.
    const config = relevantConfig(
      input.config?.value ??
        input.app?.config ??
        (await deps.loadConfig(directory))
    )
    const policy = config.experimental?.agenticAutoUpgrade

    if (policy === undefined) {
      return {
        status: 'disabled',
        reason:
          "Set experimental.agenticAutoUpgrade to 'security' to enable agent upgrades.",
      }
    }

    if (policy !== 'security') {
      throw new Error('Unsupported agenticAutoUpgrade policy.')
    }

    // Assess the installed version, not the dependency range in package.json.
    const app = input.app ?? (await deps.readApp(directory, config, routers))

    if (
      !app.manifestHash ||
      !app.routers.length ||
      !semver.valid(app.nextVersion)
    ) {
      throw new Error('Incomplete installed-app context.')
    }

    if (JSON.stringify(relevantConfig(app.config)) !== JSON.stringify(config)) {
      throw new Error(
        'Supplied app configuration does not match the selected configuration.'
      )
    }

    // Reused evidence expires so a later run does not miss newly disclosed
    // vulnerabilities. Unaffected apps exit before any codemod probe or handoff.
    const snapshot = input.snapshot ?? (await deps.readSecurity())
    const now = deps.now()

    if (now.getTime() - Date.parse(snapshot.checkedAt) > 60 * 60 * 1000) {
      throw new Error(
        'Security evidence is stale. Refresh the advisory and release snapshot.'
      )
    }

    const selected = selectSecurityTarget(app.nextVersion, snapshot, now)

    if (!selected) {
      return {
        status: 'unaffected',
        reason: `Next.js ${app.nextVersion} matches no reviewed, nonwithdrawn Next.js advisory in this snapshot.`,
      }
    }

    // An explicit revision must agree with the security policy's target; it
    // cannot override that decision or silently request a different upgrade.
    const revision = input.revision
      ? await deps.resolveRevision(input.revision)
      : undefined

    if (input.target && revision && revision !== input.target) {
      throw new Error('Supplied target conflicts with --revision.')
    }

    const explicit = input.target ?? revision

    if (explicit && explicit !== selected.version) {
      throw new Error(
        `The supplied target conflicts with the security target ${selected.version}.`
      )
    }

    if (
      !selected.engines?.node ||
      !semver.satisfies(deps.nodeVersion, selected.engines.node)
    ) {
      throw new Error(
        `Next.js ${selected.version} requires Node.js ${selected.engines?.node ?? '(metadata unavailable)'}. Install a supported runtime before continuing.`
      )
    }

    // Resolve canary once and probe that exact release. The agent must run the
    // same codemod we checked, even if a new canary is published in the meantime.
    const codemodVersion = await deps.resolveCodemod()

    if (semver.valid(codemodVersion) !== codemodVersion) {
      throw new Error('The codemod must resolve to an exact published version.')
    }

    const [command, ...runnerArgs] = deps.getRunner(directory)
    const toolArgs = [...runnerArgs, `@next/codemod@${codemodVersion}`]
    await deps.checkCodemod(command, toolArgs)
    // Avoid prompts and optional adoption transforms during security repairs.
    const args = [
      ...toolArgs,
      'upgrade',
      selected.version,
      '--yes',
      '--skip-adoption',
    ]
    return {
      status: 'ready',
      app,
      snapshot,
      target: {
        nextVersion: selected.version,
        reason: `Upgrade affected Next.js ${app.nextVersion} to the latest stable release of the first eligible supported safe major (${semver.major(selected.version)}).`,
      },
      tools: {
        invokingNextVersion: deps.invokingNextVersion,
        codemodVersion,
        command,
        args,
      },
    }
  } catch (error) {
    return {
      status: 'blocked',
      reason:
        error instanceof Error
          ? error.message
          : 'Could not resolve the security upgrade.',
    }
  }
}
