import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve, sep } from 'path'
import semver from 'next/dist/compiled/semver'
import type { UpgradeResolution } from './resolve'

const execFileAsync = promisify(execFile)
type ReadyUpgrade = Extract<UpgradeResolution, { status: 'ready' }>

interface UpgradeContext {
  schemaVersion: 1
  runDirectory: string
  policy: 'security'
  /** Complete and verify local commits, then stop before publication. */
  dryRun: boolean
  app: ReadyUpgrade['app']
  target: ReadyUpgrade['target']
  tools: ReadyUpgrade['tools']
  docs: {
    root: string
    guides: string[]
    sources: {
      path: string
      source: string
      sourceRevision: string
      major?: number
    }[]
  }
  security: {
    checkedAt: string
    evidenceReferences: string[]
    snapshotPath: string
  }
}

export interface ResourceDependencies {
  tempRoot: string
  docsRoot: string
  workflowPath: string
  migrationWorkflowPath: string
  sourceRevision: string
  fetchDocs: (
    version: string,
    directory: string
  ) => Promise<{ root: string; sourceRevision: string }>
}

async function fetchReleaseDocs(version: string, directory: string) {
  if (semver.valid(version) !== version) {
    throw new Error('An exact release is required for documentation fallback.')
  }

  const git = (args: string[]) =>
    execFileAsync('git', args, { timeout: 60_000, maxBuffer: 1024 * 1024 })
  await git([
    'clone',
    '--depth',
    '1',
    '--filter=blob:none',
    '--sparse',
    '--branch',
    `v${version}`,
    'https://github.com/vercel/next.js.git',
    directory,
  ])
  await git(['-C', directory, 'sparse-checkout', 'set', 'docs'])
  const { stdout } = await git(['-C', directory, 'rev-parse', 'HEAD'])
  return { root: join(directory, 'docs'), sourceRevision: stdout.trim() }
}

async function listDocs(root: string, directory = root): Promise<string[]> {
  const files: string[] = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await listDocs(root, file)))
    } else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
      files.push(relative(root, file))
    }
  }

  return files
}

export function selectGuidePaths(
  files: string[],
  source: string,
  target: string,
  routers: ('app' | 'pages')[]
): string[] {
  const from = semver.major(source)
  const to = semver.major(target)
  // Include every crossed major (14 -> 16 needs both 15 and 16). Same-major
  // upgrades retain that major's guide for any applicable migration guidance.
  const firstMajor = from === to ? from : from + 1
  const selected = new Set<string>()
  const normalized = (file: string) => file.split(sep).join('/')

  for (let major = firstMajor; major <= to; major++) {
    for (const router of routers) {
      let matching = files.filter((file) => {
        const name = normalized(file)
        return (
          new RegExp(`(?:^|/)\\d*[-]?${router}/`).test(name) &&
          /(?:^|\/)\d*-?upgrading\//.test(name) &&
          new RegExp(`(?:^|/)(?:\\d+-)?version-${major}\\.mdx?$`).test(name)
        )
      })

      // Version guides are canonical shared content under app/ in current releases.
      if (!matching.length && router === 'pages') {
        matching = files.filter(
          (file) =>
            /(?:^|\/)\d*-?app\//.test(normalized(file)) &&
            new RegExp(`(?:^|/)(?:\\d+-)?version-${major}\\.mdx?$`).test(
              normalized(file)
            )
        )
      }

      if (!matching.length) {
        throw new Error(
          `Missing ${router} migration guide for Next.js ${major}.`
        )
      }

      selected.add(matching[0])
    }
  }

  const codemods = files.filter((file) =>
    /(?:^|\/)(?:\d+-)?codemods\.mdx?$/.test(normalized(file))
  )

  if (!codemods.length) {
    throw new Error('Missing canonical codemod guide.')
  }

  codemods.forEach((file) => selected.add(file))
  return [...selected].sort()
}

export async function prepareUpgradeResources(
  upgrade: ReadyUpgrade,
  options: Partial<ResourceDependencies> & { dryRun?: boolean } = {}
): Promise<{
  context: UpgradeContext
  contextPath: string
  workflowPath: string
  prompt: string
}> {
  const { dryRun = false, ...overrides } = options
  const bundledDocsRoot = overrides.docsRoot ?? resolve(__dirname, '../../docs')
  const deps: ResourceDependencies = {
    tempRoot: tmpdir(),
    docsRoot: bundledDocsRoot,
    workflowPath: join(
      bundledDocsRoot,
      '01-app/02-guides/upgrading/security-upgrade.md'
    ),
    migrationWorkflowPath: join(
      bundledDocsRoot,
      '01-app/02-guides/upgrading/security-migration.md'
    ),
    sourceRevision: `v${upgrade.tools.invokingNextVersion}`,
    fetchDocs: fetchReleaseDocs,
    ...overrides,
  }
  // Keep inputs outside the app and available after this CLI exits so the
  // agent can finish the migration without depending on a live Next process.
  const runDirectory = await mkdtemp(join(deps.tempRoot, 'next-upgrade-'))

  try {
    const docsRoot = join(runDirectory, 'docs')
    let sourceRoot = deps.docsRoot
    let sourceRevision = deps.sourceRevision
    let files: string[]

    try {
      files = await listDocs(sourceRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }

      // Fetch the invoking release so later guide corrections are retained.
      const fallback = await deps.fetchDocs(
        upgrade.tools.invokingNextVersion,
        join(runDirectory, 'invoking-docs')
      )
      sourceRoot = fallback.root
      sourceRevision = fallback.sourceRevision
      files = await listDocs(sourceRoot)
    }

    let guides: string[]

    try {
      guides = selectGuidePaths(
        files,
        upgrade.app.nextVersion,
        upgrade.target.nextVersion,
        upgrade.app.routers
      )
    } catch {
      const fallback = await deps.fetchDocs(
        upgrade.target.nextVersion,
        join(runDirectory, 'target-docs')
      )
      const fallbackFiles = await listDocs(fallback.root)
      const combined = [...new Set([...files, ...fallbackFiles])]
      guides = selectGuidePaths(
        combined,
        upgrade.app.nextVersion,
        upgrade.target.nextVersion,
        upgrade.app.routers
      )
      // Keep corrected invoking-package guides and fill only missing paths.
      const provenance = guides.map((file) => ({
        path: file,
        source: files.includes(file) ? sourceRoot : fallback.root,
        sourceRevision: files.includes(file)
          ? sourceRevision
          : fallback.sourceRevision,
      }))
      return await finish(provenance)
    }

    return await finish(
      guides.map((file) => ({ path: file, source: sourceRoot, sourceRevision }))
    )

    async function finish(sources: UpgradeContext['docs']['sources']) {
      // Preserve source paths so retained guides keep their directory structure.
      for (const { path: guide, source } of sources) {
        const destination = resolve(docsRoot, guide)

        if (!destination.startsWith(docsRoot + sep)) {
          throw new Error('Invalid migration guide path.')
        }

        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, await readFile(join(source, guide)), {
          flag: 'wx',
        })
      }

      const workflowPath = join(runDirectory, 'security-upgrade.md')
      await writeFile(workflowPath, await readFile(deps.workflowPath), {
        flag: 'wx',
      })
      await writeFile(
        join(runDirectory, 'security-migration.md'),
        await readFile(deps.migrationWorkflowPath),
        { flag: 'wx' }
      )
      const snapshotPath = join(runDirectory, 'security-snapshot.json')
      await writeFile(snapshotPath, JSON.stringify(upgrade.snapshot, null, 2), {
        flag: 'wx',
      })
      const context: UpgradeContext = {
        schemaVersion: 1,
        runDirectory,
        policy: 'security',
        dryRun,
        app: upgrade.app,
        target: upgrade.target,
        tools: upgrade.tools,
        docs: {
          root: docsRoot,
          guides,
          sources: sources.map((source) => ({
            ...source,
            source: source.source.startsWith(runDirectory + sep)
              ? `https://github.com/vercel/next.js/blob/${source.sourceRevision}/docs/${source.path.split(sep).join('/')}`
              : join(source.source, source.path),
            major: Number(source.path.match(/version-(\d+)/)?.[1]) || undefined,
          })),
        },
        security: {
          checkedAt: upgrade.snapshot.checkedAt,
          evidenceReferences: upgrade.snapshot.evidenceReferences,
          snapshotPath,
        },
      }
      const contextPath = join(runDirectory, 'context.json')
      await writeFile(contextPath, JSON.stringify(context, null, 2), {
        flag: 'wx',
      })
      // Retain only the selected complete guides, not the temporary sparse clones.
      await Promise.all(
        ['invoking-docs', 'target-docs'].map((name) =>
          rm(join(runDirectory, name), { recursive: true, force: true })
        )
      )
      return {
        context,
        contextPath,
        workflowPath,
        prompt: `Read and follow ${JSON.stringify(workflowPath)}. Use ${JSON.stringify(contextPath)} for this upgrade's resolved inputs. Preserve your existing permissions.${dryRun ? ' This is a --experimental-agent-dry-run: complete the migration and verification, create local commits, then stop. Do not push or create a PR/MR.' : ''}`,
      }
    }
  } catch (error) {
    await rm(runDirectory, { recursive: true, force: true })
    throw error
  }
}
