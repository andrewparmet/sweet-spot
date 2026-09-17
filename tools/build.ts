import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';
import { appsScriptComponents, getAppsScriptDeployment, repositoryRoot } from './components.ts';

const SERVER_GLOBAL = 'SweetSpotIntakeServer';
const buildEnvironment = process.argv[2] ?? 'staging';
const selectedComponent = process.argv[3];
if (buildEnvironment !== 'staging' && buildEnvironment !== 'production') {
  throw new Error('Build environment must be staging or production.');
}
if (selectedComponent && selectedComponent !== 'admin' && selectedComponent !== 'intake') {
  throw new Error('Build component must be admin or intake.');
}

async function buildAdmin(): Promise<void> {
  const component = appsScriptComponents.admin;
  const sourceDirectory = path.join(component.directory, 'src');
  await rm(component.distDirectory, { recursive: true, force: true });
  await mkdir(component.distDirectory, { recursive: true });

  const deployment = getAppsScriptDeployment(`admin-${buildEnvironment}`);
  if (!deployment.configFile) {
    throw new Error(`No configuration file is defined for ${deployment.name}.`);
  }
  const config = JSON.parse(await readFile(deployment.configFile, 'utf8')) as {
    readonly liveRtoSubmission?: unknown;
    readonly queueSpreadsheetId?: unknown;
    readonly tournamentWeightCode?: unknown;
  };
  if (typeof config.queueSpreadsheetId !== 'string' || !config.queueSpreadsheetId) {
    throw new Error(`No queueSpreadsheetId is defined in ${deployment.configFile}.`);
  }
  if (config.liveRtoSubmission !== (buildEnvironment === 'production')) {
    throw new Error(`${deployment.configFile} has the wrong liveRtoSubmission value for ${buildEnvironment}.`);
  }
  if (config.tournamentWeightCode !== 'X' && config.tournamentWeightCode !== 'C') {
    throw new Error(`${deployment.configFile} must define tournamentWeightCode as X or C.`);
  }
  if (buildEnvironment === 'production') {
    const stagingConfig = JSON.parse(
      await readFile(getAppsScriptDeployment('admin-staging').configFile as string, 'utf8')
    ) as { readonly queueSpreadsheetId?: unknown };
    if (config.queueSpreadsheetId === stagingConfig.queueSpreadsheetId) {
      throw new Error('Production and staging must use different queue spreadsheets.');
    }
  }

  const serverResult = await build({
    bundle: true,
    entryPoints: [path.join(sourceDirectory, 'server.ts')],
    format: 'iife',
    globalName: 'SweetSpotAdminServer',
    platform: 'neutral',
    target: 'es2020',
    write: false
  });
  const serverBundle = outputText(serverResult.outputFiles, '.js');
  const spreadsheetId = JSON.stringify(config.queueSpreadsheetId);
  const liveRtoSubmission = JSON.stringify(config.liveRtoSubmission);
  const tournamentWeightCode = JSON.stringify(config.tournamentWeightCode);
  const appsScriptWrappers = `
function doGet() {
  return SweetSpotAdminServer.doGet();
}

function adminLogin(payload) {
  return SweetSpotAdminServer.adminLogin(payload);
}

function loadAdminQueue(token, request) {
  return SweetSpotAdminServer.loadAdminQueue(token, ${spreadsheetId}, request);
}

function loadBostonDirectory(token, matchType) {
  return SweetSpotAdminServer.loadBostonDirectory(token, matchType);
}

function loadPlayerDirectory(token, matchType, playerNames) {
  return SweetSpotAdminServer.loadPlayerDirectory(token, matchType, playerNames);
}

function submitReviewedMatch(token, payload) {
  return SweetSpotAdminServer.submitReviewedMatch(
    token,
    payload,
    ${spreadsheetId},
    ${liveRtoSubmission},
    ${tournamentWeightCode}
  );
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
    .replaceAll('__SWEET_SPOT_ENVIRONMENT__', buildEnvironment === 'staging' ? 'Staging' : '')
    .replace('/*__SWEET_SPOT_STYLES__*/', () => stylesheet.replaceAll('</style', '<\\/style'))
    .replace('/*__SWEET_SPOT_SCRIPT__*/', () => clientBundle);
  if (html.includes('__SWEET_SPOT_')) {
    throw new Error('The admin HTML template contains an unresolved build placeholder.');
  }
  if (html.match(/<!doctype html>/gi)?.length !== 1) {
    throw new Error('The admin build produced duplicate HTML documents.');
  }
  await Promise.all([
    writeFile(path.join(component.distDirectory, 'Index.html'), html),
    writeFile(path.join(component.distDirectory, 'appsscript.json'), manifest)
  ]);
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
function doGet(event) {
  ${SERVER_GLOBAL}.ensureSetup('${buildEnvironment}');
  const bridgeChannel = event && event.parameter && event.parameter.bridge === '1' ? event.parameter.channel : '';
  return ${SERVER_GLOBAL}.doGet(bridgeChannel);
}

function warmUp() {
  return true;
}

function submitMatch(payload) {
  ${SERVER_GLOBAL}.ensureSetup('${buildEnvironment}');
  return ${SERVER_GLOBAL}.submitMatch(payload);
}

function undoSubmission(payload) {
  ${SERVER_GLOBAL}.ensureSetup('${buildEnvironment}');
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
  const [htmlTemplate, bridgeTemplate, stylesheet, manifest] = await Promise.all([
    readFile(path.join(sourceDirectory, 'index.html'), 'utf8'),
    readFile(path.join(sourceDirectory, 'bridge.html'), 'utf8'),
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
    writeFile(path.join(component.distDirectory, 'Bridge.html'), bridgeTemplate),
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

if (!selectedComponent || selectedComponent === 'admin') {
  await buildAdmin();
  console.log(`Built admin at ${path.relative(repositoryRoot, appsScriptComponents.admin.distDirectory)}`);
}
if (!selectedComponent || selectedComponent === 'intake') {
  await buildIntake();
  console.log(`Built intake at ${path.relative(repositoryRoot, appsScriptComponents.intake.distDirectory)}`);
}
