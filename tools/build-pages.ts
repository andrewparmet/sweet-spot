import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { appsScriptDeployments, repositoryRoot } from './components.ts';

const outputDirectory = path.join(repositoryRoot, 'apps', 'pages', 'dist');

await rm(outputDirectory, { recursive: true, force: true });
await Promise.all([
  mkdir(path.join(outputDirectory, 'staging'), { recursive: true }),
  mkdir(path.join(outputDirectory, 'staging', 'admin'), { recursive: true })
]);

const [intakeDeploymentId, adminDeploymentId] = await Promise.all([
  deploymentId('intake-staging'),
  deploymentId('admin-staging')
]);

await Promise.all([
  writeFile(path.join(outputDirectory, '.nojekyll'), ''),
  writeFile(path.join(outputDirectory, 'index.html'), redirectPage('./staging/')),
  writeFile(
    path.join(outputDirectory, 'staging', 'index.html'),
    framePage('Match Entry', webAppUrl(intakeDeploymentId))
  ),
  writeFile(
    path.join(outputDirectory, 'staging', 'admin', 'index.html'),
    framePage('Score review', webAppUrl(adminDeploymentId))
  )
]);

console.log(`Built GitHub Pages at ${path.relative(repositoryRoot, outputDirectory)}`);

async function deploymentId(name: keyof typeof appsScriptDeployments): Promise<string> {
  const deployment = appsScriptDeployments[name];
  try {
    const value = (await readFile(deployment.deploymentIdFile, 'utf8')).trim();
    if (!/^AKfy[a-zA-Z0-9_-]+$/.test(value)) {
      throw new Error('invalid deployment ID');
    }
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Deploy ${name} before building Pages: ${detail}`, { cause: error });
  }
}

function webAppUrl(deploymentIdValue: string): string {
  return `https://script.google.com/macros/s/${deploymentIdValue}/exec`;
}

function redirectPage(target: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <title>Sweet Spot</title>
    <script>window.location.replace(${JSON.stringify(target)});</script>
  </head>
  <body><a href="${target}">Continue</a></body>
</html>
`;
}

function framePage(title: string, source: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#153f35" />
    <title>${title}</title>
    <style>
      html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
      html, body { overflow: hidden; }
      iframe { display: block; height: 100dvh; }
    </style>
  </head>
  <body><iframe title="${title}" src="${source}" allow="clipboard-write"></iframe></body>
</html>
`;
}
