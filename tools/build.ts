import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';
import { appsScriptComponents, repositoryRoot } from './components.ts';

const SERVER_GLOBAL = 'SweetSpotIntakeServer';
const intakeEnvironment = process.argv[2] ?? 'staging';
if (intakeEnvironment !== 'staging' && intakeEnvironment !== 'production') {
  throw new Error('Build environment must be staging or production.');
}

async function buildAdmin(): Promise<void> {
  const component = appsScriptComponents.admin;
  const sourceDirectory = path.join(component.directory, 'src');
  await rm(component.distDirectory, { recursive: true, force: true });
  await mkdir(component.distDirectory, { recursive: true });

  const clientResult = await build({
    bundle: true,
    entryPoints: [path.join(sourceDirectory, 'client.ts')],
    format: 'iife',
    platform: 'browser',
    target: ['safari15', 'chrome100', 'firefox100'],
    write: false
  });
  const clientBundle = outputText(clientResult.outputFiles, '.js').replaceAll('</script', '<\\/script');
  const [htmlTemplate, stylesheet] = await Promise.all([
    readFile(path.join(sourceDirectory, 'index.html'), 'utf8'),
    readFile(path.join(sourceDirectory, 'styles.css'), 'utf8')
  ]);
  const html = htmlTemplate
    .replace('/*__SWEET_SPOT_STYLES__*/', () => stylesheet.replaceAll('</style', '<\\/style'))
    .replace('/*__SWEET_SPOT_SCRIPT__*/', () => clientBundle);
  if (html.includes('__SWEET_SPOT_')) {
    throw new Error('The admin HTML template contains an unresolved build placeholder.');
  }
  if (html.match(/<!doctype html>/gi)?.length !== 1) {
    throw new Error('The admin build produced duplicate HTML documents.');
  }
  await writeFile(path.join(component.distDirectory, 'Index.html'), html);
}

async function buildIntake(): Promise<void> {
  const component = appsScriptComponents.intake;
  const sourceDirectory = path.join(component.directory, 'src');
  await rm(component.distDirectory, { recursive: true, force: true });
  await mkdir(component.distDirectory, { recursive: true });

  const serverResult = await build({
    bundle: true,
    entryPoints: [path.join(sourceDirectory, 'server.ts')],
    format: 'iife',
    globalName: SERVER_GLOBAL,
    platform: 'neutral',
    target: 'es2020',
    write: false
  });
  const serverBundle = outputText(serverResult.outputFiles, '.js');
  const appsScriptWrappers = `
function doGet() {
  ${SERVER_GLOBAL}.ensureSetup('${intakeEnvironment}');
  return ${SERVER_GLOBAL}.doGet();
}

function submitMatch(payload) {
  ${SERVER_GLOBAL}.ensureSetup('${intakeEnvironment}');
  return ${SERVER_GLOBAL}.submitMatch(payload);
}

function undoSubmission(payload) {
  ${SERVER_GLOBAL}.ensureSetup('${intakeEnvironment}');
  return ${SERVER_GLOBAL}.undoSubmission(payload);
}

function setupProduction_() {
  return ${SERVER_GLOBAL}.setup('production');
}

function setupStaging_() {
  return ${SERVER_GLOBAL}.setup('staging');
}
`;
  await writeFile(path.join(component.distDirectory, 'Code.gs'), `${serverBundle}${appsScriptWrappers}`);

  const clientResult = await build({
    bundle: true,
    entryPoints: [path.join(sourceDirectory, 'client.ts')],
    format: 'iife',
    platform: 'browser',
    target: ['safari15', 'chrome100', 'firefox100'],
    write: false
  });
  const clientBundle = outputText(clientResult.outputFiles, '.js').replaceAll('</script', '<\\/script');
  const [htmlTemplate, stylesheet, manifest] = await Promise.all([
    readFile(path.join(sourceDirectory, 'index.html'), 'utf8'),
    readFile(path.join(sourceDirectory, 'styles.css'), 'utf8'),
    readFile(path.join(component.directory, 'appsscript.json'), 'utf8')
  ]);
  const html = htmlTemplate
    .replace('/*__SWEET_SPOT_STYLES__*/', () => stylesheet.replaceAll('</style', '<\\/style'))
    .replace('/*__SWEET_SPOT_SCRIPT__*/', () => clientBundle);
  if (html.includes('__SWEET_SPOT_')) {
    throw new Error('The intake HTML template contains an unresolved build placeholder.');
  }
  if (html.match(/<!doctype html>/gi)?.length !== 1) {
    throw new Error('The intake build produced duplicate HTML documents.');
  }

  await Promise.all([
    writeFile(path.join(component.distDirectory, 'Index.html'), html),
    writeFile(path.join(component.distDirectory, 'appsscript.json'), manifest)
  ]);
}

function outputText(
  outputFiles: readonly { readonly path: string; readonly text: string }[],
  extension: string
): string {
  const output = outputFiles.length === 1 ? outputFiles[0] : outputFiles.find(file => file.path.endsWith(extension));
  if (!output) {
    throw new Error(`Build did not produce a ${extension} file.`);
  }
  return output.text;
}

await Promise.all([buildAdmin(), buildIntake()]);
console.log(`Built admin at ${path.relative(repositoryRoot, appsScriptComponents.admin.distDirectory)}`);
console.log(`Built intake at ${path.relative(repositoryRoot, appsScriptComponents.intake.distDirectory)}`);
