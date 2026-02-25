#!/usr/bin/env node

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { createGunzip } = require("node:zlib");

// ─── Config ────────────────────────────────────────────────────────────────────
const GITHUB_OWNER = "cowale";
const GITHUB_REPO = "cowaleAiKit";
const DEFAULT_BRANCH = "main";
const AGENT_DIR = ".agent";
const PACKAGE_VERSION = require("../package.json").version;
const PACKAGE_NAME = require("../package.json").name;

// ─── Colors ────────────────────────────────────────────────────────────────────
const color = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const log = {
  info: (msg) => console.log(`${color.cyan}ℹ${color.reset} ${msg}`),
  success: (msg) => console.log(`${color.green}✔${color.reset} ${msg}`),
  warn: (msg) => console.log(`${color.yellow}⚠${color.reset} ${msg}`),
  error: (msg) => console.log(`${color.red}✖${color.reset} ${msg}`),
  step: (msg) => console.log(`${color.dim}  ${msg}${color.reset}`),
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(args) {
  const flags = {};
  const commands = [];

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=");
      flags[key] = val ?? true;
    } else if (arg.startsWith("-")) {
      flags[arg.slice(1)] = true;
    } else {
      commands.push(arg);
    }
  }

  return { commands, flags };
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": PACKAGE_NAME } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      resolve(res);
    }).on("error", reject);
  });
}

function downloadAndExtract(url, destDir, branch) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await httpGet(url);
      const tmpDir = path.join(destDir, ".agent-download-tmp");

      // Clean tmp if exists
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      fs.mkdirSync(tmpDir, { recursive: true });

      // Use tar to extract — requires tar on the system
      const tarball = path.join(tmpDir, "archive.tar.gz");
      const ws = fs.createWriteStream(tarball);

      res.pipe(ws);
      ws.on("finish", () => {
        try {
          // Extract the tarball
          execSync(`tar -xzf "${tarball}" -C "${tmpDir}"`, { stdio: "pipe" });

          // Find the extracted directory (GitHub names it OWNER-REPO-HASH/)
          const entries = fs.readdirSync(tmpDir).filter(
            (e) => e !== "archive.tar.gz" && fs.statSync(path.join(tmpDir, e)).isDirectory()
          );

          if (entries.length === 0) {
            throw new Error("Could not find extracted directory in tarball");
          }

          const extractedRoot = path.join(tmpDir, entries[0]);
          const agentSource = path.join(extractedRoot, AGENT_DIR);

          if (!fs.existsSync(agentSource)) {
            throw new Error(`${AGENT_DIR}/ folder not found in repository`);
          }

          // Copy .agent to destination
          const agentDest = path.join(destDir, AGENT_DIR);
          copyDirSync(agentSource, agentDest);

          // Also copy GEMINI.md to the project root if it exists in the rules folder
          const geminiSource = path.join(agentSource, "rules", "GEMINI.md");
          if (fs.existsSync(geminiSource)) {
            const geminiDest = path.join(destDir, "GEMINI.md");
            if (!fs.existsSync(geminiDest)) {
              fs.copyFileSync(geminiSource, geminiDest);
            }
          }

          // Cleanup tmp
          fs.rmSync(tmpDir, { recursive: true, force: true });

          resolve();
        } catch (err) {
          // Cleanup on error
          if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
          reject(err);
        }
      });

      ws.on("error", (err) => {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function countContents(dir) {
  const counts = { agents: 0, skills: 0, workflows: 0, total: 0 };

  const agentsDir = path.join(dir, "agents");
  const skillsDir = path.join(dir, "skills");
  const workflowsDir = path.join(dir, "workflows");

  if (fs.existsSync(agentsDir)) {
    counts.agents = fs.readdirSync(agentsDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith(".")
    ).length;
  }

  if (fs.existsSync(skillsDir)) {
    counts.skills = fs.readdirSync(skillsDir).filter(
      (f) => fs.statSync(path.join(skillsDir, f)).isDirectory()
    ).length;
  }

  if (fs.existsSync(workflowsDir)) {
    counts.workflows = fs.readdirSync(workflowsDir).filter(
      (f) => f.endsWith(".md")
    ).length;
  }

  counts.total = counts.agents + counts.skills + counts.workflows;
  return counts;
}

// ─── Commands ──────────────────────────────────────────────────────────────────

async function cmdInit(flags) {
  const targetPath = path.resolve(flags.path || ".");
  const branch = flags.branch || DEFAULT_BRANCH;
  const force = flags.force || false;
  const quiet = flags.quiet || false;
  const dryRun = flags["dry-run"] || false;

  const agentDest = path.join(targetPath, AGENT_DIR);

  if (!quiet) {
    console.log();
    console.log(`${color.bold}${color.cyan}  Cowale AI Kit${color.reset} ${color.dim}v${PACKAGE_VERSION}${color.reset}`);
    console.log();
  }

  // Check if .agent already exists
  if (fs.existsSync(agentDest) && !force) {
    log.warn(`${AGENT_DIR}/ already exists at ${targetPath}`);
    log.step("Use --force to overwrite existing installation");
    process.exit(1);
  }

  if (dryRun) {
    log.info("Dry run mode — no files will be written");
    log.step(`Would download from: ${GITHUB_OWNER}/${GITHUB_REPO} (branch: ${branch})`);
    log.step(`Would install to: ${agentDest}`);
    if (fs.existsSync(agentDest)) {
      log.step("Would overwrite existing .agent/ folder");
    }
    return;
  }

  // Remove existing if force
  if (fs.existsSync(agentDest) && force) {
    if (!quiet) log.info("Removing existing .agent/ folder...");
    fs.rmSync(agentDest, { recursive: true, force: true });
  }

  const tarballUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/tarball/${branch}`;

  if (!quiet) log.info(`Downloading from ${GITHUB_OWNER}/${GITHUB_REPO} (branch: ${branch})...`);

  try {
    await downloadAndExtract(tarballUrl, targetPath, branch);
  } catch (err) {
    log.error(`Download failed: ${err.message}`);
    log.step("Make sure the repository exists and is public");
    log.step(`URL: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`);
    process.exit(1);
  }

  if (!quiet) {
    const counts = countContents(agentDest);
    console.log();
    log.success("Installation complete!");
    console.log();
    log.step(`📁 ${color.bold}${counts.agents}${color.reset}${color.dim} agents`);
    log.step(`📦 ${color.bold}${counts.skills}${color.reset}${color.dim} skills`);
    log.step(`⚡ ${color.bold}${counts.workflows}${color.reset}${color.dim} workflows`);
    console.log();
    log.step(`Installed to: ${agentDest}`);
    console.log();
  }
}

async function cmdUpdate(flags) {
  const targetPath = path.resolve(flags.path || ".");
  const agentDest = path.join(targetPath, AGENT_DIR);

  if (!fs.existsSync(agentDest)) {
    log.warn("No .agent/ folder found. Run 'init' first.");
    process.exit(1);
  }

  console.log();
  console.log(`${color.bold}${color.cyan}  Cowale AI Kit${color.reset} ${color.dim}Update${color.reset}`);
  console.log();

  log.info("Updating .agent/ folder...");

  // Force overwrite
  flags.force = true;
  flags.quiet = true;
  await cmdInit(flags);

  const counts = countContents(agentDest);
  console.log();
  log.success("Update complete!");
  console.log();
  log.step(`📁 ${color.bold}${counts.agents}${color.reset}${color.dim} agents`);
  log.step(`📦 ${color.bold}${counts.skills}${color.reset}${color.dim} skills`);
  log.step(`⚡ ${color.bold}${counts.workflows}${color.reset}${color.dim} workflows`);
  console.log();
}

function cmdStatus(flags) {
  const targetPath = path.resolve(flags.path || ".");
  const agentDest = path.join(targetPath, AGENT_DIR);

  console.log();
  console.log(`${color.bold}${color.cyan}  Cowale AI Kit${color.reset} ${color.dim}Status${color.reset}`);
  console.log();

  if (!fs.existsSync(agentDest)) {
    log.warn("Not installed — .agent/ folder not found");
    log.step(`Run: npx ${PACKAGE_NAME} init`);
    console.log();
    return;
  }

  log.success("Installed");
  log.step(`Location: ${agentDest}`);

  const counts = countContents(agentDest);
  console.log();
  log.step(`📁 ${color.bold}${counts.agents}${color.reset}${color.dim} agents`);
  log.step(`📦 ${color.bold}${counts.skills}${color.reset}${color.dim} skills`);
  log.step(`⚡ ${color.bold}${counts.workflows}${color.reset}${color.dim} workflows`);
  console.log();

  // Check if GEMINI.md exists
  const geminiPath = path.join(targetPath, "GEMINI.md");
  if (fs.existsSync(geminiPath)) {
    log.step(`📄 GEMINI.md found at project root`);
  } else {
    log.step(`${color.yellow}📄 GEMINI.md not found at project root${color.reset}`);
  }
  console.log();
}

function showHelp() {
  console.log(`
${color.bold}${color.cyan}  Cowale AI Kit${color.reset} ${color.dim}v${PACKAGE_VERSION}${color.reset}

  AI Agent templates — Skills, Agents, and Workflows

${color.bold}Usage:${color.reset}
  npx ${PACKAGE_NAME} <command> [options]

${color.bold}Commands:${color.reset}
  init          Install .agent/ folder into your project
  update        Update to the latest version from GitHub
  status        Check installation status

${color.bold}Options:${color.reset}
  --force       Overwrite existing .agent/ folder
  --path=<dir>  Install in a specific directory (default: .)
  --branch=<b>  Use a specific branch (default: ${DEFAULT_BRANCH})
  --quiet       Suppress output
  --dry-run     Preview actions without executing
  --help, -h    Show this help message

${color.bold}Examples:${color.reset}
  ${color.dim}npx ${PACKAGE_NAME} init${color.reset}
  ${color.dim}npx ${PACKAGE_NAME} init --force${color.reset}
  ${color.dim}npx ${PACKAGE_NAME} init --path=./myproject${color.reset}
  ${color.dim}npx ${PACKAGE_NAME} update${color.reset}
  ${color.dim}npx ${PACKAGE_NAME} status${color.reset}
`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { commands, flags } = parseArgs(process.argv.slice(2));
  const command = commands[0];

  if (flags.help || flags.h || !command) {
    showHelp();
    return;
  }

  switch (command) {
    case "init":
      await cmdInit(flags);
      break;
    case "update":
      await cmdUpdate(flags);
      break;
    case "status":
      cmdStatus(flags);
      break;
    default:
      log.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
