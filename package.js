const childProcess = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const LBUG_ROOT = path.resolve(path.join(__dirname, "..", ".."));
const CURRENT_DIR = path.resolve(__dirname);
const ARCHIVE_PATH = path.resolve(path.join(__dirname, "lbug-source.tar"));
const PREBUILT_DIR = path.join(CURRENT_DIR, "prebuilt");
const ARCHIVE_DIR_PATH = path.join(CURRENT_DIR, "package");
const LBUG_VERSION_TEXT = "Lbug VERSION";

// Maps a prebuilt .node filename to its npm os/cpu values.
const PLATFORM_MAP = {
  "lbugjs-linux-x64.node":    { os: "linux",  cpu: "x64"   },
  "lbugjs-linux-arm64.node":  { os: "linux",  cpu: "arm64" },
  "lbugjs-darwin-arm64.node": { os: "darwin", cpu: "arm64" },
  "lbugjs-darwin-x64.node":   { os: "darwin", cpu: "x64"   },
  "lbugjs-win32-x64.node":    { os: "win32",  cpu: "x64"   },
};

(async () => {
  // Determine whether prebuilt binaries are available.  When they are present
  // we do NOT bundle the C++ source tree – the binaries plus the JS files are
  // sufficient for end-users and dramatically reduce package size.
  const prebuiltDirExists = await fs.access(PREBUILT_DIR).then(() => true, () => false);

  let prebuiltFiles = [];
  if (prebuiltDirExists) {
    const entries = await fs.readdir(PREBUILT_DIR);
    prebuiltFiles = entries.filter((f) => f.endsWith(".node"));
    console.log(`Found ${prebuiltFiles.length} prebuilt binary file(s): ${prebuiltFiles.join(", ")}`);
  }

  const hasPrebuilt = prebuiltFiles.length > 0;

  // Read the base package.json
  const packageJson = JSON.parse(
    await fs.readFile(path.join(CURRENT_DIR, "package.json"), { encoding: "utf-8" })
  );

  // Resolve version from CMakeLists.txt
  const CMakeListsTxt = await fs.readFile(
    path.join(LBUG_ROOT, "CMakeLists.txt"),
    { encoding: "utf-8" }
  );
  let version = packageJson.version;
  for (const line of CMakeListsTxt.split("\n")) {
    if (line.includes(LBUG_VERSION_TEXT)) {
      const versionSplit = line.split(" ")[2].trim().split(".");
      version = versionSplit.slice(0, 3).join(".");
      if (versionSplit.length >= 4) {
        version += "-dev." + versionSplit.slice(3).join(".");
      }
      console.log("Found version string from CMakeLists.txt: " + version);
      break;
    }
  }

  // -----------------------------------------------------------------------
  // Helper: read src_js files list
  // -----------------------------------------------------------------------
  const JS_SRC_DIR = path.join(CURRENT_DIR, "src_js");
  const jsEntries = await fs.readdir(JS_SRC_DIR);
  const jsFiles = jsEntries.filter(
    (f) => f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".d.ts")
  );

  // -----------------------------------------------------------------------
  // Build the main package tarball (lbug-source.tar.gz)
  // -----------------------------------------------------------------------
  console.log("\n--- Building main package ---");

  // Remove stale package directory
  try { await fs.rm(ARCHIVE_DIR_PATH, { recursive: true }); } catch (e) { /* ignore */ }
  await fs.mkdir(ARCHIVE_DIR_PATH);

  if (!hasPrebuilt) {
    // No prebuilt binaries: bundle the full C++ source so install.js can
    // compile on unsupported platforms.
    console.log("No prebuilt binaries – bundling C++ source for build-from-source.");

    await new Promise((resolve, reject) => {
      childProcess.execFile(
        "git",
        ["archive", "--format=tar", "--output=" + ARCHIVE_PATH, "HEAD"],
        { cwd: LBUG_ROOT },
        (err) => (err ? reject(err) : resolve())
      );
    });

    await fs.mkdir(path.join(CURRENT_DIR, "lbug-source"));
    await new Promise((resolve, reject) => {
      childProcess.execFile(
        "tar",
        ["-xf", ARCHIVE_PATH, "-C", "lbug-source"],
        { cwd: CURRENT_DIR },
        (err) => (err ? reject(err) : resolve())
      );
    });
    await fs.rm(ARCHIVE_PATH);

    // git archive does not include submodule contents; copy nodejs_api into
    // the extracted source tree so install.js can find it at build time.
    const NODEJS_API_STAGING = path.join(LBUG_ROOT, "nodejs_api_staging");
    try { await fs.rm(NODEJS_API_STAGING, { recursive: true }); } catch (e) { /* ignore */ }
    await fs.cp(CURRENT_DIR, NODEJS_API_STAGING, { recursive: true });
    await fs.rename(
      NODEJS_API_STAGING,
      path.join(CURRENT_DIR, "lbug-source", "tools", "nodejs_api")
    );

    await fs.rename(
      path.join(CURRENT_DIR, "lbug-source"),
      path.join(ARCHIVE_DIR_PATH, "lbug-source")
    );
  } else {
    // Prebuilt binaries present: copy JS files directly into package root.
    // The native binary is supplied at install time from an optional
    // platform-specific sub-package (see below), so no prebuilt/ dir here.
    console.log("Prebuilt binaries found – copying JS files only (no C++ source).");
    for (const file of jsFiles) {
      await fs.copyFile(
        path.join(JS_SRC_DIR, file),
        path.join(ARCHIVE_DIR_PATH, file)
      );
    }
    console.log(`Copied ${jsFiles.length} JS file(s).`);
  }

  // Shared files
  await fs.copyFile(path.join(CURRENT_DIR, "package.json"), path.join(ARCHIVE_DIR_PATH, "package.json"));
  await fs.copyFile(path.join(CURRENT_DIR, "install.js"),   path.join(ARCHIVE_DIR_PATH, "install.js"));
  await fs.copyFile(path.join(LBUG_ROOT, "LICENSE"),        path.join(ARCHIVE_DIR_PATH, "LICENSE"));
  await fs.copyFile(path.join(LBUG_ROOT, "README.md"),      path.join(ARCHIVE_DIR_PATH, "README.md"));

  // Write updated package.json
  const mainPkg = { ...packageJson, version };
  mainPkg.scripts = { ...mainPkg.scripts, install: "node install.js" };

  if (hasPrebuilt) {
    // Declare platform-specific packages as optionalDependencies so npm
    // downloads only the binary for the user's platform.
    mainPkg.optionalDependencies = {};
    for (const file of prebuiltFiles) {
      const info = PLATFORM_MAP[file];
      if (!info) {
        console.warn(`Unknown binary filename ${file}; skipping optionalDependency entry.`);
        continue;
      }
      const subName = `${packageJson.name}-${info.os}-${info.cpu}`;
      mainPkg.optionalDependencies[subName] = version;
    }
  }

  await fs.writeFile(
    path.join(ARCHIVE_DIR_PATH, "package.json"),
    JSON.stringify(mainPkg, null, 2)
  );

  // Create the main tarball
  console.log("Creating main tarball (lbug-source.tar.gz)...");
  await new Promise((resolve, reject) => {
    childProcess.execFile(
      "tar", ["-czf", "lbug-source.tar.gz", "package"],
      { cwd: CURRENT_DIR },
      (err) => (err ? reject(err) : resolve())
    );
  });
  await fs.rm(ARCHIVE_DIR_PATH, { recursive: true });

  // -----------------------------------------------------------------------
  // Build per-platform sub-package tarballs (when prebuilt binaries present)
  // -----------------------------------------------------------------------
  if (hasPrebuilt) {
    for (const file of prebuiltFiles) {
      const info = PLATFORM_MAP[file];
      if (!info) continue;

      const subName = `${packageJson.name}-${info.os}-${info.cpu}`;
      const tarName  = `lbug-${info.os}-${info.cpu}.tar.gz`;
      console.log(`\n--- Building sub-package ${subName} (${tarName}) ---`);

      // Remove stale package dir
      try { await fs.rm(ARCHIVE_DIR_PATH, { recursive: true }); } catch (e) { /* ignore */ }
      await fs.mkdir(ARCHIVE_DIR_PATH);

      // Copy JS files
      for (const jsFile of jsFiles) {
        await fs.copyFile(
          path.join(JS_SRC_DIR, jsFile),
          path.join(ARCHIVE_DIR_PATH, jsFile)
        );
      }

      // Copy the binary as lbugjs.node (the name install.js expects)
      await fs.copyFile(
        path.join(PREBUILT_DIR, file),
        path.join(ARCHIVE_DIR_PATH, "lbugjs.node")
      );

      // Copy shared files
      await fs.copyFile(path.join(LBUG_ROOT, "LICENSE"),   path.join(ARCHIVE_DIR_PATH, "LICENSE"));
      await fs.copyFile(path.join(LBUG_ROOT, "README.md"), path.join(ARCHIVE_DIR_PATH, "README.md"));

      // Write sub-package package.json
      const subPkg = {
        name: subName,
        version,
        description: mainPkg.description,
        os:  [info.os],
        cpu: [info.cpu],
        license: mainPkg.license,
        repository: mainPkg.repository,
        files: [...jsFiles, "lbugjs.node", "LICENSE", "README.md"],
      };
      await fs.writeFile(
        path.join(ARCHIVE_DIR_PATH, "package.json"),
        JSON.stringify(subPkg, null, 2)
      );

      // Create tarball
      await new Promise((resolve, reject) => {
        childProcess.execFile(
          "tar", ["-czf", tarName, "package"],
          { cwd: CURRENT_DIR },
          (err) => (err ? reject(err) : resolve())
        );
      });
      await fs.rm(ARCHIVE_DIR_PATH, { recursive: true });
      console.log(`Created ${tarName}.`);
    }
  }

  console.log("\nDone!");
})();
