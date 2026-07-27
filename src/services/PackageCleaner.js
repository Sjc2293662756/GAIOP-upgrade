const fs = require('fs');

function cleanupSuccessfulPackage(finalTask, packagePath, unlink = fs.unlinkSync) {
  if (!finalTask || finalTask.status !== 'success') return false;
  try {
    unlink(packagePath);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { cleanupSuccessfulPackage };
