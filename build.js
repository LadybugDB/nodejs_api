const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

const THREADS = os.cpus().length;
const DEFAULT_LBUG_SOURCE_DIR = path.resolve(__dirname, "../ladybug");

function resolveExistingPath(candidate) {
  if (!candidate) {
    return null;
  }
  const resolved = path.resolve(candidate);
  return fs.existsSync(resolved) ? resolved : null;
}

function getDefaultBuildDir(lbugSourceDir) {
  return lbugSourceDir ? path.join(lbugSourceDir, "build", "release") : null;
}

function getDefaultPrecompiledLibPath(lbugBuildDir) {
  if (!lbugBuildDir) {
    return null;
  }
  const candidates = process.platform === "win32"
    ? [
        path.join(lbugBuildDir, "src", "Release", "lbug.lib"),
        path.join(lbugBuildDir, "src", "lbug.lib"),
        path.join(lbugBuildDir, "src", "Release", "liblbug.lib"),
        path.join(lbugBuildDir, "src", "liblbug.lib"),
      ]
    : [path.join(lbugBuildDir, "src", "liblbug.a")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getDefaultExtraLinkLibs(lbugBuildDir, precompiledLibPath) {
  if (!lbugBuildDir || !precompiledLibPath) {
    return [];
  }

  const linkTxtCandidates = [
    path.join(lbugBuildDir, "tools", "python_api", "CMakeFiles", "_lbug.dir", "link.txt"),
    path.join(lbugBuildDir, "src", "CMakeFiles", "lbug_shared.dir", "link.txt"),
  ];
  const tokenPattern = /"[^"]+"|\S+/g;

  for (const linkTxtPath of linkTxtCandidates) {
    if (!fs.existsSync(linkTxtPath)) {
      continue;
    }
    const linkTxtDir = path.dirname(linkTxtPath);
    const linkBaseDir = linkTxtPath.includes(`${path.sep}tools${path.sep}python_api${path.sep}`)
      ? path.join(lbugBuildDir, "tools", "python_api")
      : linkTxtPath.includes(`${path.sep}src${path.sep}CMakeFiles${path.sep}`)
        ? path.join(lbugBuildDir, "src")
        : linkTxtDir;
    const tokens = fs.readFileSync(linkTxtPath, "utf8").match(tokenPattern) || [];
    const libs = [];
    let sawPrecompiledLib = false;

    for (const rawToken of tokens) {
      const token = rawToken.replace(/^"(.*)"$/, "$1");
      const resolvedToken = token.startsWith("-")
        ? token
        : fs.existsSync(path.resolve(linkBaseDir, token))
          ? path.resolve(linkBaseDir, token)
          : path.resolve(linkTxtDir, token);

      if (!sawPrecompiledLib) {
        if (resolvedToken === precompiledLibPath) {
          sawPrecompiledLib = true;
        }
        continue;
      }

      if (token.startsWith("-l")) {
        libs.push(token);
        continue;
      }
      if (!/\.(a|lib|dylib|so|tbd)$/.test(token)) {
        continue;
      }
      if (resolvedToken === precompiledLibPath) {
        continue;
      }
      libs.push(resolvedToken);
    }

    if (libs.length > 0) {
      return [...new Set(libs)];
    }
  }

  return [];
}

console.log(`Using ${THREADS} threads to build Lbug.`);

const env = { ...process.env };
const lbugSourceDir = resolveExistingPath(env.LBUG_SOURCE_DIR || DEFAULT_LBUG_SOURCE_DIR);
const lbugBuildDir = resolveExistingPath(env.LBUG_BUILD_DIR || getDefaultBuildDir(lbugSourceDir));
const precompiledLibPath = resolveExistingPath(
  env.LBUG_NODEJS_PRECOMPILED_LIB_PATH || getDefaultPrecompiledLibPath(lbugBuildDir)
);
const extraLinkLibs = getDefaultExtraLinkLibs(lbugBuildDir, precompiledLibPath);

if (lbugSourceDir) {
  env.LBUG_SOURCE_DIR = lbugSourceDir;
}
if (lbugBuildDir) {
  env.LBUG_BUILD_DIR = lbugBuildDir;
}

const cmakeArgs = env.EXTRA_CMAKE_FLAGS
  ? env.EXTRA_CMAKE_FLAGS.trim().split(/\s+/).filter(Boolean)
  : [];
if (lbugSourceDir) {
  cmakeArgs.push(`-DLBUG_SOURCE_DIR=${lbugSourceDir}`);
}
if (lbugBuildDir) {
  cmakeArgs.push(`-DLBUG_BUILD_DIR=${lbugBuildDir}`);
}
if (precompiledLibPath) {
  cmakeArgs.push(
    "-DBUILD_LBUG=FALSE",
    "-DBUILD_SHELL=FALSE",
    "-DLBUG_NODEJS_USE_PRECOMPILED_LIB=TRUE",
    `-DLBUG_NODEJS_PRECOMPILED_LIB_PATH=${precompiledLibPath}`
  );
  console.log(`Using precompiled liblbug from ${precompiledLibPath}.`);
}
if (extraLinkLibs.length > 0) {
  cmakeArgs.push(`-DLBUG_NODEJS_EXTRA_LINK_LIBS=${extraLinkLibs.join(";")}`);
}

execSync("npm run clean", { stdio: "inherit" });
execFileSync("cmake", ["-S", ".", "-B", "build", ...cmakeArgs], {
  cwd: __dirname,
  env,
  stdio: "inherit",
});
execFileSync("cmake", ["--build", "build", "-j", `${THREADS}`], {
  cwd: __dirname,
  env,
  stdio: "inherit",
});
