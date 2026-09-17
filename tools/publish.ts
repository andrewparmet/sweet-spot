import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { getAppsScriptDeployment, repositoryRoot } from './components.ts';
import { run } from './process.ts';

const componentName = process.argv[2];
if (!componentName) {
  throw new Error('Usage: tsx tools/publish.ts <component>');
}

const component = getAppsScriptDeployment(componentName);
if (!existsSync(component.projectFile)) {
  throw new Error(`Create ${componentName} first with npm run create:${componentName.replace('-', ':')}.`);
}

run('npm', ['run', 'check'], { cwd: repositoryRoot });
const projectArguments = ['clasp', '--project', component.projectFile];
run('npx', [...projectArguments, 'push', '--force'], { cwd: component.directory });

const description = `Published ${new Date().toISOString()}`;
if (existsSync(component.deploymentIdFile)) {
  const deploymentId = readFileSync(component.deploymentIdFile, 'utf8').trim();
  run('npx', [...projectArguments, 'deploy', '--deploymentId', deploymentId, '--description', description], {
    cwd: component.directory
  });
  console.log(`Published ${component.title}.`);
} else {
  const output = run('npx', [...projectArguments, 'deploy', '--description', description], {
    capture: true,
    cwd: component.directory
  });
  process.stdout.write(output);
  const deploymentId = output.match(/\b(AKfy[a-zA-Z0-9_-]+)\b/)?.[1];
  if (!deploymentId) {
    throw new Error('The deployment succeeded, but its ID could not be read from clasp output.');
  }
  writeFileSync(component.deploymentIdFile, `${deploymentId}\n`);
  console.log(`Saved the stable ${componentName} deployment ID. Commit it after verifying the deployment.`);
}
