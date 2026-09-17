import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AppsScriptComponent {
  readonly name: string;
  readonly title: string;
  readonly directory: string;
  readonly distDirectory: string;
}

export interface AppsScriptDeployment extends AppsScriptComponent {
  readonly deploymentIdFile: string;
  readonly environment: 'production' | 'staging';
  readonly projectFile: string;
}

export const appsScriptComponents = {
  admin: {
    name: 'admin',
    title: 'Sweet Spot Admin',
    directory: path.join(repositoryRoot, 'apps', 'admin'),
    distDirectory: path.join(repositoryRoot, 'apps', 'admin', 'dist')
  },
  intake: {
    name: 'intake',
    title: 'Sweet Spot Intake',
    directory: path.join(repositoryRoot, 'apps', 'intake'),
    distDirectory: path.join(repositoryRoot, 'apps', 'intake', 'dist')
  }
} as const satisfies Record<string, AppsScriptComponent>;

export const appsScriptDeployments = {
  'intake-production': {
    ...appsScriptComponents.intake,
    environment: 'production',
    name: 'intake-production',
    title: 'Sweet Spot Intake',
    projectFile: path.join(repositoryRoot, 'apps', 'intake', '.clasp.production.json'),
    deploymentIdFile: path.join(repositoryRoot, 'apps', 'intake', '.deployment.production-id')
  },
  'intake-staging': {
    ...appsScriptComponents.intake,
    environment: 'staging',
    name: 'intake-staging',
    title: 'Sweet Spot Intake (Staging)',
    projectFile: path.join(repositoryRoot, 'apps', 'intake', '.clasp.staging.json'),
    deploymentIdFile: path.join(repositoryRoot, 'apps', 'intake', '.deployment.staging-id')
  }
} as const satisfies Record<string, AppsScriptDeployment>;

export type AppsScriptDeploymentName = keyof typeof appsScriptDeployments;

export function getAppsScriptDeployment(name: string): AppsScriptDeployment {
  if (!(name in appsScriptDeployments)) {
    throw new Error(`Unknown deployment: ${name}`);
  }
  return appsScriptDeployments[name as AppsScriptDeploymentName];
}

export { repositoryRoot };
