import type { SkillInstallSpec } from "./loader";
import { getSandboxPaths, type SandboxClient } from "../tools/sandbox-types";

/** Install kinds supported by our sandbox (has npm + curl + pip).
 * "uv" is also accepted — we execute it via pip since uv isn't installed. */
export const SUPPORTED_INSTALL_KINDS = new Set<string>(["node", "download", "pip", "uv"]);

function getInstallEnv() {
  const paths = getSandboxPaths();
  return {
    depsDir: paths.homeBin,
    homeLocal: paths.homeLocal,
    envPrefix: `PATH=${paths.homeBin}:$PATH PYTHONUSERBASE=${paths.homeLocal} PIP_USER=1`,
  };
}

/** Timeout for install commands (npm/pip/curl). Prevents hanging installs from blocking the request. */
const INSTALL_TIMEOUT_S = 30;

/** npm package name: scoped or unscoped, optional @version.
 * Version suffix restricted to [a-zA-Z0-9._-] to prevent shell injection. */
const NPM_PACKAGE_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-zA-Z0-9._-]+)?$/;

/** PyPI package name: alphanumeric + hyphens/underscores/periods, optional extras [extra1,extra2].
 * No version specifiers allowed (we always install latest). */
const PIP_PACKAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\[[a-zA-Z0-9,._-]+\])?$/;

/** Bin name: must start with letter/digit (no leading -), then alphanumeric/hyphen/underscore. */
const BIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function validateNpmPackage(pkg: string): boolean {
  if (!pkg || pkg.startsWith("-")) return false;
  return NPM_PACKAGE_RE.test(pkg);
}

export function validateDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    if (parsed.href.includes("'")) return false;
    return true;
  } catch (e) {
    console.warn("[install] Invalid download URL:", url, e);
    return false;
  }
}

export function validatePipPackage(pkg: string): boolean {
  if (!pkg || pkg.length > 128 || pkg.startsWith("-")) return false;
  return PIP_PACKAGE_RE.test(pkg);
}

export function validateBinName(bin: string): boolean {
  if (!bin || bin.length > 64) return false;
  return BIN_NAME_RE.test(bin);
}

/**
 * Check if a binary exists in the sandbox (system PATH or homeLocal/bin).
 */
export async function binExists(sandbox: SandboxClient, bin: string): Promise<boolean> {
  if (!validateBinName(bin)) return false;
  const { envPrefix } = getInstallEnv();
  const result = await sandbox.exec(`${envPrefix} which '${bin}'`);
  return result.exitCode === 0;
}

/**
 * Build and execute the install command for a given spec.
 * Returns { ok, message }.
 */
export async function executeInstallSpec(
  sandbox: SandboxClient,
  spec: SkillInstallSpec,
): Promise<{ ok: boolean; message: string }> {
  const { depsDir, homeLocal, envPrefix } = getInstallEnv();
  await sandbox.exec(`mkdir -p ${depsDir}`);

  if (spec.kind === "node" && spec.package) {
    if (!validateNpmPackage(spec.package)) {
      return { ok: false, message: `Invalid npm package name: "${spec.package}"` };
    }
    // SAFETY: validateNpmPackage ensures only [a-z0-9-._~@/] and version [a-zA-Z0-9._-].
    // Validated input is safe in single quotes.
    const result = await sandbox.exec(
      `${envPrefix} timeout ${INSTALL_TIMEOUT_S} npm install -g --prefix ${homeLocal} '${spec.package}'`
    );
    if (result.exitCode !== 0) {
      return { ok: false, message: `npm install failed: ${result.stderr || result.stdout}`.slice(0, 500) };
    }
    return { ok: true, message: "Installed via npm" };
  }

  if ((spec.kind === "pip" || spec.kind === "uv") && spec.package) {
    if (!validatePipPackage(spec.package)) {
      return { ok: false, message: `Invalid pip package name: "${spec.package}"` };
    }
    // SAFETY: validatePipPackage ensures only [a-zA-Z0-9._-] and optional [extras].
    // "uv" kind uses the same PyPI packages — we install via pip3 as fallback.
    const result = await sandbox.exec(
      `${envPrefix} timeout ${INSTALL_TIMEOUT_S} pip3 install --no-cache-dir '${spec.package}'`
    );
    if (result.exitCode !== 0) {
      return { ok: false, message: `pip install failed: ${result.stderr || result.stdout}`.slice(0, 500) };
    }
    return { ok: true, message: `Installed via pip (${spec.kind} spec)` };
  }

  if (spec.kind === "download" && spec.url) {
    if (!validateDownloadUrl(spec.url)) {
      return { ok: false, message: `Invalid download URL: "${spec.url}"` };
    }
    const bin = spec.bins?.[0];
    if (!bin || !validateBinName(bin)) {
      return { ok: false, message: `Invalid or missing bin name in download spec` };
    }
    // SAFETY: validateDownloadUrl ensures https + no single quotes.
    // validateBinName ensures [a-zA-Z0-9_-] only.
    const normalizedUrl = new URL(spec.url).href;
    const result = await sandbox.exec(
      `timeout ${INSTALL_TIMEOUT_S} curl -fsSL '${normalizedUrl}' -o '${depsDir}/${bin}' && chmod +x '${depsDir}/${bin}'`
    );
    if (result.exitCode !== 0) {
      return { ok: false, message: `Download failed: ${result.stderr || result.stdout}`.slice(0, 500) };
    }
    return { ok: true, message: "Installed via download" };
  }

  return { ok: false, message: `Unsupported install kind: "${spec.kind}"` };
}

/**
 * Check OS compatibility. Returns true if skill can run on linux.
 */
export function isLinuxCompatible(os?: string[]): boolean {
  if (!os || os.length === 0) return true;
  return os.includes("linux");
}

/**
 * Find install specs that are supported by our sandbox AND well-formed.
 */
export function findCompatibleSpecs(specs: SkillInstallSpec[]): SkillInstallSpec[] {
  return specs.filter((s) => {
    if (!SUPPORTED_INSTALL_KINDS.has(s.kind)) return false;
    if (s.kind === "node") return !!s.package;
    if (s.kind === "pip" || s.kind === "uv") return !!s.package;
    if (s.kind === "download") return !!s.url && !!s.bins?.length;
    return false;
  });
}
