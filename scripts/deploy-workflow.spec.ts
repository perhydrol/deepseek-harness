import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

it('automatically runs only the deployment image workflow in this fork', () => {
  for (const file of readdirSync(resolve(root, '.github/workflows'))) {
    if (!file.endsWith('.yml')) continue
    const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows', file), 'utf8')) as {
      on: Record<string, unknown>
    }
    const automatic = Object.keys(workflow.on).filter(event => !['workflow_dispatch', 'workflow_call'].includes(event))
    expect(automatic, file).toEqual(file === 'deploy-image.yml' ? ['push'] : [])
    if (file === 'deploy-image.yml') expect(workflow.on.push).toMatchObject({ branches: ['master'] })
  }
})

it('publishes the single-container image only from master after lifecycle validation', () => {
  const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/deploy-image.yml'), 'utf8')) as {
    env: Record<string, string>
    jobs: Record<string, { steps: { name?: string; if?: string; run?: string; with?: Record<string, unknown> }[] }>
  }
  expect(workflow.env.IMAGE).toBe('ghcr.io/perhydrol/dsh-used-by-self')
  const steps = workflow.jobs.build?.steps ?? []
  const validate = steps.findIndex(step => step.name === 'Validate deployment and image')
  const publish = steps.findIndex(step => step.name === 'Publish validated image')
  expect(validate).toBeGreaterThan(-1)
  expect(publish).toBeGreaterThan(validate)
  expect(steps[validate]?.run).toContain('deploy/smoke.mjs')
  expect(steps[publish]?.if).toBe("github.ref == 'refs/heads/master'")
  expect(steps.find(step => step.with?.file)?.with).toMatchObject({
    context: 'experiments/public-auth', file: 'experiments/public-auth/deploy/Dockerfile', load: true,
  })
})
