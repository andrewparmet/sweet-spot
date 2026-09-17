import process from 'node:process';
import path from 'node:path';
import { getAppsScriptDeployment, repositoryRoot } from './components.ts';
import { run } from './process.ts';

const componentName = process.argv[2];
if (!componentName) {
  throw new Error('Usage: tsx tools/create-apps-script.ts <component>');
}

const component = getAppsScriptDeployment(componentName);
run('npm', ['run', 'build'], { cwd: repositoryRoot });
run(
  'npx',
  [
    'clasp',
    '--project',
    path.basename(component.projectFile),
    'create',
    '--type',
    'webapp',
    '--title',
    component.title,
    '--rootDir',
    'dist'
  ],
  { cwd: component.directory }
);
console.log(`Created ${component.title}. Commit ${path.basename(component.projectFile)} after verifying the project.`);
