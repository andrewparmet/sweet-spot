import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { getAppsScriptDeployment, repositoryRoot, type AppsScriptDeployment } from './components.ts';
import { run } from './process.ts';

const componentName = process.argv[2];
if (!componentName) {
  throw new Error('Usage: tsx tools/publish.ts <component>');
}

const component = getAppsScriptDeployment(componentName);
run('npm', ['run', 'check'], { cwd: repositoryRoot });
ensureProject(component);
run('npx', ['tsx', 'tools/build.ts', component.environment], { cwd: repositoryRoot });

const projectArguments = ['clasp', '--project', component.projectFile];
run('npx', [...projectArguments, 'push', '--force'], { cwd: component.directory });
const deploymentId = deploy(component, projectArguments);
const webAppUrl = `https://script.google.com/macros/s/${deploymentId}/exec`;
await verifyWebApp(component, webAppUrl);
console.log(`Verified ${component.title}: ${webAppUrl}`);

function ensureProject(deployment: AppsScriptDeployment): void {
  if (existsSync(deployment.projectFile)) {
    return;
  }
  const defaultProjectFile = path.join(deployment.directory, '.clasp.json');
  if (existsSync(defaultProjectFile)) {
    throw new Error(`Move or remove ${defaultProjectFile} before deploying ${deployment.name}.`);
  }
  run('npx', ['clasp', 'create', '--type', 'webapp', '--title', deployment.title, '--rootDir', 'dist'], {
    cwd: deployment.directory
  });
  renameSync(defaultProjectFile, deployment.projectFile);
  console.log(`Created ${deployment.title}.`);
}

function deploy(deployment: AppsScriptDeployment, projectArguments: readonly string[]): string {
  const description = `Published ${new Date().toISOString()}`;
  if (existsSync(deployment.deploymentIdFile)) {
    const deploymentId = readFileSync(deployment.deploymentIdFile, 'utf8').trim();
    run('npx', [...projectArguments, 'deploy', '--deploymentId', deploymentId, '--description', description], {
      cwd: deployment.directory
    });
    return deploymentId;
  }

  const output = run('npx', [...projectArguments, 'deploy', '--description', description], {
    capture: true,
    cwd: deployment.directory
  });
  process.stdout.write(output);
  const deploymentId = output.match(/\b(AKfy[a-zA-Z0-9_-]+)\b/)?.[1];
  if (!deploymentId) {
    throw new Error('The deployment succeeded, but its ID could not be read from clasp output.');
  }
  writeFileSync(deployment.deploymentIdFile, `${deploymentId}\n`);
  return deploymentId;
}

async function verifyWebApp(deployment: AppsScriptDeployment, webAppUrl: string): Promise<void> {
  let lastFailure = 'No response received.';
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(webAppUrl, { redirect: 'follow' });
      const body = await response.text();
      const expectedTitle = deployment.name.startsWith('admin-') ? 'Score Review' : 'Match Entry';
      if (response.ok && body.includes(expectedTitle)) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : 'Request failed.';
    }
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  const editorUrl = `https://script.google.com/d/${readProjectId(deployment)}/edit`;
  throw new Error(
    [
      `The deployed web app could not be verified: ${lastFailure}`,
      'For a new deployment, open the Apps Script editor and complete the one-time web app authorization:',
      editorUrl,
      'Deploy > Manage deployments > Edit > Who has access: Anyone > Deploy.',
      'Accept the authorization prompt, then run this command again.'
    ].join('\n')
  );
}

function readProjectId(deployment: AppsScriptDeployment): string {
  const project = JSON.parse(readFileSync(deployment.projectFile, 'utf8')) as { scriptId?: unknown };
  if (typeof project.scriptId !== 'string') {
    throw new Error(`No scriptId found in ${deployment.projectFile}.`);
  }
  return project.scriptId;
}
