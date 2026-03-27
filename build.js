const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SRC_PATH = path.resolve(__dirname, "../..");
const THREADS = require("os").cpus().length;

console.log(`Using ${THREADS} threads to build Lbug.`);

const env = { ...process.env };
const precompiledLibPath = env.LBUG_NODEJS_PRECOMPILED_LIB_PATH;
if (precompiledLibPath) {
  const extraFlags = [
    env.EXTRA_CMAKE_FLAGS,
    "-DBUILD_LBUG=FALSE",
    "-DBUILD_SHELL=FALSE",
    "-DLBUG_NODEJS_USE_PRECOMPILED_LIB=TRUE",
    `-DLBUG_NODEJS_PRECOMPILED_LIB_PATH=${precompiledLibPath}`,
  ].filter(Boolean).join(" ");
  env.EXTRA_CMAKE_FLAGS = extraFlags;
  console.log(`Using precompiled liblbug from ${precompiledLibPath}.`);
}

execSync("npm run clean", { stdio: "inherit" });
execSync(`make nodejs NUM_THREADS=${THREADS}`, {
  cwd: SRC_PATH,
  env,
  stdio: "inherit",
});
