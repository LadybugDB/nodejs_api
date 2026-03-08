const childProcess = require("child_process");
const fs = require("fs/promises");
const fsCallback = require("fs");
const path = require("path");

const LBUG_ROOT = path.resolve(path.join(__dirname, "..", ".."));
const CURRENT_DIR = path.resolve(__dirname);
const ARCHIVE_PATH = path.resolve(path.join(__dirname, "lbug-source.tar"));
const PREBUILT_DIR = path.join(CURRENT_DIR, "prebuilt");
const ARCHIVE_DIR_PATH = path.join(CURRENT_DIR, "package");
const LBUG_VERSION_TEXT = "Lbug VERSION";

(async () => {
  console.log("Gathering Lbug source code...");
  // Create the git archive
  await new Promise((resolve, reject) => {
    childProcess.execFile(
      "git",
      ["archive", "--format=tar", "--output=" + ARCHIVE_PATH, "HEAD"],
      {
        cwd: LBUG_ROOT,
      },
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });

  // Remove the old lbug-source directory
  try {
    await fs.rm(path.join(CURRENT_DIR, "lbug-source"), { recursive: true });
  } catch (e) {
    // Ignore
  }

  // Create the lbug-source directory
  await fs.mkdir(path.join(CURRENT_DIR, "lbug-source"));

  // Extract the archive to lbug-source
  await new Promise((resolve, reject) => {
    childProcess.execFile(
      "tar",
      ["-xf", ARCHIVE_PATH, "-C", "lbug-source"],
      { cwd: CURRENT_DIR },
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });

  // Remove the archive
  await fs.rm(ARCHIVE_PATH);

  // git archive does not include submodule contents; copy nodejs_api into
  // the extracted source tree so install.js can find it at build time.
  // We must stage to a sibling temp dir first because fs.cp rejects copying a
  // directory into a subdirectory of itself, even with a filter.
  const NODEJS_API_STAGING = path.join(LBUG_ROOT, "nodejs_api_staging");
  try { await fs.rm(NODEJS_API_STAGING, { recursive: true }); } catch (e) { /* ignore */ }
  await fs.cp(CURRENT_DIR, NODEJS_API_STAGING, { recursive: true });
  await fs.rename(
    NODEJS_API_STAGING,
    path.join(CURRENT_DIR, "lbug-source", "tools", "nodejs_api")
  );

  // Remove the archive directory
  try {
    await fs.rm(ARCHIVE_DIR_PATH, { recursive: true });
  } catch (e) {
    // Ignore
  }

  // Create the archive directory
  await fs.mkdir(ARCHIVE_DIR_PATH);

  // Move lbug-source to archive
  await fs.rename(
    path.join(CURRENT_DIR, "lbug-source"),
    path.join(ARCHIVE_DIR_PATH, "lbug-source")
  );

  // Copy package.json to archive
  await fs.copyFile(
    path.join(CURRENT_DIR, "package.json"),
    path.join(ARCHIVE_DIR_PATH, "package.json")
  );

  // Copy install.js to archive
  await fs.copyFile(
    path.join(CURRENT_DIR, "install.js"),
    path.join(ARCHIVE_DIR_PATH, "install.js")
  );

  // Copy LICENSE to archive
  await fs.copyFile(
    path.join(LBUG_ROOT, "LICENSE"),
    path.join(ARCHIVE_DIR_PATH, "LICENSE")
  );

  // Copy README.md to archive
  await fs.copyFile(
    path.join(LBUG_ROOT, "README.md"),
    path.join(ARCHIVE_DIR_PATH, "README.md")
  );

  // If prebuilt directory exists, copy the entire directory to archive
  const prebuiltDirExists = await new Promise((resolve, _) => {
    fsCallback.access(PREBUILT_DIR, fsCallback.constants.F_OK, (err) => {
      if (err) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });

  if (prebuiltDirExists) {
    await fs.mkdir(path.join(ARCHIVE_DIR_PATH, "prebuilt"));
    console.log("Prebuilt directory exists, copying to archive...");
    const prebuiltFiles = await new Promise((resolve, _) => {
      fsCallback.readdir(PREBUILT_DIR, (err, files) => {
        if (err) {
          return resolve([]);
        }
        let prebuiltFiles = [];
        for (const file of files) {
          if (file.endsWith(".node")) {
            prebuiltFiles.push(file);
          }
        }
        resolve(prebuiltFiles);
      });
    });
    const copyPromises = [];
    for (const file of prebuiltFiles) {
      copyPromises.push(
        fs.copyFile(
          path.join(PREBUILT_DIR, file),
          path.join(ARCHIVE_DIR_PATH, "prebuilt", file)
        )
      );
    }
    await Promise.all(copyPromises);
    console.log(`Copied ${prebuiltFiles.length} files.`);
  } else {
    console.log("Prebuilt directory does not exist, skipping...");
  }

  console.log("Updating package.json...");

  const packageJson = JSON.parse(
    await fs.readFile(path.join(ARCHIVE_DIR_PATH, "package.json"), {
      encoding: "utf-8",
    })
  );

  const CMakeListsTxt = await fs.readFile(
    path.join(LBUG_ROOT, "CMakeLists.txt"),
    { encoding: "utf-8" }
  );

  // Get the version from CMakeLists.txt
  const lines = CMakeListsTxt.split("\n");
  for (const line of lines) {
    if (line.includes(LBUG_VERSION_TEXT)) {
      const versionSplit = line.split(" ")[2].trim().split(".");
      let version = versionSplit.slice(0, 3).join(".");
      if (versionSplit.length >= 4) {
        version += "-dev." + versionSplit.slice(3).join(".");
      }
      console.log("Found version string from CMakeLists.txt: " + version);
      packageJson.version = version;
      break;
    }
  }

  packageJson.scripts.install = "node install.js";

  await fs.writeFile(
    path.join(ARCHIVE_DIR_PATH, "package.json"),
    JSON.stringify(packageJson, null, 2)
  );

  console.log("Creating tarball...");
  // Create the tarball
  await new Promise((resolve, reject) => {
    childProcess.execFile(
      "tar",
      ["-czf", "lbug-source.tar.gz", "package"],
      { cwd: CURRENT_DIR },
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });

  // Remove the archive directory
  console.log("Cleaning up...");
  try {
    await fs.rm(ARCHIVE_DIR_PATH, { recursive: true });
  } catch (e) {
    // Ignore
  }

  console.log("Done!");
})();
